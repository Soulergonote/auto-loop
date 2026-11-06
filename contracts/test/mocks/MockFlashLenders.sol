// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMorphoFlashLoanCallback, IBalancerFlashLoanRecipient} from "../../src/interfaces/IFlashLenders.sol";

/// @notice Same flash loan flow as Morpho Blue (`Morpho.sol`): send, call back the caller, pull back. Free.
contract MockMorpho {
    using SafeERC20 for IERC20;

    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(assets != 0, "zero");
        IERC20(token).safeTransfer(msg.sender, assets);
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
    }
}

/// @notice Same flash loan flow as the Balancer v2 Vault: any caller names any recipient, the Vault sends the
/// tokens, calls the recipient back, then checks that its balance grew by amount + fee.
contract MockBalancerVault {
    using SafeERC20 for IERC20;

    uint256 public feeBps;

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function flashLoan(address recipient, IERC20[] memory tokens, uint256[] memory amounts, bytes memory userData)
        external
    {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory pre = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            fees[i] = amounts[i] * feeBps / 10_000;
            pre[i] = tokens[i].balanceOf(address(this));
            tokens[i].safeTransfer(recipient, amounts[i]);
        }
        IBalancerFlashLoanRecipient(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        for (uint256 i; i < tokens.length; ++i) {
            require(tokens[i].balanceOf(address(this)) >= pre[i] + fees[i], "BAL#602");
        }
    }
}

/// @notice A Morpho-like lender that takes the request and never calls back.
contract LazyLender {
    function flashLoan(address, uint256, bytes calldata) external {}
}

/// @notice A Balancer-like vault that takes the request and never calls back.
contract LazyBalancer {
    function flashLoan(address, IERC20[] memory, uint256[] memory, bytes memory) external {}
}
