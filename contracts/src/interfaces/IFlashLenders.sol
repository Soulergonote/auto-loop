// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Morpho Blue flash loans: free, any token the singleton holds.
/// `flashLoan` sends `assets` to the caller, calls `onMorphoFlashLoan(assets, data)` on the caller, then pulls
/// `assets` back with transferFrom (the caller must approve Morpho before returning).
interface IMorphoFlashLender {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @notice Balancer v2 Vault flash loans. The Vault sends the tokens, calls `receiveFlashLoan` on the recipient,
/// and checks that its balance grew back by amount + fee once the callback returns (the recipient transfers it).
/// Anyone can name any recipient, so the callback must check that the loan was requested by the recipient itself.
interface IBalancerVault {
    function flashLoan(address recipient, IERC20[] memory tokens, uint256[] memory amounts, bytes memory userData)
        external;
}

interface IBalancerFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
