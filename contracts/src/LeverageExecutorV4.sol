// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SwapExecutorBase} from "./base/SwapExecutorBase.sol";
import {IMorphoFlashLoanCallback} from "./interfaces/IFlashLenders.sol";
import {IMorpho, IMorphoOracle, MarketParams, Authorization, MorphoSignature} from "./interfaces/IMorpho.sol";
import {IAaveV3Pool, ICreditDelegationToken} from "./interfaces/IAaveV3.sol";
import {IAaveV4Spoke, IAaveV4Giver, IAaveV4Taker} from "./interfaces/IAaveV4.sol";

/// @title LeverageExecutorV4
/// @notice Opens, closes, reshapes and moves a leveraged Aave v4 position in a single transaction, with the same swap
/// engine as LeverageExecutorV2 and LeverageExecutorMorpho (chains of 1 to 4 whitelisted router calls, each checked on
/// its own).
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
/// Swap collateral (C1 -> C2 in the same spoke, debt unchanged): flash loan of C2 -> supply it (Giver) -> withdraw
///   C1 (Taker) -> swap C1 -> C2 -> give the loan back, supply the surplus -> minimum health factor check.
/// Swap debt (D1 -> D2 in the same spoke, collateral unchanged): flash loan of D2 -> swap D2 -> D1 -> repay D1
///   (Giver) -> borrow D2 (Taker) -> give the loan back -> leftover D1 back to the caller -> minimum health factor.
/// Refinance (same collateral and debt tokens, no swap, between this spoke and another place: another spoke served by
///   the same position managers, an Aave v3 pool fixed at deployment or a Morpho Blue market; one side is always an
///   Aave v4 spoke): flash loan of D -> repay the caller's debt at the source -> take the collateral out there ->
///   supply it at the target for the caller -> borrow there what was repaid -> give the loan back -> minimum health
///   factor where the position lands.
///
/// Prerequisites for the caller, on the spoke:
///   once:  spoke.setUserPositionManager(GIVER, true) and (TAKER, true); spoke.setUsingAsCollateral(C, true, caller)
///          (for a collateral swap or a refinance into a spoke: the reserve that receives the collateral)
///   open, swap debt, refinance into a spoke: TAKER.approveBorrow(S, D, executor, amount) on the reserve borrowed
///   close, swap collateral, refinance out of a spoke: TAKER.approveWithdraw(S, C, executor, amount)
///   refinance with Aave v3: aC.approve(executor, amount) out of it, credit delegation of D into it
///   refinance with Morpho: the executor authorized on Morpho
///   Each of these can be signed instead and handed to the `*WithPermit` / `refinanceWithAuth` variants, which
///   renounce what is left of the Taker allowances and revoke the Morpho authorization before returning.
///
/// Security model (same as LeverageExecutorV2):
///   - the contract only ever acts for msg.sender: borrower, supplier and owner of the withdrawn collateral
///   - only spokes registered on both position managers, and Aave v3 pools fixed at deployment, are accepted
///   - the flash loan callback is accepted only from Morpho, for the exact token, amount and data this contract
///     recorded just before requesting it (one-shot)
///   - aggregator calls only go to routers whitelisted at deployment, never Morpho, a position manager, an Aave v3
///     pool or one of its tokens, or one of the tokens of the operation; each step gets an exact approval reset to 0
///     afterwards, may not spend more than approved, and its output is checked as a balance delta against its own
///     minimum
///   - the contract keeps no funds and no allowances between transactions: every balance it gained during a call
///     goes back to the caller
///   - no owner, no admin function, no proxy: Morpho, the position managers, the pools and the routers are fixed at
///     deployment
contract LeverageExecutorV4 is IMorphoFlashLoanCallback, ReentrancyGuard, SwapExecutorBase {
    using SafeERC20 for IERC20;

    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant WAD = 1e18;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;
    uint256 private constant VARIABLE = 2;

    /// @notice Morpho Blue: the free flash lender, and a place a position can be refinanced to or from.
    IMorpho public immutable MORPHO;
    /// @notice Aave v4 GiverPositionManager of the spokes this contract serves.
    IAaveV4Giver public immutable GIVER;
    /// @notice Aave v4 TakerPositionManager of the spokes this contract serves.
    IAaveV4Taker public immutable TAKER;
    /// @notice Aave v3 pools a position can be refinanced from or to, fixed at deployment.
    mapping(address => bool) public isAavePool;

    /// @dev hash of the flash loan this contract is waiting for, 0 when none
    bytes32 private _pendingFlash;
    /// @dev amounts computed inside the flash loan callback, read back by the entry function
    uint256[2] private _out;

    enum Action {
        Open,
        Close,
        SwapCollateral,
        SwapDebt,
        Refinance
    }

    enum Venue {
        AaveV4,
        AaveV3,
        Morpho
    }

    /// @param minHealthFactor the call reverts if the caller's health factor ends below it (1e18 = 1.00; 0 = no check)
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

    /// @param fromId     collateral reserve withdrawn
    /// @param toId       collateral reserve supplied instead (enabled as collateral by the caller)
    /// @param fromAmount collateral withdrawn and sold; type(uint256).max withdraws everything
    /// @param toAmount   new collateral flash-borrowed and supplied first; the swap must give at least this back
    /// @param steps      old collateral -> new collateral, selling what was withdrawn
    struct SwapCollateralParams {
        address spoke;
        uint256 fromId;
        uint256 toId;
        uint256 fromAmount;
        uint256 toAmount;
        Step[] steps;
        Guard guard;
    }

    /// @param fromId        debt reserve repaid
    /// @param toId          debt reserve borrowed instead
    /// @param newDebtAmount new debt borrowed and sold for the old debt asset (the first step sells exactly this)
    /// @param minRepaid     the call reverts if less old debt is repaid; type(uint256).max = the caller's whole debt
    /// @param steps         new debt asset -> old debt asset
    struct SwapDebtParams {
        address spoke;
        uint256 fromId;
        uint256 toId;
        uint256 newDebtAmount;
        uint256 minRepaid;
        Step[] steps;
        Guard guard;
    }

    /// @notice Where a position lives. Aave v4: `target` is the spoke, with the collateral and debt reserve ids;
    /// Aave v3: `target` is the pool; Morpho: `market`. Unused fields are ignored.
    struct Place {
        Venue venue;
        address target;
        uint256 collateralId;
        uint256 debtId;
        MarketParams market;
    }

    /// @param debtAmount       debt moved; type(uint256).max moves the whole debt (by shares on Morpho)
    /// @param collateralAmount collateral moved; type(uint256).max moves all of it
    /// @param guard            minimum health factor where the position lands
    struct RefinanceParams {
        Place from;
        Place to;
        uint256 debtAmount;
        uint256 collateralAmount;
        Guard guard;
    }

    /// @notice A signed allowance. On an Aave v4 spoke: a BorrowPermit or WithdrawPermit of the Taker, with this
    /// contract as spender, on the spoke and reserve of the operation. On Aave v3 (refinance): an aToken permit (out of
    /// the pool) or a delegationWithSig of the variable debt token (into it), `nonce` unused, `signature` = r, s, v.
    /// An empty signature means none.
    struct Permit {
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /// @notice Signatures for Morpho's `setAuthorizationWithSig`: `grant` for nonce `nonce`, `revoke` for `nonce + 1`,
    /// both with authorizer = caller, authorized = this contract and `deadline` (0 = none given).
    struct AuthSigs {
        uint256 nonce;
        uint256 deadline;
        MorphoSignature grant;
        MorphoSignature revoke;
    }

    /// @param exit   allowance to take the collateral out of the source (Taker WithdrawPermit or aToken permit)
    /// @param enter  allowance to borrow at the target (Taker BorrowPermit or delegationWithSig)
    /// @param morpho authorization on Morpho, when one of the places is a Morpho market
    struct RefinanceAuth {
        Permit exit;
        Permit enter;
        AuthSigs morpho;
    }

    struct CloseResult {
        uint256 debtRepaid;
        uint256 collateralWithdrawn;
        uint256 collateralReturned;
        uint256 debtAssetReturned;
        uint256 healthFactor;
    }

    struct SwapCollateralResult {
        uint256 withdrawn;
        uint256 supplied;
        uint256 healthFactor;
    }

    struct SwapDebtResult {
        uint256 repaid;
        uint256 borrowed;
        uint256 returned;
        uint256 healthFactor;
    }

    struct RefinanceResult {
        uint256 debtMoved;
        uint256 collateralMoved;
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
    event CollateralSwapped(
        address indexed user, address indexed spoke, uint256 fromId, uint256 toId, SwapCollateralResult result
    );
    event DebtSwapped(address indexed user, address indexed spoke, uint256 fromId, uint256 toId, SwapDebtResult result);
    event Refinanced(address indexed user, Place from, Place to, RefinanceResult result);

    error ZeroAmount();
    error SpokeNotRegistered(address spoke);
    error PoolNotAllowed(address pool);
    error CollateralNotEnabled(uint256 reserveId);
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);
    error CallerNotLender();
    error UnexpectedFlashLoan();
    error FlashLoanNotExecuted();
    error UnexpectedSteps();
    error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn);
    error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed);
    error RepaidTooLittle(uint256 repaid, uint256 minRepaid);
    error NoAaveV4Side();
    error SamePlace();
    error TokenMismatch();
    error AuthorizationNotRevoked();

    constructor(
        IMorpho morpho,
        IAaveV4Giver giver,
        IAaveV4Taker taker,
        address[] memory routers,
        address[] memory aavePools
    ) {
        if (address(morpho).code.length == 0 || address(giver).code.length == 0 || address(taker).code.length == 0) {
            revert ZeroAddress();
        }
        MORPHO = morpho;
        GIVER = giver;
        TAKER = taker;
        for (uint256 i; i < aavePools.length; ++i) {
            if (aavePools[i].code.length == 0) revert ZeroAddress();
            isAavePool[aavePools[i]] = true;
        }
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            // an EOA would make every swap a no-op call; Morpho, the position managers, a pool and this contract must
            // never be targets (a call to the Taker or Morpho from here would use the allowances callers gave it)
            if (
                router == address(morpho) || router == address(giver) || router == address(taker)
                    || router == address(this) || router.code.length == 0 || isAavePool[router]
            ) revert InvalidRouter(router);
            for (uint256 j; j < aavePools.length; ++j) {
                if (_isAaveToken(IAaveV3Pool(aavePools[j]), router)) revert InvalidRouter(router);
            }
            _allowRouter(router);
        }
    }

    /// @dev true for an asset listed on `pool`, or one of its aTokens or variable debt tokens: a router call to one
    /// of them could spend the aToken allowances or credit delegations callers gave this contract for a refinance
    /// (same check as LeverageExecutorV2 and LeverageExecutorMorpho)
    function _isAaveToken(IAaveV3Pool pool, address router) private view returns (bool) {
        if (pool.getReserveData(router).aTokenAddress != address(0)) return true;
        (bool ok, bytes memory ret) = router.staticcall(abi.encodeWithSignature("UNDERLYING_ASSET_ADDRESS()"));
        if (!ok || ret.length != 32) return false;
        uint256 raw = abi.decode(ret, (uint256));
        if (raw > type(uint160).max) return false;
        // forge-lint: disable-next-line(unsafe-typecast)
        IAaveV3Pool.ReserveDataLegacy memory r = pool.getReserveData(address(uint160(raw)));
        return r.aTokenAddress == router || r.variableDebtTokenAddress == router;
    }

    // ---------------------------------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------------------------------

    // Each entry point takes the allowance it needs from the Taker either already in place (`permit` with an empty
    // signature) or signed in `permit`, which this contract relays first and renounces what is left of before
    // returning: an allowance given by signature never outlives the call.

    /// @param permit a BorrowPermit for `p.debtId`, or an empty signature
    function open(OpenParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 hf)
    {
        bool signed = _permitBorrow(p.spoke, p.debtId, permit);
        (collateralSupplied, debtBorrowed, hf) = _open(p);
        if (signed) TAKER.renounceBorrowAllowance(p.spoke, p.debtId, msg.sender);
    }

    /// @param permit a WithdrawPermit for `p.collateralId`, or an empty signature
    function close(CloseParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (CloseResult memory r)
    {
        bool signed = _permitWithdraw(p.spoke, p.collateralId, permit);
        r = _close(p);
        if (signed) TAKER.renounceWithdrawAllowance(p.spoke, p.collateralId, msg.sender);
    }

    /// @param permit a WithdrawPermit for `p.fromId` (the old collateral), or an empty signature
    function swapCollateral(SwapCollateralParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (SwapCollateralResult memory r)
    {
        bool signed = _permitWithdraw(p.spoke, p.fromId, permit);
        r = _swapCollateral(p);
        if (signed) TAKER.renounceWithdrawAllowance(p.spoke, p.fromId, msg.sender);
    }

    /// @param permit a BorrowPermit for `p.toId` (the new debt), or an empty signature
    function swapDebt(SwapDebtParams calldata p, Permit calldata permit)
        external
        nonReentrant
        returns (SwapDebtResult memory r)
    {
        bool signed = _permitBorrow(p.spoke, p.toId, permit);
        r = _swapDebt(p);
        if (signed) TAKER.renounceBorrowAllowance(p.spoke, p.toId, msg.sender);
    }

    /// @notice Moves the position (see `RefinanceParams`). Same rule for its allowances, given in `auth` (a Morpho
    /// deadline of 0 = authorization already in place); a Morpho authorization given by signature is revoked before
    /// returning, and the call reverts if this contract is still authorized on Morpho then.
    function refinance(RefinanceParams calldata p, RefinanceAuth calldata auth)
        external
        nonReentrant
        returns (RefinanceResult memory r)
    {
        (address collateral, address debt) = _refinanceTokens(p.from, p.to);
        bool exit = _permitExit(p.from, collateral, auth.exit);
        bool enter = _permitEnter(p.to, debt, auth.enter);
        bool morpho = auth.morpho.deadline != 0;
        if (morpho) _grant(auth.morpho);
        r = _refinance(p, collateral, debt);
        if (morpho) _revoke(auth.morpho);
        // aToken allowances and credit delegations given by signature on Aave v3 are spent exactly
        if (exit && p.from.venue == Venue.AaveV4) {
            TAKER.renounceWithdrawAllowance(p.from.target, p.from.collateralId, msg.sender);
        }
        if (enter && p.to.venue == Venue.AaveV4) TAKER.renounceBorrowAllowance(p.to.target, p.to.debtId, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Open / increase
    // ---------------------------------------------------------------------------------------------

    function _open(OpenParams calldata cp) internal returns (uint256 supplied, uint256 borrowed, uint256 hf) {
        OpenParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        (address collateral, address debt) = _pair(p.spoke, p.collateralId, p.debtId);
        if (p.capitalAmount == 0 && p.debtAmount == 0) revert ZeroAmount();
        // supplying does not make a reserve a collateral on Aave v4: without it the borrow below would fail on the
        // spoke's health check with a less readable error
        if (p.debtAmount != 0) _checkCollateral(p.spoke, p.collateralId, msg.sender);

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
        _supplyV4(p.spoke, p.collateralId, collateral, supplied, user);
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
        uint256 repaid = _repayV4(p.spoke, p.debtId, debt, flashAmount, user);

        // 2. withdraw the collateral (the spoke checks the position stays healthy, the Taker the allowance)
        uint256 withdrawn = _withdrawV4(p.spoke, p.collateralId, p.collateralToWithdraw, user);

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
    // Swap collateral (debt unchanged)
    // ---------------------------------------------------------------------------------------------

    function _swapCollateral(SwapCollateralParams calldata cp) internal returns (SwapCollateralResult memory r) {
        SwapCollateralParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        (address from, address to) = _pair(p.spoke, p.fromId, p.toId);
        if (p.fromAmount == 0 || p.toAmount == 0) revert ZeroAmount();
        _checkCollateral(p.spoke, p.toId, msg.sender);

        address[] memory tokens = _pairTokens(from, to, p.steps);
        uint256[] memory before = _balances(tokens);

        _flash(to, p.toAmount, abi.encode(Action.SwapCollateral, msg.sender, abi.encode(p)));
        r.withdrawn = _out[0];
        r.supplied = _out[1];
        delete _out;

        _sweep(tokens, before, msg.sender);
        r.healthFactor = _checkHealth(p.spoke, msg.sender, p.guard.minHealthFactor);
        emit CollateralSwapped(msg.sender, p.spoke, p.fromId, p.toId, r);
    }

    function _executeSwapCollateral(address user, uint256 amount, SwapCollateralParams memory p)
        internal
        returns (uint256 owed)
    {
        (address from, address to) = _pair(p.spoke, p.fromId, p.toId);
        address[] memory tokens = _pairTokens(from, to, p.steps);

        // 1. the new collateral goes in first, so that the old one can leave without breaking the health factor
        _supplyV4(p.spoke, p.toId, to, amount, user);
        // 2. take the old collateral out
        uint256 withdrawn = _withdrawV4(p.spoke, p.fromId, p.fromAmount, user);
        // 3. old -> new; the router may take less than withdrawn, the rest goes back to the user
        uint256 received = _swapChain(user, from, withdrawn, p.steps, to, tokens);
        // 4. the swap must cover the loan; any surplus is supplied for the user
        if (received < amount) revert InsufficientToRepayFlashLoan(received, amount);
        uint256 surplus = received - amount;
        if (surplus != 0) _supplyV4(p.spoke, p.toId, to, surplus, user);

        _out[0] = withdrawn;
        _out[1] = amount + surplus;
        owed = amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Swap debt (collateral unchanged)
    // ---------------------------------------------------------------------------------------------

    function _swapDebt(SwapDebtParams calldata cp) internal returns (SwapDebtResult memory r) {
        SwapDebtParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        (address from, address to) = _pair(p.spoke, p.fromId, p.toId);
        if (p.newDebtAmount == 0 || p.steps.length == 0) revert ZeroAmount();
        if (p.minRepaid == type(uint256).max) {
            p.minRepaid = IAaveV4Spoke(p.spoke).getUserTotalDebt(p.fromId, msg.sender);
        }
        if (p.minRepaid == 0) revert ZeroAmount();

        address[] memory tokens = _pairTokens(from, to, p.steps);
        uint256[] memory before = _balances(tokens);

        _flash(to, p.newDebtAmount, abi.encode(Action.SwapDebt, msg.sender, abi.encode(p)));
        r.repaid = _out[0];
        delete _out;
        r.borrowed = p.newDebtAmount;

        uint256[] memory sent = _sweep(tokens, before, msg.sender);
        r.returned = sent[0];
        r.healthFactor = _checkHealth(p.spoke, msg.sender, p.guard.minHealthFactor);
        emit DebtSwapped(msg.sender, p.spoke, p.fromId, p.toId, r);
    }

    function _executeSwapDebt(address user, uint256 amount, SwapDebtParams memory p) internal returns (uint256 owed) {
        (address from, address to) = _pair(p.spoke, p.fromId, p.toId);
        address[] memory tokens = _pairTokens(from, to, p.steps);
        // 1. new debt asset -> old one
        uint256 received = _swapChain(user, to, amount, p.steps, from, tokens);
        // 2. repay the old debt (the Giver takes at most the debt; the rest goes back to the user with the sweep)
        uint256 repaid = _repayV4(p.spoke, p.fromId, from, received, user);
        if (repaid < p.minRepaid) revert RepaidTooLittle(repaid, p.minRepaid);
        // 3. the new debt, against the same collateral (the spoke checks the health factor, the Taker the allowance)
        TAKER.borrowOnBehalfOf(p.spoke, p.toId, amount, user);
        _out[0] = repaid;
        owed = amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Refinance (Aave v4 spoke <-> another spoke, an Aave v3 pool or a Morpho market)
    // ---------------------------------------------------------------------------------------------

    function _refinance(RefinanceParams calldata cp, address collateral, address debt)
        internal
        returns (RefinanceResult memory r)
    {
        RefinanceParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.to.venue == Venue.AaveV4) _checkCollateral(p.to.target, p.to.collateralId, msg.sender);

        (uint256 flashAmount, uint256 repayShares) = _debtToMove(p.from, debt, msg.sender, p.debtAmount);
        if (flashAmount == 0) revert ZeroAmount();

        address[] memory tokens = new address[](3);
        uint256 n = _add(tokens, 0, collateral);
        n = _add(tokens, n, debt);
        // aTokens pulled out of an Aave v3 pool: what rounding leaves of them goes back too
        if (p.from.venue == Venue.AaveV3) n = _add(tokens, n, _aToken(p.from.target, collateral));
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
        uint256[] memory before = _balances(tokens);

        _flash(
            debt, flashAmount, abi.encode(Action.Refinance, msg.sender, abi.encode(p, collateral, debt, repayShares))
        );
        r.debtMoved = _out[0];
        r.collateralMoved = _out[1];
        delete _out;

        _sweep(tokens, before, msg.sender);
        r.healthFactor = _placeHealth(p.to, msg.sender);
        if (r.healthFactor < p.guard.minHealthFactor) {
            revert HealthFactorTooLow(r.healthFactor, p.guard.minHealthFactor);
        }
        emit Refinanced(msg.sender, p.from, p.to, r);
    }

    function _executeRefinance(address user, uint256 amount, bytes memory params) internal returns (uint256 owed) {
        (RefinanceParams memory p, address collateral, address debt, uint256 repayShares) =
            abi.decode(params, (RefinanceParams, address, address, uint256));
        // 1. repay at the source (it may take less: the rest goes back with the sweep), 2. take the collateral out
        // (the source checks what stays on a partial move)
        uint256 repaid = _exitRepay(p.from, debt, amount, repayShares, user);
        uint256 moved = _exitWithdraw(p.from, collateral, p.collateralAmount, user);
        if (moved == 0) revert ZeroAmount();
        // 3. supply it at the target, 4. borrow there what was repaid (the target checks the position)
        _enter(p.to, collateral, debt, moved, repaid, user);
        _out[0] = repaid;
        _out[1] = moved;
        owed = amount;
    }

    /// @dev The collateral and debt tokens of a move; one side must be an Aave v4 spoke, and both sides must hold the
    /// same two tokens.
    function _refinanceTokens(Place memory from, Place memory to)
        internal
        view
        returns (address collateral, address debt)
    {
        Place memory v4 = from.venue == Venue.AaveV4 ? from : to;
        if (v4.venue != Venue.AaveV4) revert NoAaveV4Side();
        (collateral, debt) = _pair(v4.target, v4.collateralId, v4.debtId);
        _checkPlace(from, collateral, debt);
        _checkPlace(to, collateral, debt);
        if (
            from.venue == to.venue && from.target == to.target && from.collateralId == to.collateralId
                && from.debtId == to.debtId
        ) revert SamePlace();
    }

    function _checkPlace(Place memory pl, address collateral, address debt) internal view {
        if (pl.venue == Venue.AaveV4) {
            (address c, address d) = _pair(pl.target, pl.collateralId, pl.debtId);
            if (c != collateral || d != debt) revert TokenMismatch();
        } else if (pl.venue == Venue.AaveV3) {
            if (!isAavePool[pl.target]) revert PoolNotAllowed(pl.target);
        } else if (pl.market.collateralToken != collateral || pl.market.loanToken != debt) {
            revert TokenMismatch();
        }
    }

    /// @dev Flash amount (and Morpho repay shares) to move `amount` of the user's debt out of `from`.
    function _debtToMove(Place memory from, address debt, address user, uint256 amount)
        internal
        returns (uint256 flashAmount, uint256 repayShares)
    {
        if (from.venue == Venue.Morpho) return _repayPlan(from.market, user, amount);
        uint256 owed = from.venue == Venue.AaveV4
            ? IAaveV4Spoke(from.target).getUserTotalDebt(from.debtId, user)
            // Aave v3 refuses type(uint256).max when repaying for someone else: the exact current debt
            : IERC20(IAaveV3Pool(from.target).getReserveData(debt).variableDebtTokenAddress).balanceOf(user);
        flashAmount = amount < owed ? amount : owed;
    }

    function _exitRepay(Place memory from, address debt, uint256 amount, uint256 repayShares, address user)
        internal
        returns (uint256 repaid)
    {
        if (from.venue == Venue.AaveV4) return _repayV4(from.target, from.debtId, debt, amount, user);
        if (from.venue == Venue.Morpho) return _repayMorpho(from.market, amount, repayShares, user);
        IERC20(debt).forceApprove(from.target, amount);
        repaid = IAaveV3Pool(from.target).repay(debt, amount, VARIABLE, user);
        IERC20(debt).forceApprove(from.target, 0);
    }

    function _exitWithdraw(Place memory from, address collateral, uint256 amount, address user)
        internal
        returns (uint256 withdrawn)
    {
        if (from.venue == Venue.AaveV4) return _withdrawV4(from.target, from.collateralId, amount, user);
        if (from.venue == Venue.Morpho) return _withdrawMorpho(from.market, amount, user);
        // Aave v3: pull the aTokens (Aave checks the account's health on a partial move) and withdraw them; the whole
        // balance is withdrawn only when this contract held none before (aTokens donated to it are not the caller's)
        IAaveV3Pool pool = IAaveV3Pool(from.target);
        IERC20 aToken = IERC20(_aToken(from.target, collateral));
        if (amount == type(uint256).max) amount = aToken.balanceOf(user);
        if (amount == 0) revert ZeroAmount();
        uint256 held = aToken.balanceOf(address(this));
        aToken.safeTransferFrom(user, address(this), amount);
        withdrawn = pool.withdraw(
            collateral, held == 0 ? type(uint256).max : aToken.balanceOf(address(this)) - held, address(this)
        );
    }

    function _enter(Place memory to, address collateral, address debt, uint256 moved, uint256 repaid, address user)
        internal
    {
        if (to.venue == Venue.AaveV4) {
            _supplyV4(to.target, to.collateralId, collateral, moved, user);
            if (repaid != 0) TAKER.borrowOnBehalfOf(to.target, to.debtId, repaid, user);
        } else if (to.venue == Venue.Morpho) {
            IERC20(collateral).forceApprove(address(MORPHO), moved);
            MORPHO.supplyCollateral(to.market, moved, user, "");
            if (repaid != 0) MORPHO.borrow(to.market, repaid, 0, user, address(this));
        } else {
            IERC20(collateral).forceApprove(to.target, moved);
            IAaveV3Pool(to.target).supply(collateral, moved, user, 0);
            IERC20(collateral).forceApprove(to.target, 0);
            if (repaid != 0) IAaveV3Pool(to.target).borrow(debt, repaid, VARIABLE, 0, user);
        }
    }

    /// @dev The user's health factor at a place (1e18 = 1.00, type(uint256).max without debt).
    function _placeHealth(Place memory pl, address user) internal returns (uint256 hf) {
        if (pl.venue == Venue.AaveV4) return IAaveV4Spoke(pl.target).getUserAccountData(user).healthFactor;
        if (pl.venue == Venue.AaveV3) {
            (,,,,, hf) = IAaveV3Pool(pl.target).getUserAccountData(user);
            return hf;
        }
        MORPHO.accrueInterest(pl.market);
        return _morphoHealth(pl.market, user);
    }

    // ---------------------------------------------------------------------------------------------
    // Spoke
    // ---------------------------------------------------------------------------------------------

    /// @dev The underlying tokens of two reserves, on a spoke both position managers serve.
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

    function _checkCollateral(address spoke, uint256 reserveId, address user) internal view {
        (bool enabled,) = IAaveV4Spoke(spoke).getUserReserveStatus(reserveId, user);
        if (!enabled) revert CollateralNotEnabled(reserveId);
    }

    function _checkHealth(address spoke, address user, uint256 minHealthFactor) internal view returns (uint256 hf) {
        hf = IAaveV4Spoke(spoke).getUserAccountData(user).healthFactor;
        if (hf < minHealthFactor) revert HealthFactorTooLow(hf, minHealthFactor);
    }

    function _supplyV4(address spoke, uint256 reserveId, address token, uint256 amount, address user) internal {
        IERC20(token).forceApprove(address(GIVER), amount);
        GIVER.supplyOnBehalfOf(spoke, reserveId, amount, user);
        IERC20(token).forceApprove(address(GIVER), 0);
    }

    function _repayV4(address spoke, uint256 reserveId, address token, uint256 amount, address user)
        internal
        returns (uint256 repaid)
    {
        if (amount == 0) return 0;
        IERC20(token).forceApprove(address(GIVER), amount);
        (, repaid) = GIVER.repayOnBehalfOf(spoke, reserveId, amount, user);
        IERC20(token).forceApprove(address(GIVER), 0);
    }

    /// @dev withdraws `amount` (type(uint256).max: everything supplied; nothing when that is 0) for `user` to this
    /// contract, through the Taker
    function _withdrawV4(address spoke, uint256 reserveId, uint256 amount, address user)
        internal
        returns (uint256 withdrawn)
    {
        if (amount == type(uint256).max) amount = IAaveV4Spoke(spoke).getUserSuppliedAssets(reserveId, user);
        if (amount != 0) (, withdrawn) = TAKER.withdrawOnBehalfOf(spoke, reserveId, amount, user);
    }

    /// @dev relays a signed BorrowPermit; false when the signature is empty
    function _permitBorrow(address spoke, uint256 reserveId, Permit calldata permit) internal returns (bool) {
        if (permit.signature.length == 0) return false;
        // a front-run of the signature only makes this call fail; the allowance is then already in place
        try TAKER.approveBorrowWithSig(
            IAaveV4Taker.BorrowPermit({
                spoke: spoke,
                reserveId: reserveId,
                owner: msg.sender,
                spender: address(this),
                amount: permit.amount,
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            permit.signature
        ) {}
            catch {}
        return true;
    }

    function _permitWithdraw(address spoke, uint256 reserveId, Permit calldata permit) internal returns (bool) {
        if (permit.signature.length == 0) return false;
        try TAKER.approveWithdrawWithSig(
            IAaveV4Taker.WithdrawPermit({
                spoke: spoke,
                reserveId: reserveId,
                owner: msg.sender,
                spender: address(this),
                amount: permit.amount,
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            permit.signature
        ) {}
            catch {}
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // Aave v3 and Morpho sides of a refinance (same logic as LeverageExecutorMorpho)
    // ---------------------------------------------------------------------------------------------

    function _aToken(address pool, address asset) internal view returns (address) {
        return IAaveV3Pool(pool).getReserveData(asset).aTokenAddress;
    }

    /// @dev relays the signed allowance to take the collateral out of `from`; false when there is none
    function _permitExit(Place calldata from, address collateral, Permit calldata s) internal returns (bool) {
        if (from.venue == Venue.AaveV4) return _permitWithdraw(from.target, from.collateralId, s);
        if (from.venue != Venue.AaveV3 || s.signature.length == 0) return false;
        if (!isAavePool[from.target]) revert PoolNotAllowed(from.target);
        (uint8 v, bytes32 r, bytes32 ss) = _vrs(s.signature);
        try IERC20Permit(_aToken(from.target, collateral))
            .permit(msg.sender, address(this), s.amount, s.deadline, v, r, ss) {}
            catch {}
        return true;
    }

    /// @dev relays the signed allowance to borrow at `to`; false when there is none
    function _permitEnter(Place calldata to, address debt, Permit calldata s) internal returns (bool) {
        if (to.venue == Venue.AaveV4) return _permitBorrow(to.target, to.debtId, s);
        if (to.venue != Venue.AaveV3 || s.signature.length == 0) return false;
        if (!isAavePool[to.target]) revert PoolNotAllowed(to.target);
        (uint8 v, bytes32 r, bytes32 ss) = _vrs(s.signature);
        address vDebt = IAaveV3Pool(to.target).getReserveData(debt).variableDebtTokenAddress;
        try ICreditDelegationToken(vDebt)
            .delegationWithSig(msg.sender, address(this), s.amount, s.deadline, v, r, ss) {}
            catch {}
        return true;
    }

    function _vrs(bytes calldata sig) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        r = bytes32(sig[0:32]);
        s = bytes32(sig[32:64]);
        v = uint8(sig[64]);
    }

    /// @dev Flash amount and repay shares for `repayAmount` on Morpho (max = the whole debt, repaid by shares so that
    /// no dust is left; the amount is computed after accruing interest, exactly as Morpho will round it).
    function _repayPlan(MarketParams memory m, address user, uint256 repayAmount)
        internal
        returns (uint256 flashAmount, uint256 repayShares)
    {
        if (repayAmount != type(uint256).max) return (repayAmount, 0);
        MORPHO.accrueInterest(m);
        bytes32 id = keccak256(abi.encode(m));
        (, uint128 borrowShares,) = MORPHO.position(id, user);
        if (borrowShares == 0) return (0, 0);
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = MORPHO.market(id);
        repayShares = borrowShares;
        flashAmount = _toAssetsUp(repayShares, totalBorrowAssets, totalBorrowShares);
    }

    function _repayMorpho(MarketParams memory m, uint256 amount, uint256 shares, address user)
        internal
        returns (uint256 repaid)
    {
        IERC20(m.loanToken).forceApprove(address(MORPHO), amount);
        (repaid,) = MORPHO.repay(m, shares == 0 ? amount : 0, shares, user, "");
        IERC20(m.loanToken).forceApprove(address(MORPHO), 0);
    }

    function _withdrawMorpho(MarketParams memory m, uint256 amount, address user) internal returns (uint256) {
        if (amount == type(uint256).max) (,, amount) = MORPHO.position(keccak256(abi.encode(m)), user);
        if (amount == 0) revert ZeroAmount();
        MORPHO.withdrawCollateral(m, amount, user, address(this));
        return amount;
    }

    /// @dev Morpho's own rounding up of borrow shares to assets (SharesMathLib.toAssetsUp, plain arithmetic like
    /// Morpho's MathLib)
    function _toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        uint256 d = totalShares + VIRTUAL_SHARES;
        return (shares * (totalAssets + VIRTUAL_ASSETS) + d - 1) / d;
    }

    /// @dev collateral value (oracle) x LLTV / debt, as on Morpho's site and with Morpho's own arithmetic
    function _morphoHealth(MarketParams memory m, address user) internal view returns (uint256) {
        bytes32 id = keccak256(abi.encode(m));
        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(id, user);
        if (borrowShares == 0) return type(uint256).max;
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = MORPHO.market(id);
        uint256 borrowed = _toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
        uint256 maxBorrow = collateral * IMorphoOracle(m.oracle).price() / ORACLE_PRICE_SCALE * m.lltv / WAD;
        return maxBorrow * WAD / borrowed;
    }

    function _grant(AuthSigs calldata a) internal {
        // a front-run of the signature only makes this call fail; the authorization is then already in place
        try MORPHO.setAuthorizationWithSig(
            Authorization({
                authorizer: msg.sender,
                authorized: address(this),
                isAuthorized: true,
                nonce: a.nonce,
                deadline: a.deadline
            }),
            a.grant
        ) {}
            catch {}
    }

    function _revoke(AuthSigs calldata a) internal {
        try MORPHO.setAuthorizationWithSig(
            Authorization({
                authorizer: msg.sender,
                authorized: address(this),
                isAuthorized: false,
                nonce: a.nonce + 1,
                deadline: a.deadline
            }),
            a.revoke
        ) {}
            catch {}
        // whatever happened to the signature, the authorization must not outlive the transaction
        if (MORPHO.isAuthorized(msg.sender, address(this))) revert AuthorizationNotRevoked();
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
        } else if (action == Action.Close) {
            owed = _executeClose(user, assets, abi.decode(params, (CloseParams)));
        } else if (action == Action.SwapCollateral) {
            owed = _executeSwapCollateral(user, assets, abi.decode(params, (SwapCollateralParams)));
        } else if (action == Action.SwapDebt) {
            owed = _executeSwapDebt(user, assets, abi.decode(params, (SwapDebtParams)));
        } else {
            owed = _executeRefinance(user, assets, params);
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
