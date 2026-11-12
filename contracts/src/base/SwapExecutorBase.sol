// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SwapExecutorBase
/// @notice Swap machinery shared by LeverageExecutorV2 (Aave v3) and LeverageExecutorMorpho (Morpho Blue): chains of
/// 1 to MAX_STEPS aggregator calls to whitelisted routers, each with an exact approval reset to 0 afterwards, its
/// input capped and its output checked as a balance delta against its own minimum; and the leftover sweep that
/// sends back to the caller every balance the contract gained during a call.
/// Routers are whitelisted once, by the deriving contract's constructor; there is no other way to add one.
abstract contract SwapExecutorBase {
    using SafeERC20 for IERC20;

    /// @notice Longest swap chain accepted.
    uint256 public constant MAX_STEPS = 4;

    /// @notice Aggregator routers the contract may call (quote's `to`), fixed at deployment.
    mapping(address => bool) public isRouterAllowed;

    /// @param router   whitelisted router (the quote's `to`)
    /// @param tokenOut token this step must deliver
    /// @param data     calldata from the aggregator, quoted with this contract as taker and recipient
    /// @param minOut   minimum amount of tokenOut this step must deliver
    struct Step {
        address router;
        address tokenOut;
        bytes data;
        uint256 minOut;
    }

    event RouterAllowed(address indexed router);
    event Swapped(
        address indexed user,
        address indexed router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error ZeroAddress();
    error SameAsset();
    error Expired(uint256 deadline);
    error InvalidRouter(address router);
    error RouterNotAllowed(address router);
    error InvalidSteps();
    error WrongFinalToken(address tokenOut, address expected);
    error InsufficientOutput(uint256 received, uint256 minOut);
    error ExcessiveInput(uint256 spent, uint256 maxIn);

    /// @dev whitelists a router for good; the deriving constructor checks it first
    function _allowRouter(address router) internal {
        isRouterAllowed[router] = true;
        emit RouterAllowed(router);
    }

    /// @dev Runs `steps` from `amountIn` of `tokenIn`; each step's input is everything the previous one delivered.
    function _swapChain(
        address user,
        address tokenIn,
        uint256 amountIn,
        Step[] memory steps,
        address tokenOut,
        address[] memory tokens
    ) internal returns (uint256 amount) {
        uint256 n = steps.length;
        if (n == 0 || n > MAX_STEPS) revert InvalidSteps();
        if (steps[n - 1].tokenOut != tokenOut) revert WrongFinalToken(steps[n - 1].tokenOut, tokenOut);
        amount = amountIn;
        address tin = tokenIn;
        for (uint256 i; i < n; ++i) {
            Step memory s = steps[i];
            if (s.tokenOut == tin) revert SameAsset();
            amount = _swap(user, tin, amount, s, tokens);
            tin = s.tokenOut;
        }
    }

    function _swap(address user, address tokenIn, uint256 amountIn, Step memory s, address[] memory tokens)
        internal
        returns (uint256 received)
    {
        if (!isRouterAllowed[s.router]) revert RouterNotAllowed(s.router);
        // defense in depth: a call to a token contract could spend allowances users gave to this contract
        for (uint256 i; i < tokens.length; ++i) {
            if (s.router == tokens[i]) revert InvalidRouter(s.router);
        }

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(s.tokenOut).balanceOf(address(this));

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
        received = IERC20(s.tokenOut).balanceOf(address(this)) - outBefore;
        if (received < s.minOut) revert InsufficientOutput(received, s.minOut);
        emit Swapped(user, s.router, tokenIn, s.tokenOut, spent, received);
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert Expired(deadline);
    }

    function _add(address[] memory set, uint256 n, address token) internal pure returns (uint256) {
        if (token == address(0)) revert ZeroAddress();
        for (uint256 i; i < n; ++i) {
            if (set[i] == token) return n;
        }
        set[n] = token;
        return n + 1;
    }

    function _balances(address[] memory tokens) internal view returns (uint256[] memory bals) {
        bals = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            bals[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    /// @dev Sends `user` everything this call left in the contract, token by token.
    function _sweep(address[] memory tokens, uint256[] memory before, address user)
        internal
        returns (uint256[] memory sent)
    {
        sent = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > before[i]) {
                sent[i] = bal - before[i];
                IERC20(tokens[i]).safeTransfer(user, sent[i]);
            }
        }
    }
}
