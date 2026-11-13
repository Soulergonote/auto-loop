// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {SwapExecutorBase} from "./base/SwapExecutorBase.sol";

import {IAaveV3Pool, IFlashLoanReceiver, ICreditDelegationToken} from "./interfaces/IAaveV3.sol";
import {
    IMorphoFlashLender,
    IMorphoFlashLoanCallback,
    IBalancerVault,
    IBalancerFlashLoanRecipient
} from "./interfaces/IFlashLenders.sol";

/// @title LeverageExecutorV2
/// @notice Opens, closes and re-collateralises a leveraged Aave v3 position in a single transaction.
///
/// Changes from v1 (same security model, new deployment, v1 positions can be managed by v2 since they live in the
/// user's own Aave account):
///   1. swaps are chains of 1 to 4 steps (e.g. PT -> sUSDe -> USDe), each step checked on its own
///   2. the starting capital can be any token (collateral, debt asset, or anything swapped to collateral first)
///   3. every call carries a minimum health factor and a deadline
///   4. `swapCollateral` replaces the collateral without touching the debt (rolling a Pendle PT at maturity)
///   5. close and swapCollateral can borrow from a free flash lender (Morpho Blue, Balancer v2) instead of Aave
///   6. every call returns the amounts actually moved and emits one `Swapped` event per step
///   7. (deployment) any router can be whitelisted at deployment, e.g. the Pendle router; no code change
///   8. `swapDebt` replaces the debt asset without touching the collateral (follow the cheapest stablecoin)
///
/// Open (collateral C, debt D):
///   pull the capital -> [swap it to C] -> Aave flash loan of D in debt mode (interestRateMode 2, onBehalfOf caller,
///   no premium) -> swap D (+ capital if it was D) -> C -> supply all C for the caller -> Aave opens the debt and
///   checks the caller's health factor -> leftovers back to the caller -> minimum health factor check.
/// Close: flash loan of D (Aave mode 0, Morpho or Balancer) -> repay the caller's debt -> pull the caller's aTokens ->
///   withdraw C -> swap C -> D -> give the loan back -> leftovers back to the caller -> minimum health factor check.
/// Swap collateral (C1 -> C2, debt unchanged): flash loan of C2 -> supply it for the caller -> pull the caller's
///   aC1 -> withdraw C1 -> swap C1 -> C2 -> give the loan back -> surplus C2 supplied for the caller -> checks.
/// Swap debt (D1 -> D2, collateral unchanged): Aave flash loan of D2 in debt mode (onBehalfOf caller, no premium)
///   -> swap D2 -> D1 -> repay the caller's D1 debt -> Aave opens the D2 debt and checks the caller's health factor
///   -> leftovers back to the caller -> minimum repaid and minimum health factor checks.
///
/// Prerequisites for the caller (granted in the same wallet batch, exact amounts):
///   open:           capital.approve(executor, capitalAmount) and variableDebtD.approveDelegation(executor, debt)
///   close:          aC.approve(executor, amount)
///   swapCollateral: aC1.approve(executor, amount), and the caller's eMode must accept C2
///   swapDebt:       variableDebtD2.approveDelegation(executor, newDebt), and the caller's eMode must lend D2
///
/// Security model (unchanged from v1, extended to every function):
///   - the contract only ever acts for msg.sender: borrower, supplier and owner of the withdrawn aTokens
///   - a flash loan callback is accepted only from the lender it was requested from, for the exact asset, amount
///     and data this contract recorded just before requesting it (one-shot), so nobody can trigger a callback
///   - aggregator calls only go to routers whitelisted at deployment, never an Aave token (asset, aToken, debt
///     token) and never one of the tokens of the operation; each step gets an exact approval reset to 0
///     afterwards, may not spend more than approved, and its output is checked as a balance delta against its own
///     minimum
///   - the contract keeps no funds and no allowances between transactions: every balance it gained during a call
///     goes back to the caller
///   - no owner, no admin function, no proxy: routers and flash lenders are fixed at deployment
contract LeverageExecutorV2 is
    IFlashLoanReceiver,
    IMorphoFlashLoanCallback,
    IBalancerFlashLoanRecipient,
    ReentrancyGuard,
    SwapExecutorBase
{
    using SafeERC20 for IERC20;

    uint256 private constant MODE_NONE = 0;
    uint256 private constant MODE_VARIABLE = 2;

    IAaveV3Pool public immutable POOL;

    /// @notice Free flash lenders accepted for close and swapCollateral, fixed at deployment.
    /// The Aave Pool itself is always accepted (pass `address(POOL)`), with its premium.
    mapping(address => FlashKind) public flashLenderKind;

    /// @dev hash of the flash loan this contract is waiting for, 0 when none
    bytes32 private _pendingFlash;
    /// @dev amounts computed inside a flash loan callback, read back by the entry function
    uint256[3] private _out;

    enum FlashKind {
        None,
        Morpho,
        Balancer
    }

    struct FlashLender {
        FlashKind kind;
        address lender;
    }

    enum Action {
        Open,
        Close,
        SwapCollateral,
        SwapDebt
    }

    /// @param minHealthFactor the call reverts if the caller's health factor ends below it (1e18 = 1.00; 0 = no check)
    /// @param deadline        the call reverts after this timestamp
    struct Guard {
        uint256 minHealthFactor;
        uint256 deadline;
    }

    /// @param capitalToken  token pulled from the caller (ignored when capitalAmount is 0)
    /// @param capitalAmount amount pulled; 0 levers an existing position
    /// @param capitalSteps  capital -> collateral; empty when the capital is the collateral or the debt asset
    /// @param debtAmount    debt opened and sold; 0 for a plain deposit of the capital
    /// @param steps         debt asset (+ capital when it is the debt asset) -> collateral; the first step sells
    ///                      exactly debtAmount (+ capitalAmount)
    struct OpenParams {
        address collateralAsset;
        address debtAsset;
        address capitalToken;
        uint256 capitalAmount;
        Step[] capitalSteps;
        uint256 debtAmount;
        Step[] steps;
        Guard guard;
    }

    /// @param repayAmount          debt to repay; type(uint256).max repays the whole debt
    /// @param collateralToWithdraw aTokens to withdraw; type(uint256).max withdraws everything
    /// @param collateralToSell     collateral sold for the debt asset by `steps` (0 = no swap, steps empty)
    /// @param flashLender          address(POOL) (premium) or a whitelisted free lender
    struct CloseParams {
        address collateralAsset;
        address debtAsset;
        uint256 repayAmount;
        uint256 collateralToWithdraw;
        uint256 collateralToSell;
        Step[] steps;
        address flashLender;
        Guard guard;
    }

    /// @param fromAmount aTokens of fromAsset to withdraw; type(uint256).max withdraws everything
    /// @param toAmount   amount of toAsset flash-borrowed and supplied first; the swap must cover it plus the premium
    /// @param steps      fromAsset -> toAsset, the first step sells at most the withdrawn amount
    struct SwapCollateralParams {
        address fromAsset;
        address toAsset;
        uint256 fromAmount;
        uint256 toAmount;
        Step[] steps;
        address flashLender;
        Guard guard;
    }

    /// @param fromAsset     debt asset repaid (D1)
    /// @param toAsset       debt asset borrowed instead (D2)
    /// @param newDebtAmount D2 borrowed and sold for D1 (the first step sells exactly this amount)
    /// @param minRepaid     the call reverts if less D1 debt is repaid; type(uint256).max = the caller's whole D1 debt
    /// @param steps         D2 -> D1
    struct SwapDebtParams {
        address fromAsset;
        address toAsset;
        uint256 newDebtAmount;
        uint256 minRepaid;
        Step[] steps;
        Guard guard;
    }

    struct SwapDebtResult {
        uint256 repaid;
        uint256 borrowed;
        uint256 returned;
        uint256 healthFactor;
    }

    struct CloseResult {
        uint256 debtRepaid;
        uint256 collateralWithdrawn;
        uint256 collateralReturned;
        uint256 debtReturned;
        uint256 flashPremium;
        uint256 healthFactor;
    }

    struct SwapCollateralResult {
        uint256 withdrawn;
        uint256 supplied;
        uint256 flashPremium;
        uint256 healthFactor;
    }

    /// @notice EIP-2612 style signature (aToken permit or debt token delegationWithSig).
    struct Signature {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event FlashLenderAllowed(address indexed lender, FlashKind kind);
    event PositionOpened(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        address capitalToken,
        uint256 capitalAmount,
        uint256 collateralSupplied,
        uint256 debtBorrowed,
        uint256 healthFactor
    );
    event PositionClosed(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        address flashLender,
        CloseResult result
    );
    event CollateralSwapped(
        address indexed user,
        address indexed fromAsset,
        address indexed toAsset,
        address flashLender,
        SwapCollateralResult result
    );

    event DebtSwapped(address indexed user, address indexed fromAsset, address indexed toAsset, SwapDebtResult result);

    error ZeroAmount();
    error RepaidTooLittle(uint256 repaid, uint256 minRepaid);
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);
    error InvalidFlashLender(address lender);
    error FlashLenderNotAllowed(address lender);
    error CallerNotLender();
    error InitiatorNotSelf();
    error InvalidFlashLoan();
    error UnexpectedFlashLoan();
    error FlashLoanNotExecuted();
    error UnexpectedSteps();
    error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn);
    error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed);

    constructor(IAaveV3Pool pool, address[] memory routers, FlashLender[] memory lenders) {
        if (address(pool) == address(0)) revert ZeroAddress();
        POOL = pool;
        // lenders first, so that a router can be checked against them
        for (uint256 i; i < lenders.length; ++i) {
            address l = lenders[i].lender;
            if (
                lenders[i].kind == FlashKind.None || l == address(pool) || l == address(this) || l.code.length == 0
                    || flashLenderKind[l] != FlashKind.None
            ) revert InvalidFlashLender(l);
            flashLenderKind[l] = lenders[i].kind;
            emit FlashLenderAllowed(l, lenders[i].kind);
        }
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            // an EOA would make every swap a no-op call; the pool, a lender and this contract must never be targets
            if (
                router == address(pool) || router == address(this) || router.code.length == 0
                    || flashLenderKind[router] != FlashKind.None || _isAaveToken(pool, router)
            ) revert InvalidRouter(router);
            _allowRouter(router);
        }
    }

    /// @dev true for an asset listed on `pool`, or one of its aTokens or variable debt tokens: calling a token from
    /// this contract could spend allowances users gave it, so no Aave token can ever be whitelisted as a router
    /// (tokens that are not on Aave are refused per operation, see `_swap`)
    function _isAaveToken(IAaveV3Pool pool, address router) private view returns (bool) {
        if (pool.getReserveData(router).aTokenAddress != address(0)) return true;
        // low-level, so that a router with a fallback (or without this function) never makes the deployment fail
        (bool ok, bytes memory ret) = router.staticcall(abi.encodeWithSignature("UNDERLYING_ASSET_ADDRESS()"));
        if (!ok || ret.length != 32) return false;
        uint256 raw = abi.decode(ret, (uint256));
        if (raw > type(uint160).max) return false;
        // safe: raw fits in 160 bits (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        IAaveV3Pool.ReserveDataLegacy memory r = pool.getReserveData(address(uint160(raw)));
        return r.aTokenAddress == router || r.variableDebtTokenAddress == router;
    }

    // ---------------------------------------------------------------------------------------------
    // Open
    // ---------------------------------------------------------------------------------------------

    function open(OpenParams calldata p)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)
    {
        return _open(p);
    }

    /// @notice Same as `open`, granting the credit delegation with a signature in the same transaction.
    /// A front-run of the signature only makes the inner call fail; the delegation is then already in place.
    function openWithSig(OpenParams calldata p, Signature calldata delegation)
        external
        nonReentrant
        returns (uint256 collateralSupplied, uint256 debtBorrowed, uint256 healthFactor)
    {
        address vDebt = POOL.getReserveData(p.debtAsset).variableDebtTokenAddress;
        try ICreditDelegationToken(vDebt)
            .delegationWithSig(
                msg.sender,
                address(this),
                delegation.value,
                delegation.deadline,
                delegation.v,
                delegation.r,
                delegation.s
            ) {}
            catch {}
        return _open(p);
    }

    function _open(OpenParams calldata cp) internal returns (uint256 supplied, uint256 borrowed, uint256 hf) {
        OpenParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.collateralAsset == p.debtAsset) revert SameAsset();
        if (p.debtAmount == 0 && p.capitalAmount == 0) revert ZeroAmount();

        address[] memory tokens = _openTokens(p);
        uint256[] memory before = _balances(tokens);

        // capital -> collateral (or debt asset, sold together with the borrowed amount)
        uint256 collateralFromCapital;
        uint256 debtFromCapital;
        if (p.capitalAmount != 0) {
            IERC20(p.capitalToken).safeTransferFrom(msg.sender, address(this), p.capitalAmount);
            if (p.capitalToken == p.collateralAsset || p.capitalToken == p.debtAsset) {
                if (p.capitalSteps.length != 0) revert UnexpectedSteps();
                if (p.capitalToken == p.collateralAsset) collateralFromCapital = p.capitalAmount;
                else debtFromCapital = p.capitalAmount;
            } else {
                collateralFromCapital =
                    _swapChain(msg.sender, p.capitalToken, p.capitalAmount, p.capitalSteps, p.collateralAsset, tokens);
            }
        } else if (p.capitalSteps.length != 0) {
            revert UnexpectedSteps();
        }

        if (p.debtAmount != 0) {
            _flash(
                address(POOL),
                p.debtAsset,
                p.debtAmount,
                MODE_VARIABLE,
                msg.sender,
                abi.encode(Action.Open, msg.sender, abi.encode(p, collateralFromCapital, debtFromCapital))
            );
            supplied = _out[0];
            delete _out;
        } else {
            supplied = _supplyLevered(msg.sender, p, 0, collateralFromCapital, debtFromCapital, tokens);
        }
        borrowed = p.debtAmount;

        _sweep(tokens, before, msg.sender);
        hf = _checkHealth(msg.sender, p.guard.minHealthFactor);
        emit PositionOpened(
            msg.sender, p.collateralAsset, p.debtAsset, p.capitalToken, p.capitalAmount, supplied, borrowed, hf
        );
    }

    /// @dev sells `borrowed` + the capital given in debt asset for collateral and supplies everything for `user`
    function _supplyLevered(
        address user,
        OpenParams memory p,
        uint256 borrowed,
        uint256 collateralFromCapital,
        uint256 debtFromCapital,
        address[] memory tokens
    ) internal returns (uint256 supplied) {
        uint256 toSell = borrowed + debtFromCapital;
        uint256 received;
        if (toSell != 0) received = _swapChain(user, p.debtAsset, toSell, p.steps, p.collateralAsset, tokens);
        else if (p.steps.length != 0) revert UnexpectedSteps();

        supplied = collateralFromCapital + received;
        if (supplied == 0) revert ZeroAmount();
        IERC20(p.collateralAsset).forceApprove(address(POOL), supplied);
        POOL.supply(p.collateralAsset, supplied, user, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Close / deleverage
    // ---------------------------------------------------------------------------------------------

    function close(CloseParams calldata p) external nonReentrant returns (CloseResult memory) {
        return _close(p);
    }

    /// @notice Same as `close`, approving the aTokens with a permit signature in the same transaction.
    function closeWithSig(CloseParams calldata p, Signature calldata aTokenPermit)
        external
        nonReentrant
        returns (CloseResult memory)
    {
        _permitAToken(p.collateralAsset, aTokenPermit);
        return _close(p);
    }

    function _close(CloseParams calldata cp) internal returns (CloseResult memory r) {
        CloseParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.collateralAsset == p.debtAsset) revert SameAsset();

        if (p.repayAmount == type(uint256).max) {
            // Aave refuses type(uint256).max when repaying on behalf of someone else: use the exact current debt
            p.repayAmount = IERC20(POOL.getReserveData(p.debtAsset).variableDebtTokenAddress).balanceOf(msg.sender);
        }
        if (p.repayAmount == 0) revert ZeroAmount();

        address[] memory tokens = _pairTokens(p.collateralAsset, p.debtAsset, p.steps);
        uint256[] memory before = _balances(tokens);

        _flash(
            p.flashLender,
            p.debtAsset,
            p.repayAmount,
            MODE_NONE,
            address(this),
            abi.encode(Action.Close, msg.sender, abi.encode(p))
        );
        r.debtRepaid = _out[0];
        r.collateralWithdrawn = _out[1];
        r.flashPremium = _out[2];
        delete _out;

        uint256[] memory sent = _sweep(tokens, before, msg.sender);
        r.collateralReturned = sent[0];
        r.debtReturned = sent[1];
        r.healthFactor = _checkHealth(msg.sender, p.guard.minHealthFactor);
        emit PositionClosed(msg.sender, p.collateralAsset, p.debtAsset, p.flashLender, r);
    }

    function _executeClose(address user, uint256 flashAmount, uint256 premium, CloseParams memory p)
        internal
        returns (uint256 owed)
    {
        address[] memory tokens = _pairTokens(p.collateralAsset, p.debtAsset, p.steps);

        // 1. repay the user's debt with the borrowed funds (Aave may take less: allowance reset right after)
        IERC20(p.debtAsset).forceApprove(address(POOL), flashAmount);
        uint256 repaid = POOL.repay(p.debtAsset, flashAmount, MODE_VARIABLE, user);
        IERC20(p.debtAsset).forceApprove(address(POOL), 0);

        // 2. take the user's aTokens (Aave checks the user's health factor on this transfer) and withdraw them
        uint256 withdrawn = _pullAndWithdraw(user, p.collateralAsset, p.collateralToWithdraw);

        // 3. sell collateral for the debt asset
        if (p.collateralToSell > withdrawn) revert SellExceedsWithdrawn(p.collateralToSell, withdrawn);
        if (p.collateralToSell != 0) {
            _swapChain(user, p.collateralAsset, p.collateralToSell, p.steps, p.debtAsset, tokens);
        } else if (p.steps.length != 0) {
            revert UnexpectedSteps();
        }

        // 4. the loan must be covered
        owed = flashAmount + premium;
        uint256 bal = IERC20(p.debtAsset).balanceOf(address(this));
        if (bal < owed) revert InsufficientToRepayFlashLoan(bal, owed);

        _out[0] = repaid;
        _out[1] = withdrawn;
        _out[2] = premium;
    }

    // ---------------------------------------------------------------------------------------------
    // Swap collateral (debt unchanged)
    // ---------------------------------------------------------------------------------------------

    function swapCollateral(SwapCollateralParams calldata p)
        external
        nonReentrant
        returns (SwapCollateralResult memory)
    {
        return _swapCollateral(p);
    }

    /// @notice Same as `swapCollateral`, approving the fromAsset aTokens with a permit signature.
    function swapCollateralWithSig(SwapCollateralParams calldata p, Signature calldata aTokenPermit)
        external
        nonReentrant
        returns (SwapCollateralResult memory)
    {
        _permitAToken(p.fromAsset, aTokenPermit);
        return _swapCollateral(p);
    }

    function _swapCollateral(SwapCollateralParams calldata cp) internal returns (SwapCollateralResult memory r) {
        SwapCollateralParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.fromAsset == p.toAsset) revert SameAsset();
        if (p.toAmount == 0 || p.fromAmount == 0) revert ZeroAmount();

        address[] memory tokens = _pairTokens(p.fromAsset, p.toAsset, p.steps);
        uint256[] memory before = _balances(tokens);

        _flash(
            p.flashLender,
            p.toAsset,
            p.toAmount,
            MODE_NONE,
            address(this),
            abi.encode(Action.SwapCollateral, msg.sender, abi.encode(p))
        );
        r.withdrawn = _out[0];
        r.supplied = _out[1];
        r.flashPremium = _out[2];
        delete _out;

        _sweep(tokens, before, msg.sender);
        r.healthFactor = _checkHealth(msg.sender, p.guard.minHealthFactor);
        emit CollateralSwapped(msg.sender, p.fromAsset, p.toAsset, p.flashLender, r);
    }

    function _executeSwapCollateral(address user, uint256 flashAmount, uint256 premium, SwapCollateralParams memory p)
        internal
        returns (uint256 owed)
    {
        address[] memory tokens = _pairTokens(p.fromAsset, p.toAsset, p.steps);

        // 1. the new collateral goes in first, so that the old one can leave without breaking the health factor
        IERC20(p.toAsset).forceApprove(address(POOL), flashAmount);
        POOL.supply(p.toAsset, flashAmount, user, 0);

        // 2. take the old collateral out
        uint256 withdrawn = _pullAndWithdraw(user, p.fromAsset, p.fromAmount);

        // 3. old -> new; the router may take less than withdrawn, the rest goes back to the user
        uint256 received = _swapChain(user, p.fromAsset, withdrawn, p.steps, p.toAsset, tokens);

        // 4. the swap must cover the loan; any surplus is supplied for the user
        owed = flashAmount + premium;
        if (received < owed) revert InsufficientToRepayFlashLoan(received, owed);
        uint256 surplus = received - owed;
        if (surplus != 0) {
            IERC20(p.toAsset).forceApprove(address(POOL), surplus);
            POOL.supply(p.toAsset, surplus, user, 0);
        }

        _out[0] = withdrawn;
        _out[1] = flashAmount + surplus;
        _out[2] = premium;
    }

    // ---------------------------------------------------------------------------------------------
    // Swap debt (collateral unchanged)
    // ---------------------------------------------------------------------------------------------

    function swapDebt(SwapDebtParams calldata p) external nonReentrant returns (SwapDebtResult memory) {
        return _swapDebt(p);
    }

    /// @notice Same as `swapDebt`, granting the credit delegation of the new debt asset with a signature.
    /// A front-run of the signature only makes the inner call fail; the delegation is then already in place.
    function swapDebtWithSig(SwapDebtParams calldata p, Signature calldata delegation)
        external
        nonReentrant
        returns (SwapDebtResult memory)
    {
        address vDebt = POOL.getReserveData(p.toAsset).variableDebtTokenAddress;
        try ICreditDelegationToken(vDebt)
            .delegationWithSig(
                msg.sender,
                address(this),
                delegation.value,
                delegation.deadline,
                delegation.v,
                delegation.r,
                delegation.s
            ) {}
            catch {}
        return _swapDebt(p);
    }

    function _swapDebt(SwapDebtParams calldata cp) internal returns (SwapDebtResult memory r) {
        SwapDebtParams memory p = cp;
        _checkDeadline(p.guard.deadline);
        if (p.fromAsset == p.toAsset) revert SameAsset();
        if (p.newDebtAmount == 0 || p.steps.length == 0) revert ZeroAmount();
        if (p.minRepaid == type(uint256).max) {
            p.minRepaid = IERC20(POOL.getReserveData(p.fromAsset).variableDebtTokenAddress).balanceOf(msg.sender);
        }
        if (p.minRepaid == 0) revert ZeroAmount();

        address[] memory tokens = _pairTokens(p.fromAsset, p.toAsset, p.steps);
        uint256[] memory before = _balances(tokens);

        // mode 2: the loan becomes variable D2 debt of the caller once the callback has repaid D1
        _flash(
            address(POOL),
            p.toAsset,
            p.newDebtAmount,
            MODE_VARIABLE,
            msg.sender,
            abi.encode(Action.SwapDebt, msg.sender, abi.encode(p))
        );
        r.repaid = _out[0];
        delete _out;
        r.borrowed = p.newDebtAmount;

        uint256[] memory sent = _sweep(tokens, before, msg.sender);
        r.returned = sent[0];
        r.healthFactor = _checkHealth(msg.sender, p.guard.minHealthFactor);
        emit DebtSwapped(msg.sender, p.fromAsset, p.toAsset, r);
    }

    function _executeSwapDebt(address user, uint256 amount, SwapDebtParams memory p) internal {
        address[] memory tokens = _pairTokens(p.fromAsset, p.toAsset, p.steps);
        // 1. new debt asset -> old one
        uint256 received = _swapChain(user, p.toAsset, amount, p.steps, p.fromAsset, tokens);
        // 2. repay the old debt (Aave takes at most the debt; the rest goes back to the user with the sweep)
        IERC20(p.fromAsset).forceApprove(address(POOL), received);
        uint256 repaid = POOL.repay(p.fromAsset, received, MODE_VARIABLE, user);
        IERC20(p.fromAsset).forceApprove(address(POOL), 0);
        if (repaid < p.minRepaid) revert RepaidTooLittle(repaid, p.minRepaid);
        _out[0] = repaid;
    }

    // ---------------------------------------------------------------------------------------------
    // Flash loans
    // ---------------------------------------------------------------------------------------------

    /// @dev Requests a flash loan and checks that the lender called back. `mode` 2 (debt opened for `onBehalfOf`)
    /// only exists on Aave and is only used by open and swapDebt, always for the caller.
    function _flash(address lender, address asset, uint256 amount, uint256 mode, address onBehalfOf, bytes memory data)
        internal
    {
        _pendingFlash = keccak256(abi.encode(lender, asset, amount, data));
        if (lender == address(POOL)) {
            address[] memory assets = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            uint256[] memory modes = new uint256[](1);
            assets[0] = asset;
            amounts[0] = amount;
            modes[0] = mode;
            POOL.flashLoan(address(this), assets, amounts, modes, onBehalfOf, data, 0);
        } else {
            FlashKind kind = flashLenderKind[lender];
            if (kind == FlashKind.None) revert FlashLenderNotAllowed(lender);
            if (mode != MODE_NONE) revert InvalidFlashLoan();
            if (kind == FlashKind.Morpho) {
                // Morpho's callback does not name the token: it travels with the data
                IMorphoFlashLender(lender).flashLoan(asset, amount, abi.encode(asset, data));
            } else {
                IERC20[] memory tokens = new IERC20[](1);
                uint256[] memory amounts = new uint256[](1);
                tokens[0] = IERC20(asset);
                amounts[0] = amount;
                IBalancerVault(lender).flashLoan(address(this), tokens, amounts, data);
            }
        }
        if (_pendingFlash != bytes32(0)) revert FlashLoanNotExecuted();
    }

    /// @dev One-shot check that this callback answers the flash loan this contract has just requested.
    function _consumeFlash(address lender, address asset, uint256 amount, bytes memory data) internal {
        bytes32 expected = _pendingFlash;
        if (expected == bytes32(0) || expected != keccak256(abi.encode(lender, asset, amount, data))) {
            revert UnexpectedFlashLoan();
        }
        delete _pendingFlash;
    }

    /// @dev Runs the action carried by `data`; returns what the lender must get back.
    function _dispatch(uint256 amount, uint256 premium, bytes memory data) internal returns (uint256 owed) {
        (Action action, address user, bytes memory inner) = abi.decode(data, (Action, address, bytes));
        if (action == Action.Open) {
            (OpenParams memory p, uint256 collateralFromCapital, uint256 debtFromCapital) =
                abi.decode(inner, (OpenParams, uint256, uint256));
            address[] memory tokens = _openTokens(p);
            _out[0] = _supplyLevered(user, p, amount, collateralFromCapital, debtFromCapital, tokens);
            // nothing to give back: mode 2 turns the loan into variable debt of `user`
        } else if (action == Action.Close) {
            owed = _executeClose(user, amount, premium, abi.decode(inner, (CloseParams)));
        } else if (action == Action.SwapCollateral) {
            owed = _executeSwapCollateral(user, amount, premium, abi.decode(inner, (SwapCollateralParams)));
        } else {
            // nothing to give back: mode 2 turns the loan into variable debt of `user`
            _executeSwapDebt(user, amount, abi.decode(inner, (SwapDebtParams)));
        }
    }

    /// @inheritdoc IFlashLoanReceiver
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert CallerNotLender();
        if (initiator != address(this)) revert InitiatorNotSelf();
        if (assets.length != 1) revert InvalidFlashLoan();
        _consumeFlash(address(POOL), assets[0], amounts[0], params);
        uint256 owed = _dispatch(amounts[0], premiums[0], params);
        // the Pool pulls amount + premium once this returns (mode 0 only; owed is 0 for mode 2)
        if (owed != 0) IERC20(assets[0]).forceApprove(address(POOL), owed);
        return true;
    }

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (flashLenderKind[msg.sender] != FlashKind.Morpho) revert CallerNotLender();
        (address asset, bytes memory inner) = abi.decode(data, (address, bytes));
        _consumeFlash(msg.sender, asset, assets, inner);
        uint256 owed = _dispatch(assets, 0, inner);
        // Morpho pulls the loan back with transferFrom once this returns
        IERC20(asset).forceApprove(msg.sender, owed);
    }

    /// @inheritdoc IBalancerFlashLoanRecipient
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (flashLenderKind[msg.sender] != FlashKind.Balancer) revert CallerNotLender();
        if (tokens.length != 1) revert InvalidFlashLoan();
        _consumeFlash(msg.sender, address(tokens[0]), amounts[0], userData);
        uint256 owed = _dispatch(amounts[0], feeAmounts[0], userData);
        // the Vault checks its balance once this returns
        tokens[0].safeTransfer(msg.sender, owed);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------------------------------

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _checkHealth(address user, uint256 minHealthFactor) internal view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(user);
        if (hf < minHealthFactor) revert HealthFactorTooLow(hf, minHealthFactor);
    }

    function _permitAToken(address asset, Signature calldata s) internal {
        address aToken = POOL.getReserveData(asset).aTokenAddress;
        // a front-run of the signature only makes the permit fail; the allowance is then already in place
        try IERC20Permit(aToken).permit(msg.sender, address(this), s.value, s.deadline, s.v, s.r, s.s) {} catch {}
    }

    /// @dev Pulls `amount` aTokens of `asset` from `user` (max = all) and withdraws them to this contract.
    /// Only what this call pulled is withdrawn: aTokens someone sent to the contract stay where they are, so that
    /// a donation larger than the reserve's liquidity can never make the withdrawal (and every close) fail.
    function _pullAndWithdraw(address user, address asset, uint256 amount) internal returns (uint256 withdrawn) {
        address aToken = POOL.getReserveData(asset).aTokenAddress;
        uint256 aAmount = amount == type(uint256).max ? IERC20(aToken).balanceOf(user) : amount;
        if (aAmount == 0) revert ZeroAmount();
        uint256 aBefore = IERC20(aToken).balanceOf(address(this));
        IERC20(aToken).safeTransferFrom(user, address(this), aAmount);
        // nothing held before (the usual case): withdraw everything, which leaves no rounding dust; otherwise
        // only the balance gained, which Aave can always burn (it never exceeds the contract's balance)
        uint256 toWithdraw = aBefore == 0 ? type(uint256).max : IERC20(aToken).balanceOf(address(this)) - aBefore;
        withdrawn = POOL.withdraw(asset, toWithdraw, address(this));
    }

    /// @dev Every token an open touches: index 0 collateral, 1 debt asset, then the capital, the step outputs and
    /// the collateral's aToken (never held, listed so that it can never be a router).
    function _openTokens(OpenParams memory p) internal view returns (address[] memory tokens) {
        tokens = new address[](4 + p.capitalSteps.length + p.steps.length);
        uint256 n;
        n = _add(tokens, n, p.collateralAsset);
        n = _add(tokens, n, p.debtAsset);
        if (p.capitalAmount != 0) n = _add(tokens, n, p.capitalToken);
        for (uint256 i; i < p.capitalSteps.length; ++i) {
            n = _add(tokens, n, p.capitalSteps[i].tokenOut);
        }
        for (uint256 i; i < p.steps.length; ++i) {
            n = _add(tokens, n, p.steps[i].tokenOut);
        }
        n = _add(tokens, n, POOL.getReserveData(p.collateralAsset).aTokenAddress);
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
    }

    /// @dev Index 0 `a`, 1 `b`, then the step outputs and the aTokens of both assets.
    function _pairTokens(address a, address b, Step[] memory steps) internal view returns (address[] memory tokens) {
        tokens = new address[](4 + steps.length);
        uint256 n;
        n = _add(tokens, n, a);
        n = _add(tokens, n, b);
        for (uint256 i; i < steps.length; ++i) {
            n = _add(tokens, n, steps[i].tokenOut);
        }
        n = _add(tokens, n, POOL.getReserveData(a).aTokenAddress);
        n = _add(tokens, n, POOL.getReserveData(b).aTokenAddress);
        assembly ("memory-safe") {
            mstore(tokens, n)
        }
    }
}
