// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SwapExecutorBase} from "./base/SwapExecutorBase.sol";
import {IMorphoFlashLender, IMorphoFlashLoanCallback} from "./interfaces/IFlashLenders.sol";
import {IAaveV4Spoke, IAaveV4Giver, IAaveV4Taker} from "./interfaces/IAaveV4.sol";

/// @title LeverageExecutorV4
/// @notice Opens and closes a leveraged Aave v4 position in a single transaction, with the same swap engine as
/// LeverageExecutorV2 and LeverageExecutorMorpho (chains of 1 to 4 whitelisted router calls, each checked on its own).
///
/// Aave v4 has no flash loan and no credit delegation. The loan comes from Morpho Blue (free), and the contract acts
/// for the caller through Aave's own position managers: the Giver (supply, repay) and the Taker (borrow, withdraw,
/// each within an allowance the caller gave this contract for one reserve of one spoke).
///
/// Open (spoke S, collateral reserve C, debt reserve D):
///   pull the capital -> [swap it to C] -> Morpho flash loan of D -> swap D (+ capital if it was D) -> C -> supply
///   all C for the caller (Giver) -> borrow D for the caller (Taker; the spoke checks the health factor) -> give the
///   loan back -> leftovers back to the caller -> minimum health factor check.
/// Close: flash loan of D -> repay the caller's debt (Giver) -> withdraw C (Taker) -> swap C -> D -> give the loan
///   back -> leftovers back to the caller -> minimum health factor check.
///
/// Prerequisites for the caller, on the spoke:
///   once:  spoke.setUserPositionManager(GIVER, true) and (TAKER, true); spoke.setUsingAsCollateral(C, true, caller)
///   open:  capital.approve(executor, capitalAmount); TAKER.approveBorrow(S, D, executor, debtAmount) — or the
///          signed BorrowPermit of `openWithPermit`
///   close: TAKER.approveWithdraw(S, C, executor, amount) — or the signed WithdrawPermit of `closeWithPermit`
///   The `*WithPermit` variants renounce what is left of the allowance before returning: none outlives the call.
///
/// Security model (same as LeverageExecutorV2):
///   - the contract only ever acts for msg.sender: borrower, supplier and owner of the withdrawn collateral
///   - only spokes registered on both position managers are accepted
///   - the flash loan callback is accepted only from Morpho, for the exact token, amount and data this contract
///     recorded just before requesting it (one-shot)
///   - aggregator calls only go to routers whitelisted at deployment, never Morpho, a position manager or one of
///     the tokens of the operation; each step gets an exact approval reset to 0 afterwards, may not spend more than
///     approved, and its output is checked as a balance delta against its own minimum
///   - the contract keeps no funds and no allowances between transactions: every balance it gained during a call
///     goes back to the caller
///   - no owner, no admin function, no proxy: Morpho, the position managers and the routers are fixed at deployment
contract LeverageExecutorV4 is IMorphoFlashLoanCallback, ReentrancyGuard, SwapExecutorBase {
    using SafeERC20 for IERC20;

    /// @notice Morpho Blue, the free flash lender.
    IMorphoFlashLender public immutable MORPHO;
    /// @notice Aave v4 GiverPositionManager of the spokes this contract serves.
    IAaveV4Giver public immutable GIVER;
    /// @notice Aave v4 TakerPositionManager of the spokes this contract serves.
    IAaveV4Taker public immutable TAKER;

    /// @dev hash of the flash loan this contract is waiting for, 0 when none
    bytes32 private _pendingFlash;
    /// @dev amounts computed inside the flash loan callback, read back by the entry function
    uint256[2] private _out;

    enum Action {
        Open,
        Close
    }

    /// @param minHealthFactor the call reverts if the caller's health factor on the spoke ends below it (1e18 = 1.00;
    ///                        0 = no check)
    /// @param deadline        the call reverts after this timestamp
    struct Guard {
        uint256 minHealthFactor;
        uint256 deadline;
    }

    /// @param spoke         the Aave v4 spoke holding the position
    /// @param collateralId  reserve id of the collateral in the spoke
    /// @param debtId        reserve id of the borrowed asset in the spoke
    /// @param capitalToken  token pulled from the caller (ignored when capitalAmount is 0)
    /// @param capitalAmount amount pulled; 0 levers an existing position
    /// @param capitalSteps  capital -> collateral; empty when the capital is the collateral or the debt asset
    /// @param debtAmount    debt opened and sold; 0 for a plain deposit of the capital
    /// @param steps         debt asset (+ capital when it is the debt asset) -> collateral
    struct OpenParams {
        address spoke;
        uint256 collateralId;
        uint256 debtId;
        address capitalToken;
        uint256 capitalAmount;
        Step[] capitalSteps;
        uint256 debtAmount;
        Step[] steps;
        Guard guard;
    }

    /// @param repayAmount          debt to repay; type(uint256).max (or more than the debt) repays the whole debt
    /// @param collateralToWithdraw collateral to withdraw; type(uint256).max withdraws everything
    /// @param collateralToSell     collateral sold for the debt asset by `steps` (0 = no swap, steps empty)
    struct CloseParams {
        address spoke;
        uint256 collateralId;
        uint256 debtId;
        uint256 repayAmount;
        uint256 collateralToWithdraw;
        uint256 collateralToSell;
        Step[] steps;
        Guard guard;
    }

    /// @notice A BorrowPermit (open) or WithdrawPermit (close) signed by the caller for the Taker, with this contract
    /// as spender, on the spoke and reserve of the operation.
    struct Permit {
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    struct CloseResult {
        uint256 debtRepaid;
        uint256 collateralWithdrawn;
        uint256 collateralReturned;
        uint256 debtAssetReturned;
        uint256 healthFactor;
    }

    event PositionOpened(
        address indexed user,
        address indexed spoke,
        uint256 collateralId,
        uint256 debtId,
        address capitalToken,
        uint256 capitalAmount,
        uint256 collateralSupplied,
        uint256 debtBorrowed,
        uint256 healthFactor
    );
    event PositionClosed(
        address indexed user, address indexed spoke, uint256 collateralId, uint256 debtId, CloseResult result
    );

    error ZeroAmount();
    error SpokeNotRegistered(address spoke);
    error CollateralNotEnabled(uint256 reserveId);
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);
    error CallerNotLender();
    error UnexpectedFlashLoan();
    error FlashLoanNotExecuted();
    error UnexpectedSteps();
    error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn);
    error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed);

    constructor(IMorphoFlashLender morpho, IAaveV4Giver giver, IAaveV4Taker taker, address[] memory routers) {
        if (address(morpho).code.length == 0 || address(giver).code.length == 0 || address(taker).code.length == 0) {
            revert ZeroAddress();
        }
        MORPHO = morpho;
        GIVER = giver;
        TAKER = taker;
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            // an EOA would make every swap a no-op call; Morpho, the position managers and this contract must never
            // be targets (a call to the Taker from here would spend the allowances callers gave this contract)
            if (
                router == address(morpho) || router == address(giver) || router == address(taker)
                    || router == address(this) || router.code.length == 0
            ) revert InvalidRouter(router);
            _allowRouter(router);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------------------------------

    function open(OpenParams calldata p)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 hf)
    {
        return _open(p);
    }

    /// @notice Same as `open`, with the borrow allowance given by `permit` (a BorrowPermit for `p.debtId`) and
    /// renounced before returning.
    function openWithPermit(OpenParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 hf)
    {
        // a front-run of the signature only makes this call fail; the allowance is then already in place
        try TAKER.approveBorrowWithSig(
            IAaveV4Taker.BorrowPermit({
                spoke: p.spoke,
                reserveId: p.debtId,
                owner: msg.sender,
                spender: address(this),
                amount: permit.amount,
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            permit.signature
        ) {}
            catch {}
        (collateralSupplied, debtBorrowed, hf) = _open(p);
        TAKER.renounceBorrowAllowance(p.spoke, p.debtId, msg.sender);
    }

    function close(CloseParams calldata p) external nonReentrant returns (CloseResult memory) {
        return _close(p);
    }

    /// @notice Same as `close`, with the withdraw allowance given by `permit` (a WithdrawPermit for
    /// `p.collateralId`) and renounced before returning.
    function closeWithPermit(CloseParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (CloseResult memory r)
    {
        try TAKER.approveWithdrawWithSig(
            IAaveV4Taker.WithdrawPermit({
                spoke: p.spoke,
                reserveId: p.collateralId,
                owner: msg.sender,
                spender: address(this),
                amount: permit.amount,
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            permit.signature
        ) {}
            catch {}
        r = _close(p);
        TAKER.renounceWithdrawAllowance(p.spoke, p.collateralId, msg.sender);
    }

    /// @notice Health factor of `user` on a spoke, as the minimum health factor check reads it
    /// (type(uint256).max without debt).
    function healthFactor(address spoke, address user) external view returns (uint256) {
        return IAaveV4Spoke(spoke).getUserAccountData(user).healthFactor;
    }

    // ---------------------------------------------------------------------------------------------
    // Open / increase
    // ---------------------------------------------------------------------------------------------

    function _open(OpenParams calldata cp) internal returns (uint256 supplied, uint256 borrowed, uint256 hf) {
        OpenParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        (address collateral, address debt) = _pair(p.spoke, p.collateralId, p.debtId);
        if (p.capitalAmount == 0 && p.debtAmount == 0) revert ZeroAmount();
        if (p.debtAmount != 0) {
            // supplying does not make a reserve a collateral on Aave v4: without it the borrow below would fail on
            // the spoke's health check with a less readable error
            (bool enabled,) = IAaveV4Spoke(p.spoke).getUserReserveStatus(p.collateralId, msg.sender);
            if (!enabled) revert CollateralNotEnabled(p.collateralId);
        }

        address[] memory tokens = _openTokens(p, collateral, debt);
        uint256[] memory before = _balances(tokens);

        // capital -> collateral (or debt asset, sold together with the borrowed amount)
        uint256 collateralFromCapital;
        uint256 debtFromCapital;
        if (p.capitalAmount != 0) {
            IERC20(p.capitalToken).safeTransferFrom(msg.sender, address(this), p.capitalAmount);
            if (p.capitalToken == collateral || p.capitalToken == debt) {
                if (p.capitalSteps.length != 0) revert UnexpectedSteps();
                if (p.capitalToken == collateral) collateralFromCapital = p.capitalAmount;
                else debtFromCapital = p.capitalAmount;
            } else {
                collateralFromCapital =
                    _swapChain(msg.sender, p.capitalToken, p.capitalAmount, p.capitalSteps, collateral, tokens);
            }
        } else if (p.capitalSteps.length != 0) {
            revert UnexpectedSteps();
        }

        if (p.debtAmount != 0) {
            _flash(
                debt,
                p.debtAmount,
                abi.encode(Action.Open, msg.sender, abi.encode(p, collateralFromCapital, debtFromCapital))
            );
            supplied = _out[0];
            delete _out;
        } else {
            supplied =
                _supplyLevered(msg.sender, p, collateral, debt, 0, collateralFromCapital, debtFromCapital, tokens);
        }
        borrowed = p.debtAmount;

        _sweep(tokens, before, msg.sender);
        hf = _checkHealth(p.spoke, msg.sender, p.guard.minHealthFactor);
        _emitOpened(p, supplied, hf);
    }

    function _emitOpened(OpenParams memory p, uint256 supplied, uint256 hf) private {
        emit PositionOpened(
            msg.sender, p.spoke, p.collateralId, p.debtId, p.capitalToken, p.capitalAmount, supplied, p.debtAmount, hf
        );
    }

    /// @dev sells `borrowed` + the capital given in debt asset for collateral and supplies everything for `user`
    function _supplyLevered(
        address user,
        OpenParams memory p,
        address collateral,
        address debt,
        uint256 borrowed,
        uint256 collateralFromCapital,
        uint256 debtFromCapital,
        address[] memory tokens
    ) internal returns (uint256 supplied) {
        uint256 toSell = borrowed + debtFromCapital;
        uint256 received;
        if (toSell != 0) {
            received = _swapChain(user, debt, toSell, p.steps, collateral, tokens);
        } else if (p.steps.length != 0) {
            revert UnexpectedSteps();
        }
        supplied = collateralFromCapital + received;
        if (supplied == 0) revert ZeroAmount();
        IERC20(collateral).forceApprove(address(GIVER), supplied);
        GIVER.supplyOnBehalfOf(p.spoke, p.collateralId, supplied, user);
        IERC20(collateral).forceApprove(address(GIVER), 0);
    }

    function _executeOpen(address user, uint256 amount, bytes memory inner) internal returns (uint256 owed) {
        (OpenParams memory p, uint256 collateralFromCapital, uint256 debtFromCapital) =
            abi.decode(inner, (OpenParams, uint256, uint256));
        (address collateral, address debt) = _pair(p.spoke, p.collateralId, p.debtId);
        address[] memory tokens = _openTokens(p, collateral, debt);
        _out[0] = _supplyLevered(user, p, collateral, debt, amount, collateralFromCapital, debtFromCapital, tokens);
        // the debt is opened only now, against the collateral just supplied; the spoke checks the health factor and
        // the Taker the caller's allowance
        TAKER.borrowOnBehalfOf(p.spoke, p.debtId, amount, user);
        owed = amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Close / deleverage
    // ---------------------------------------------------------------------------------------------

    function _close(CloseParams calldata cp) internal returns (CloseResult memory r) {
        CloseParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        (address collateral, address debt) = _pair(p.spoke, p.collateralId, p.debtId);

        // the Giver repays at most the debt: borrowing exactly what will be repaid leaves no dust either way
        uint256 owedByUser = IAaveV4Spoke(p.spoke).getUserTotalDebt(p.debtId, msg.sender);
        uint256 flashAmount = p.repayAmount < owedByUser ? p.repayAmount : owedByUser;

        address[] memory tokens = _pairTokens(collateral, debt, p.steps);
        uint256[] memory before = _balances(tokens);

        if (flashAmount != 0) {
            _flash(debt, flashAmount, abi.encode(Action.Close, msg.sender, abi.encode(p)));
        } else {
            // no debt left (e.g. after a liquidation): only withdraw and sell
            _executeClose(msg.sender, 0, p);
        }
        r.debtRepaid = _out[0];
        r.collateralWithdrawn = _out[1];
        delete _out;

        uint256[] memory sent = _sweep(tokens, before, msg.sender);
        r.collateralReturned = sent[0];
        r.debtAssetReturned = sent[1];
        r.healthFactor = _checkHealth(p.spoke, msg.sender, p.guard.minHealthFactor);
        emit PositionClosed(msg.sender, p.spoke, p.collateralId, p.debtId, r);
    }

    function _executeClose(address user, uint256 flashAmount, CloseParams memory p) internal returns (uint256 owed) {
        (address collateral, address debt) = _pair(p.spoke, p.collateralId, p.debtId);
        address[] memory tokens = _pairTokens(collateral, debt, p.steps);

        // 1. repay the user's debt with the borrowed funds
        uint256 repaid;
        if (flashAmount != 0) {
            IERC20(debt).forceApprove(address(GIVER), flashAmount);
            (, repaid) = GIVER.repayOnBehalfOf(p.spoke, p.debtId, flashAmount, user);
            IERC20(debt).forceApprove(address(GIVER), 0);
        }

        // 2. withdraw the collateral (the spoke checks the position stays healthy, the Taker the allowance)
        uint256 toWithdraw = p.collateralToWithdraw;
        if (toWithdraw == type(uint256).max) {
            toWithdraw = IAaveV4Spoke(p.spoke).getUserSuppliedAssets(p.collateralId, user);
        }
        uint256 withdrawn;
        if (toWithdraw != 0) (, withdrawn) = TAKER.withdrawOnBehalfOf(p.spoke, p.collateralId, toWithdraw, user);

        // 3. sell collateral for the debt asset
        if (p.collateralToSell > withdrawn) revert SellExceedsWithdrawn(p.collateralToSell, withdrawn);
        if (p.collateralToSell != 0) {
            _swapChain(user, collateral, p.collateralToSell, p.steps, debt, tokens);
        } else if (p.steps.length != 0) {
            revert UnexpectedSteps();
        }

        // 4. the loan must be covered
        owed = flashAmount;
        uint256 bal = IERC20(debt).balanceOf(address(this));
        if (bal < owed) revert InsufficientToRepayFlashLoan(bal, owed);

        _out[0] = repaid;
        _out[1] = withdrawn;
    }

    // ---------------------------------------------------------------------------------------------
    // Spoke
    // ---------------------------------------------------------------------------------------------

    /// @dev The underlying tokens of the two reserves, on a spoke both position managers serve.
    function _pair(address spoke, uint256 collateralId, uint256 debtId)
        internal
        view
        returns (address collateral, address debt)
    {
        if (spoke.code.length == 0 || !GIVER.isSpokeRegistered(spoke) || !TAKER.isSpokeRegistered(spoke)) {
            revert SpokeNotRegistered(spoke);
        }
        collateral = IAaveV4Spoke(spoke).getReserve(collateralId).underlying;
        debt = IAaveV4Spoke(spoke).getReserve(debtId).underlying;
        if (collateral == debt) revert SameAsset();
    }

    function _checkHealth(address spoke, address user, uint256 minHealthFactor) internal view returns (uint256 hf) {
        hf = IAaveV4Spoke(spoke).getUserAccountData(user).healthFactor;
        if (hf < minHealthFactor) revert HealthFactorTooLow(hf, minHealthFactor);
    }

    // ---------------------------------------------------------------------------------------------
    // Flash loan
    // ---------------------------------------------------------------------------------------------

    function _flash(address token, uint256 amount, bytes memory data) internal {
        _pendingFlash = keccak256(abi.encode(token, amount, data));
        // Morpho's callback does not name the token: it travels with the data
        MORPHO.flashLoan(token, amount, abi.encode(token, data));
        if (_pendingFlash != bytes32(0)) revert FlashLoanNotExecuted();
    }

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != address(MORPHO)) revert CallerNotLender();
        (address token, bytes memory inner) = abi.decode(data, (address, bytes));
        bytes32 expected = _pendingFlash;
        if (expected == bytes32(0) || expected != keccak256(abi.encode(token, assets, inner))) {
            revert UnexpectedFlashLoan();
        }
        delete _pendingFlash;

        (Action action, address user, bytes memory params) = abi.decode(inner, (Action, address, bytes));
        uint256 owed;
        if (action == Action.Open) {
            owed = _executeOpen(user, assets, params);
        } else {
            owed = _executeClose(user, assets, abi.decode(params, (CloseParams)));
        }
        // Morpho pulls the loan back with transferFrom once this returns
        IERC20(token).forceApprove(msg.sender, owed);
    }

    // ---------------------------------------------------------------------------------------------
    // Token sets
    // ---------------------------------------------------------------------------------------------

    /// @dev Every token an open touches: index 0 collateral, 1 debt asset, then the capital and the step outputs.
    function _openTokens(OpenParams memory p, address collateral, address debt)
        internal
        pure
        returns (address[] memory tokens)
    {
        tokens = new address[](3 + p.capitalSteps.length + p.steps.length);
        uint256 n;
        n = _add(tokens, n, collateral);
        n = _add(tokens, n, debt);
        if (p.capitalAmount != 0) n = _add(tokens, n, p.capitalToken);
        for (uint256 i; i < p.capitalSteps.length; ++i) {
            n = _add(tokens, n, p.capitalSteps[i].tokenOut);
        }
        for (uint256 i; i < p.steps.length; ++i) {
            n = _add(tokens, n, p.steps[i].tokenOut);
        }
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
    }

    /// @dev Index 0 `a`, 1 `b`, then the step outputs.
    function _pairTokens(address a, address b, Step[] memory steps) internal pure returns (address[] memory tokens) {
        tokens = new address[](2 + steps.length);
        uint256 n;
        n = _add(tokens, n, a);
        n = _add(tokens, n, b);
        for (uint256 i; i < steps.length; ++i) {
            n = _add(tokens, n, steps[i].tokenOut);
        }
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
    }
}
