// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockAggregatorRouter, IPriceOracle} from "./MockAggregatorRouter.sol";

/// @notice A whitelisted router whose route runs attacker-chosen code in the middle of the swap (a malicious pool
/// or hook somewhere in an aggregator route). The inner call's revert is bubbled up so tests can see why it failed.
contract AttackRouter is MockAggregatorRouter {
    address public target;
    bytes public payload;

    constructor(IPriceOracle oracle_) MockAggregatorRouter(oracle_) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function swapAndCall(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        returns (uint256 out)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        out = quote(tokenIn, tokenOut, amountIn);
        IERC20(tokenOut).transfer(recipient, out);
    }
}
