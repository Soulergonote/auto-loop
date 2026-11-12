// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {SwapExecutorBase} from "./base/SwapExecutorBase.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMorpho, IMorphoOracle, MarketParams, Authorization, MorphoSignature} from "./interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "./interfaces/IFlashLenders.sol";

/// @title LeverageExecutorMorpho
/// @notice Opens, closes and moves a leveraged Morpho Blue position in a single transaction, with the same swap
/// engine as LeverageExecutorV2 (chains of 1 to 4 whitelisted router calls, each checked on its own).
///
/// Open (market: collateral C, loan L):
///   pull the capital -> [swap it to C] -> Morpho flash loan of L (free) -> swap L (+ capital if it was L) -> C ->
///   supply all C as the caller's collateral -> borrow L for the caller (Morpho checks the LLTV) -> give the loan
///   back -> leftovers back to the caller -> minimum health factor check.
/// Close: flash loan of L -> repay the caller's debt -> withdraw C -> swap C -> L -> give the loan back ->
///   leftovers back to the caller -> minimum health factor check.
/// Roll (market A -> market B, same loan token, e.g. a Pendle PT rolled to a later maturity, or the same collateral
///   moved to a cheaper market): flash loan of L -> repay the caller's debt on A -> withdraw C_A -> [swap C_A ->
///   C_B] -> supply C_B on B -> borrow on B what the loan was -> give the loan back -> minimum health factor on B.
///
/// Prerequisites for the caller:
///   open:  capital.approve(executor, capitalAmount)
///   all:   the executor authorized on Morpho (`setAuthorization`) — or, with the `*WithAuth` variants, two
///          signatures: one granting the authorization (nonce n) and one revoking it (nonce n + 1). The contract
///          applies the first, does the work and applies the second, and the call reverts if the executor is still
///          authorized at the end: no authorization outlives the transaction.
///
/// Security model (same as LeverageExecutorV2):
///   - the contract only ever acts for msg.sender: borrower, supplier and owner of the withdrawn collateral
///   - the flash loan callback is accepted only from Morpho, for the exact token, amount and data this contract
///     recorded just before requesting it (one-shot)
///   - aggregator calls only go to routers whitelisted at deployment, never Morpho and never one of the tokens of
///     the operation; each step gets an exact approval reset to 0 afterwards, may not spend more than approved, and
///     its output is checked as a balance delta against its own minimum
///   - the contract keeps no funds and no allowances between transactions: every balance it gained during a call
///     goes back to the caller
///   - no owner, no admin function, no proxy: Morpho and the routers are fixed at deployment
contract LeverageExecutorMorpho is IMorphoFlashLoanCallback, ReentrancyGuard, SwapExecutorBase {
    using SafeERC20 for IERC20;

    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant WAD = 1e18;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IMorpho public immutable MORPHO;

    /// @dev hash of the flash loan this contract is waiting for, 0 when none
    bytes32 private _pendingFlash;
    /// @dev amounts computed inside the flash loan callback, read back by the entry function
    uint256[3] private _out;

    enum Action {
        Open,
        Close,
        Roll
    }

    /// @param minHealthFactor the call reverts if the caller's health factor ends below it (1e18 = 1.00; 0 = no
    ///                        check). Health factor = collateral value (oracle) x LLTV / debt, as on Morpho's site.
    /// @param deadline        the call reverts after this timestamp
    struct Guard {
        uint256 minHealthFactor;
        uint256 deadline;
    }

    /// @notice Signatures for `setAuthorizationWithSig`: `grant` for nonce `nonce`, `revoke` for `nonce + 1`, both
    /// with authorizer = caller, authorized = this contract and `deadline`.
    struct AuthSigs {
        uint256 nonce;
        uint256 deadline;
        MorphoSignature grant;
        MorphoSignature revoke;
    }

    /// @param capitalToken  token pulled from the caller (ignored when capitalAmount is 0)
    /// @param capitalAmount amount pulled; 0 levers an existing position
    /// @param capitalSteps  capital -> collateral; empty when the capital is the collateral or the loan token
    /// @param debtAmount    debt opened and sold; 0 for a plain deposit of the capital
    /// @param steps         loan token (+ capital when it is the loan token) -> collateral
    struct OpenParams {
        MarketParams market;
        address capitalToken;
        uint256 capitalAmount;
        Step[] capitalSteps;
        uint256 debtAmount;
        Step[] steps;
        Guard guard;
    }

    /// @param repayAmount          debt to repay; type(uint256).max repays the whole debt (by shares, no dust)
    /// @param collateralToWithdraw collateral to withdraw; type(uint256).max withdraws everything
    /// @param collateralToSell     collateral sold for the loan token by `steps` (0 = no swap, steps empty)
    struct CloseParams {
        MarketParams market;
        uint256 repayAmount;
        uint256 collateralToWithdraw;
        uint256 collateralToSell;
        Step[] steps;
        Guard guard;
    }

    /// @param repayAmount      debt moved from `from` to `to`; type(uint256).max moves the whole debt
    /// @param collateralToMove collateral withdrawn from `from`; type(uint256).max moves everything
    /// @param steps            from.collateral -> to.collateral (all of it); empty when both markets share the
    ///                         collateral
    struct RollParams {
        MarketParams from;
        MarketParams to;
        uint256 repayAmount;
        uint256 collateralToMove;
        Step[] steps;
        Guard guard;
    }

    struct CloseResult {
        uint256 debtRepaid;
        uint256 collateralWithdrawn;
        uint256 collateralReturned;
        uint256 loanReturned;
        uint256 healthFactor;
    }

    struct RollResult {
        uint256 debtRepaid;
        uint256 collateralWithdrawn;
        uint256 collateralSupplied;
        uint256 debtBorrowed;
        uint256 healthFactor;
    }

    event PositionOpened(
        address indexed user,
        bytes32 indexed marketId,
        address capitalToken,
        uint256 capitalAmount,
        uint256 collateralSupplied,
        uint256 debtBorrowed,
        uint256 healthFactor
    );
    event PositionClosed(address indexed user, bytes32 indexed marketId, CloseResult result);
    event PositionRolled(address indexed user, bytes32 indexed fromId, bytes32 indexed toId, RollResult result);

    error SameMarket();
    error LoanTokenMismatch();
    error ZeroAmount();
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);
    error CallerNotLender();
    error UnexpectedFlashLoan();
    error FlashLoanNotExecuted();
    error UnexpectedSteps();
    error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn);
    error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed);
    error AuthorizationNotRevoked();

    constructor(IMorpho morpho, address[] memory routers) {
        if (address(morpho) == address(0) || address(morpho).code.length == 0) revert ZeroAddress();
        MORPHO = morpho;
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            // an EOA would make every swap a no-op call; Morpho and this contract must never be targets (a call to
            // Morpho from here would act with the caller's authorization)
            if (router == address(morpho) || router == address(this) || router.code.length == 0) {
                revert InvalidRouter(router);
            }
            _allowRouter(router);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------------------------------

    function open(OpenParams calldata p)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)
    {
        return _open(p);
    }

    function openWithAuth(OpenParams calldata p, AuthSigs calldata auth)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)
    {
        _grant(auth);
        (collateralSupplied, debtBorrowed, healthFactor) = _open(p);
        _revoke(auth);
    }

    function close(CloseParams calldata p) external nonReentrant returns (CloseResult memory) {
        return _close(p);
    }

    function closeWithAuth(CloseParams calldata p, AuthSigs calldata auth)
        external
        nonReentrant
        returns (CloseResult memory r)
    {
        _grant(auth);
        r = _close(p);
        _revoke(auth);
    }

    function roll(RollParams calldata p) external nonReentrant returns (RollResult memory) {
        return _roll(p);
    }

    function rollWithAuth(RollParams calldata p, AuthSigs calldata auth)
        external
        nonReentrant
        returns (RollResult memory r)
    {
        _grant(auth);
        r = _roll(p);
        _revoke(auth);
    }

    /// @notice Health factor of `user` on a market, computed like the minimum health factor check
    /// (type(uint256).max without debt). View: interest since the market's last update is not included.
    function healthFactor(MarketParams calldata market, address user) external view returns (uint256) {
        return _healthFactor(market, user);
    }

    // ---------------------------------------------------------------------------------------------
    // Open
    // ---------------------------------------------------------------------------------------------

    function _open(OpenParams calldata cp) internal returns (uint256 supplied, uint256 borrowed, uint256 hf) {
        OpenParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        MarketParams memory m = p.market;
        if (m.collateralToken == m.loanToken) revert SameAsset();
        if (p.debtAmount == 0 && p.capitalAmount == 0) revert ZeroAmount();

        address[] memory tokens = _openTokens(p);
        uint256[] memory before = _balances(tokens);

        // capital -> collateral (or loan token, sold together with the borrowed amount)
        uint256 collateralFromCapital;
        uint256 loanFromCapital;
        if (p.capitalAmount != 0) {
            IERC20(p.capitalToken).safeTransferFrom(msg.sender, address(this), p.capitalAmount);
            if (p.capitalToken == m.collateralToken || p.capitalToken == m.loanToken) {
                if (p.capitalSteps.length != 0) revert UnexpectedSteps();
                if (p.capitalToken == m.collateralToken) collateralFromCapital = p.capitalAmount;
                else loanFromCapital = p.capitalAmount;
            } else {
                collateralFromCapital =
                    _swapChain(msg.sender, p.capitalToken, p.capitalAmount, p.capitalSteps, m.collateralToken, tokens);
            }
        } else if (p.capitalSteps.length != 0) {
            revert UnexpectedSteps();
        }

        if (p.debtAmount != 0) {
            _flash(
                m.loanToken,
                p.debtAmount,
                abi.encode(Action.Open, msg.sender, abi.encode(p, collateralFromCapital, loanFromCapital))
            );
            supplied = _out[0];
            delete _out;
        } else {
            supplied = _supplyLevered(msg.sender, p, 0, collateralFromCapital, loanFromCapital, tokens);
        }
        borrowed = p.debtAmount;

        _sweep(tokens, before, msg.sender);
        hf = _checkHealth(m, msg.sender, p.guard.minHealthFactor);
        emit PositionOpened(msg.sender, _id(m), p.capitalToken, p.capitalAmount, supplied, borrowed, hf);
    }

    /// @dev sells `borrowed` + the capital given in loan token for collateral and supplies everything for `user`
    function _supplyLevered(
        address user,
        OpenParams memory p,
        uint256 borrowed,
        uint256 collateralFromCapital,
        uint256 loanFromCapital,
        address[] memory tokens
    ) internal returns (uint256 supplied) {
        uint256 toSell = borrowed + loanFromCapital;
        uint256 received;
        if (toSell != 0) {
            received = _swapChain(user, p.market.loanToken, toSell, p.steps, p.market.collateralToken, tokens);
        } else if (p.steps.length != 0) {
            revert UnexpectedSteps();
        }

        supplied = collateralFromCapital + received;
        if (supplied == 0) revert ZeroAmount();
        _supplyCollateral(p.market, supplied, user);
    }

    function _executeOpen(address user, uint256 amount, bytes memory inner) internal returns (uint256 owed) {
        (OpenParams memory p, uint256 collateralFromCapital, uint256 loanFromCapital) =
            abi.decode(inner, (OpenParams, uint256, uint256));
        address[] memory tokens = _openTokens(p);
        _out[0] = _supplyLevered(user, p, amount, collateralFromCapital, loanFromCapital, tokens);
        // the debt is opened only now, against the collateral just supplied; Morpho checks the LLTV and liquidity
        MORPHO.borrow(p.market, amount, 0, user, address(this));
        owed = amount;
    }

    // ---------------------------------------------------------------------------------------------
    // Close / deleverage
    // ---------------------------------------------------------------------------------------------

    function _close(CloseParams calldata cp) internal returns (CloseResult memory r) {
        CloseParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        MarketParams memory m = p.market;
        if (m.collateralToken == m.loanToken) revert SameAsset();

        (uint256 flashAmount, uint256 repayShares) = _repayPlan(m, msg.sender, p.repayAmount);

        address[] memory tokens = _pairTokens(m.collateralToken, m.loanToken, p.steps);
        uint256[] memory before = _balances(tokens);

        if (flashAmount != 0) {
            _flash(m.loanToken, flashAmount, abi.encode(Action.Close, msg.sender, abi.encode(p, repayShares)));
        } else {
            // no debt left (e.g. after a liquidation): only withdraw and sell
            _executeClose(msg.sender, 0, 0, p);
        }
        r.debtRepaid = _out[0];
        r.collateralWithdrawn = _out[1];
        delete _out;

        uint256[] memory sent = _sweep(tokens, before, msg.sender);
        r.collateralReturned = sent[0];
        r.loanReturned = sent[1];
        r.healthFactor = _checkHealth(m, msg.sender, p.guard.minHealthFactor);
        emit PositionClosed(msg.sender, _id(m), r);
    }

    function _executeClose(address user, uint256 flashAmount, uint256 repayShares, CloseParams memory p)
        internal
        returns (uint256 owed)
    {
        MarketParams memory m = p.market;
        address[] memory tokens = _pairTokens(m.collateralToken, m.loanToken, p.steps);

        // 1. repay the user's debt with the borrowed funds
        uint256 repaid = _repay(m, flashAmount, repayShares, user);

        // 2. withdraw the collateral (Morpho checks the position stays healthy)
        uint256 withdrawn = _withdrawCollateral(m, p.collateralToWithdraw, user);

        // 3. sell collateral for the loan token
        if (p.collateralToSell > withdrawn) revert SellExceedsWithdrawn(p.collateralToSell, withdrawn);
        if (p.collateralToSell != 0) {
            _swapChain(user, m.collateralToken, p.collateralToSell, p.steps, m.loanToken, tokens);
        } else if (p.steps.length != 0) {
            revert UnexpectedSteps();
        }

        // 4. the loan must be covered
        owed = flashAmount;
        uint256 bal = IERC20(m.loanToken).balanceOf(address(this));
        if (bal < owed) revert InsufficientToRepayFlashLoan(bal, owed);

        _out[0] = repaid;
        _out[1] = withdrawn;
    }

    // ---------------------------------------------------------------------------------------------
    // Roll (market A -> market B, same loan token)
    // ---------------------------------------------------------------------------------------------

    function _roll(RollParams calldata cp) internal returns (RollResult memory r) {
        RollParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.from.loanToken != p.to.loanToken) revert LoanTokenMismatch();
        if (_id(p.from) == _id(p.to)) revert SameMarket();
        if (p.from.collateralToken == p.from.loanToken || p.to.collateralToken == p.to.loanToken) revert SameAsset();
        if (p.from.collateralToken == p.to.collateralToken) {
            if (p.steps.length != 0) revert UnexpectedSteps();
        } else if (p.steps.length == 0) {
            revert InvalidSteps();
        }

        (uint256 flashAmount, uint256 repayShares) = _repayPlan(p.from, msg.sender, p.repayAmount);

        address[] memory tokens = _rollTokens(p);
        uint256[] memory before = _balances(tokens);

        if (flashAmount != 0) {
            _flash(p.from.loanToken, flashAmount, abi.encode(Action.Roll, msg.sender, abi.encode(p, repayShares)));
        } else {
            _executeRoll(msg.sender, 0, 0, p);
        }
        r.debtRepaid = _out[0];
        r.collateralWithdrawn = _out[1];
        r.collateralSupplied = _out[2];
        r.debtBorrowed = flashAmount;
        delete _out;

        _sweep(tokens, before, msg.sender);
        r.healthFactor = _checkHealth(p.to, msg.sender, p.guard.minHealthFactor);
        emit PositionRolled(msg.sender, _id(p.from), _id(p.to), r);
    }

    function _executeRoll(address user, uint256 flashAmount, uint256 repayShares, RollParams memory p)
        internal
        returns (uint256 owed)
    {
        // 1. repay on the old market, take the collateral out
        uint256 repaid = _repay(p.from, flashAmount, repayShares, user);
        uint256 withdrawn = _withdrawCollateral(p.from, p.collateralToMove, user);

        // 2. old collateral -> new collateral (nothing to do when both markets share it)
        uint256 supplied;
        if (p.from.collateralToken == p.to.collateralToken) {
            supplied = withdrawn; // steps checked empty by _roll
        } else {
            supplied =
                _swapChain(user, p.from.collateralToken, withdrawn, p.steps, p.to.collateralToken, _rollTokens(p));
        }
        if (supplied == 0) revert ZeroAmount();

        // 3. supply on the new market, then open there the debt that was repaid on the old one
        _supplyCollateral(p.to, supplied, user);
        if (flashAmount != 0) MORPHO.borrow(p.to, flashAmount, 0, user, address(this));
        owed = flashAmount;

        _out[0] = repaid;
        _out[1] = withdrawn;
        _out[2] = supplied;
    }

    // ---------------------------------------------------------------------------------------------
    // Morpho helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Flash amount and repay shares for `repayAmount` (max = the whole debt, repaid by shares so that no dust
    /// is left; the amount is computed after accruing interest, exactly as Morpho will round it).
    function _repayPlan(MarketParams memory m, address user, uint256 repayAmount)
        internal
        returns (uint256 flashAmount, uint256 repayShares)
    {
        if (repayAmount != type(uint256).max) return (repayAmount, 0);
        MORPHO.accrueInterest(m);
        bytes32 id = _id(m);
        (, uint128 borrowShares,) = MORPHO.position(id, user);
        if (borrowShares == 0) return (0, 0);
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = MORPHO.market(id);
        repayShares = borrowShares;
        flashAmount = Math.mulDiv(
            repayShares, totalBorrowAssets + VIRTUAL_ASSETS, totalBorrowShares + VIRTUAL_SHARES, Math.Rounding.Ceil
        );
    }

    function _repay(MarketParams memory m, uint256 amount, uint256 shares, address user)
        internal
        returns (uint256 repaid)
    {
        if (amount == 0) return 0;
        IERC20(m.loanToken).forceApprove(address(MORPHO), amount);
        (repaid,) = MORPHO.repay(m, shares == 0 ? amount : 0, shares, user, "");
        IERC20(m.loanToken).forceApprove(address(MORPHO), 0);
    }

    function _withdrawCollateral(MarketParams memory m, uint256 amount, address user)
        internal
        returns (uint256 withdrawn)
    {
        if (amount == type(uint256).max) {
            (,, uint128 collateral) = MORPHO.position(_id(m), user);
            amount = collateral;
        }
        if (amount == 0) revert ZeroAmount();
        MORPHO.withdrawCollateral(m, amount, user, address(this));
        withdrawn = amount;
    }

    function _supplyCollateral(MarketParams memory m, uint256 amount, address user) internal {
        IERC20(m.collateralToken).forceApprove(address(MORPHO), amount);
        MORPHO.supplyCollateral(m, amount, user, "");
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

    function _healthFactor(MarketParams memory m, address user) internal view returns (uint256) {
        bytes32 id = _id(m);
        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(id, user);
        if (borrowShares == 0) return type(uint256).max;
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = MORPHO.market(id);
        uint256 borrowed = Math.mulDiv(
            borrowShares, totalBorrowAssets + VIRTUAL_ASSETS, totalBorrowShares + VIRTUAL_SHARES, Math.Rounding.Ceil
        );
        uint256 maxBorrow =
            Math.mulDiv(Math.mulDiv(collateral, IMorphoOracle(m.oracle).price(), ORACLE_PRICE_SCALE), m.lltv, WAD);
        return Math.mulDiv(maxBorrow, WAD, borrowed);
    }

    function _checkHealth(MarketParams memory m, address user, uint256 minHealthFactor) internal returns (uint256 hf) {
        MORPHO.accrueInterest(m);
        hf = _healthFactor(m, user);
        if (hf < minHealthFactor) revert HealthFactorTooLow(hf, minHealthFactor);
    }

    function _id(MarketParams memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
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
            (CloseParams memory p, uint256 repayShares) = abi.decode(params, (CloseParams, uint256));
            owed = _executeClose(user, assets, repayShares, p);
        } else {
            (RollParams memory p, uint256 repayShares) = abi.decode(params, (RollParams, uint256));
            owed = _executeRoll(user, assets, repayShares, p);
        }
        // Morpho pulls the loan back with transferFrom once this returns
        IERC20(token).forceApprove(msg.sender, owed);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps (identical to LeverageExecutorV2)
    // ---------------------------------------------------------------------------------------------

    // ---------------------------------------------------------------------------------------------
    // Token sets
    // ---------------------------------------------------------------------------------------------

    /// @dev Every token an open touches: index 0 collateral, 1 loan token, then the capital and the step outputs.
    function _openTokens(OpenParams memory p) internal pure returns (address[] memory tokens) {
        tokens = new address[](3 + p.capitalSteps.length + p.steps.length);
        uint256 n;
        n = _add(tokens, n, p.market.collateralToken);
        n = _add(tokens, n, p.market.loanToken);
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

    /// @dev Old collateral, new collateral, loan token, then the step outputs.
    function _rollTokens(RollParams memory p) internal pure returns (address[] memory tokens) {
        tokens = new address[](3 + p.steps.length);
        uint256 n;
        n = _add(tokens, n, p.from.collateralToken);
        n = _add(tokens, n, p.to.collateralToken);
        n = _add(tokens, n, p.from.loanToken);
        for (uint256 i; i < p.steps.length; ++i) {
            n = _add(tokens, n, p.steps[i].tokenOut);
        }
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
    }

}
