// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IPriceOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

/// @notice Stand-in for an aggregator router: pulls `amountIn` from the caller (like 1inch / Velora / 0x
/// AllowanceHolder do) and pays out at the Aave oracle price minus a configurable slippage.
/// Must be pre-funded with the output tokens.
contract MockAggregatorRouter {
    IPriceOracle public immutable oracle;
    uint256 public slippageBps;
    /// @notice when > 0, only this share of amountIn is actually pulled (router "using less" than quoted)
    uint256 public useInputBps;

    constructor(IPriceOracle oracle_) {
        oracle = oracle_;
    }

    function setSlippageBps(uint256 bps) external {
        slippageBps = bps;
    }

    function setUseInputBps(uint256 bps) external {
        useInputBps = bps;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 valueIn = amountIn * oracle.getAssetPrice(tokenIn) / 10 ** IERC20Metadata(tokenIn).decimals();
        uint256 out = valueIn * 10 ** IERC20Metadata(tokenOut).decimals() / oracle.getAssetPrice(tokenOut);
        return out * (10_000 - slippageBps) / 10_000;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        returns (uint256 out)
    {
        if (useInputBps != 0) amountIn = amountIn * useInputBps / 10_000;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = quote(tokenIn, tokenOut, amountIn);
        IERC20(tokenOut).transfer(recipient, out);
    }

    /// @notice Malicious route: tries to pull more than the approved amount.
    function swapGreedy(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn + 1);
        IERC20(tokenOut).transfer(recipient, quote(tokenIn, tokenOut, amountIn));
    }
}
