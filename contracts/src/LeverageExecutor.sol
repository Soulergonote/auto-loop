// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAaveV3Pool, IFlashLoanReceiver, ICreditDelegationToken} from "./interfaces/IAaveV3.sol";

/// @title LeverageExecutor
/// @notice Opens and closes a leveraged Aave v3 position in a single transaction.
///
/// Open (collateral C, debt D):
///   1. pull the caller's initial C
///   2. Aave flashLoan of D in "debt" mode (interestRateMode = 2, onBehalfOf = caller): no premium,
///      Aave mints variable debt to the caller once the callback returns
///   3. in the callback: swap D -> C through a whitelisted aggregator router, check minOut,
///      supply all C on behalf of the caller
///   4. Aave checks the caller's health factor; the whole tx reverts if it is below 1
///
/// Close: flashLoan of D in mode 0 (premium paid) -> repay the caller's debt -> pull the caller's aTokens ->
///   withdraw C -> swap C -> D -> Aave pulls back the flash loan + premium -> leftovers go to the caller.
///
/// Prerequisites for the caller:
///   open:  C.approve(executor, initial)  and  variableDebtD.approveDelegation(executor, amount)
///          (or sign a delegationWithSig and use openWithSig)
///   close: aC.approve(executor, amount)  (or sign an aToken permit and use closeWithSig)
///
/// Security model:
///   - the contract only ever acts for msg.sender: the borrower, the supplier and the owner of the withdrawn
///     aTokens is always the caller, so a credit delegation or an aToken allowance cannot be used by someone else
///   - executeOperation only accepts callbacks from the Pool for flash loans this contract initiated itself
///   - aggregator calls only go to whitelisted routers, with an exact approval reset to 0 after the call,
///     and the output is checked as a balance delta against minOut
///   - the contract keeps no funds and no allowances between transactions
contract LeverageExecutor is IFlashLoanReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant MODE_NONE = 0;
    uint256 private constant MODE_VARIABLE = 2;

    IAaveV3Pool public immutable POOL;

    /// @notice Aggregator routers the contract may call. For every supported aggregator the call target is also
    /// the address that pulls the tokens (0x AllowanceHolder, 1inch AggregationRouterV6, Velora Augustus v6.2).
    mapping(address => bool) public isRouterAllowed;

    enum Action {
        Open,
        Close
    }

    /// @param router whitelisted aggregator router (quote's `to`)
    /// @param data   calldata returned by the aggregator API, quoted with this contract as taker
    /// @param minOut minimum amount of output token the swap must deliver to this contract
    struct Swap {
        address router;
        bytes data;
        uint256 minOut;
    }

    /// @param initialCollateral amount of collateral pulled from the caller (can be 0 to lever an existing position)
    /// @param debtAmount        amount of debt asset borrowed and sold; must equal the quote's sell amount
    struct OpenParams {
        address collateralAsset;
        address debtAsset;
        uint256 initialCollateral;
        uint256 debtAmount;
        Swap swap;
    }

    /// @param repayAmount          debt to repay; type(uint256).max repays the whole debt
    /// @param collateralToWithdraw collateral (aTokens) to withdraw; type(uint256).max withdraws everything
    /// @param collateralToSell     collateral sold for debt asset; must equal the quote's sell amount
    struct CloseParams {
        address collateralAsset;
        address debtAsset;
        uint256 repayAmount;
        uint256 collateralToWithdraw;
        uint256 collateralToSell;
        Swap swap;
    }

    /// @notice EIP-2612 style signature (aToken permit or debt token delegationWithSig).
    struct Signature {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event RouterSet(address indexed router, bool allowed);
    event PositionOpened(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralSupplied,
        uint256 debtBorrowed
    );
    event PositionClosed(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 collateralWithdrawn,
        uint256 collateralReturned,
        uint256 debtReturned
    );

    error ZeroAddress();
    error SameAsset();
    error ZeroAmount();
    error InvalidRouter(address router);
    error RouterNotAllowed(address router);
    error CallerNotPool();
    error InitiatorNotSelf();
    error InvalidFlashLoan();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error ExcessiveInput(uint256 spent, uint256 maxIn);
    error SellExceedsWithdrawn(uint256 toSell, uint256 withdrawn);
    error InsufficientToRepayFlashLoan(uint256 balance, uint256 owed);

    constructor(IAaveV3Pool pool, address owner_, address[] memory routers) Ownable(owner_) {
        if (address(pool) == address(0)) revert ZeroAddress();
        POOL = pool;
        for (uint256 i; i < routers.length; ++i) {
            _setRouter(routers[i], true);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function setRouter(address router, bool allowed) external onlyOwner {
        _setRouter(router, allowed);
    }

    /// @notice Recovers tokens sent to the contract by mistake. The contract holds nothing between transactions.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function _setRouter(address router, bool allowed) internal {
        if (router == address(0) || router == address(POOL) || router == address(this)) revert InvalidRouter(router);
        isRouterAllowed[router] = allowed;
        emit RouterSet(router, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Open
    // ---------------------------------------------------------------------------------------------

    function open(OpenParams calldata p) external nonReentrant {
        _open(p);
    }

    /// @notice Same as `open`, granting the credit delegation with a signature in the same transaction.
    /// A front-run of the signature only makes the inner call fail; the delegation is then already in place.
    function openWithSig(OpenParams calldata p, Signature calldata delegation) external nonReentrant {
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
        _open(p);
    }

    function _open(OpenParams calldata p) internal {
        if (p.collateralAsset == p.debtAsset) revert SameAsset();
        if (p.debtAmount == 0) revert ZeroAmount();

        uint256 debtBefore = IERC20(p.debtAsset).balanceOf(address(this));

        if (p.initialCollateral != 0) {
            IERC20(p.collateralAsset).safeTransferFrom(msg.sender, address(this), p.initialCollateral);
        }

        _flashLoan(
            p.debtAsset, p.debtAmount, MODE_VARIABLE, msg.sender, abi.encode(Action.Open, msg.sender, abi.encode(p))
        );

        // the router may not have used the whole sell amount: the borrowed remainder goes back to the caller
        uint256 debtLeft = IERC20(p.debtAsset).balanceOf(address(this)) - debtBefore;
        if (debtLeft != 0) IERC20(p.debtAsset).safeTransfer(msg.sender, debtLeft);
    }

    function _executeOpen(address user, uint256 borrowed, OpenParams memory p) internal {
        uint256 received = _swap(p.debtAsset, p.collateralAsset, borrowed, p.swap);
        uint256 toSupply = p.initialCollateral + received;

        IERC20(p.collateralAsset).forceApprove(address(POOL), toSupply);
        POOL.supply(p.collateralAsset, toSupply, user, 0);

        emit PositionOpened(user, p.collateralAsset, p.debtAsset, toSupply, borrowed);
        // returning without approving the Pool: mode 2 turns the flash loan into variable debt of `user`
    }

    // ---------------------------------------------------------------------------------------------
    // Close / deleverage
    // ---------------------------------------------------------------------------------------------

    function close(CloseParams calldata p) external nonReentrant {
        _close(p);
    }

    /// @notice Same as `close`, approving the aTokens with a permit signature in the same transaction.
    function closeWithSig(CloseParams calldata p, Signature calldata aTokenPermit) external nonReentrant {
        address aToken = POOL.getReserveData(p.collateralAsset).aTokenAddress;
        try IERC20Permit(aToken)
            .permit(
                msg.sender,
                address(this),
                aTokenPermit.value,
                aTokenPermit.deadline,
                aTokenPermit.v,
                aTokenPermit.r,
                aTokenPermit.s
            ) {}
            catch {}
        _close(p);
    }

    function _close(CloseParams calldata p) internal {
        if (p.collateralAsset == p.debtAsset) revert SameAsset();

        uint256 repayAmount = p.repayAmount;
        if (repayAmount == type(uint256).max) {
            // Aave refuses type(uint256).max when repaying on behalf of someone else: use the exact current debt
            address vDebt = POOL.getReserveData(p.debtAsset).variableDebtTokenAddress;
            repayAmount = IERC20(vDebt).balanceOf(msg.sender);
        }
        if (repayAmount == 0) revert ZeroAmount();

        uint256 collatBefore = IERC20(p.collateralAsset).balanceOf(address(this));
        uint256 debtBefore = IERC20(p.debtAsset).balanceOf(address(this));

        CloseParams memory q = p;
        q.repayAmount = repayAmount;
        _flashLoan(
            p.debtAsset, repayAmount, MODE_NONE, address(this), abi.encode(Action.Close, msg.sender, abi.encode(q))
        );

        uint256 collatLeft = IERC20(p.collateralAsset).balanceOf(address(this)) - collatBefore;
        uint256 debtLeft = IERC20(p.debtAsset).balanceOf(address(this)) - debtBefore;
        if (collatLeft != 0) IERC20(p.collateralAsset).safeTransfer(msg.sender, collatLeft);
        if (debtLeft != 0) IERC20(p.debtAsset).safeTransfer(msg.sender, debtLeft);
    }

    function _executeClose(address user, uint256 flashAmount, uint256 premium, CloseParams memory p) internal {
        // 1. repay the user's debt with the flash-loaned funds
        IERC20(p.debtAsset).forceApprove(address(POOL), flashAmount);
        uint256 repaid = POOL.repay(p.debtAsset, flashAmount, MODE_VARIABLE, user);

        // 2. take the user's aTokens (Aave checks the user's health factor on this transfer) and withdraw them
        address aToken = POOL.getReserveData(p.collateralAsset).aTokenAddress;
        uint256 aAmount =
            p.collateralToWithdraw == type(uint256).max ? IERC20(aToken).balanceOf(user) : p.collateralToWithdraw;
        if (aAmount == 0) revert ZeroAmount();
        IERC20(aToken).safeTransferFrom(user, address(this), aAmount);
        uint256 withdrawn = POOL.withdraw(p.collateralAsset, type(uint256).max, address(this));

        // 3. sell collateral for the debt asset
        if (p.collateralToSell > withdrawn) revert SellExceedsWithdrawn(p.collateralToSell, withdrawn);
        if (p.collateralToSell != 0) _swap(p.collateralAsset, p.debtAsset, p.collateralToSell, p.swap);

        // 4. let the Pool pull back the flash loan + premium
        uint256 owed = flashAmount + premium;
        uint256 bal = IERC20(p.debtAsset).balanceOf(address(this));
        if (bal < owed) revert InsufficientToRepayFlashLoan(bal, owed);
        IERC20(p.debtAsset).forceApprove(address(POOL), owed);

        emit PositionClosed(
            user, p.collateralAsset, p.debtAsset, repaid, withdrawn, withdrawn - p.collateralToSell, bal - owed
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Flash loan plumbing
    // ---------------------------------------------------------------------------------------------

    /// @dev `onBehalfOf` is only used by Aave in mode 2 (debt opened for it): always the caller of open().
    function _flashLoan(address asset, uint256 amount, uint256 mode, address onBehalfOf, bytes memory params) internal {
        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes = new uint256[](1);
        assets[0] = asset;
        amounts[0] = amount;
        modes[0] = mode;
        POOL.flashLoan(address(this), assets, amounts, modes, onBehalfOf, params, 0);
    }

    /// @inheritdoc IFlashLoanReceiver
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(POOL)) revert CallerNotPool();
        if (initiator != address(this)) revert InitiatorNotSelf();
        if (assets.length != 1) revert InvalidFlashLoan();

        (Action action, address user, bytes memory inner) = abi.decode(params, (Action, address, bytes));
        if (action == Action.Open) {
            OpenParams memory p = abi.decode(inner, (OpenParams));
            if (assets[0] != p.debtAsset || amounts[0] != p.debtAmount) revert InvalidFlashLoan();
            _executeOpen(user, amounts[0], p);
        } else {
            CloseParams memory p = abi.decode(inner, (CloseParams));
            if (assets[0] != p.debtAsset || amounts[0] != p.repayAmount) revert InvalidFlashLoan();
            _executeClose(user, amounts[0], premiums[0], p);
        }
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // Swap
    // ---------------------------------------------------------------------------------------------

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, Swap memory s)
        internal
        returns (uint256 received)
    {
        if (!isRouterAllowed[s.router]) revert RouterNotAllowed(s.router);

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(s.router, amountIn);
        (bool ok, bytes memory ret) = s.router.call(s.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        IERC20(tokenIn).forceApprove(s.router, 0);

        uint256 inAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 spent = inBefore > inAfter ? inBefore - inAfter : 0;
        if (spent > amountIn) revert ExcessiveInput(spent, amountIn);
        received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < s.minOut) revert InsufficientOutput(received, s.minOut);
    }
}
