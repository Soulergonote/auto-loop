// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of an Aave v4 Spoke that LeverageExecutorV4 reads (aave/aave-v4, ISpoke). Nothing is written to a
/// spoke directly: only the position managers below may act for a user.
interface IAaveV4Spoke {
    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags;
        uint32 dynamicConfigKey;
    }

    struct UserAccountData {
        uint256 riskPremium;
        uint256 avgCollateralFactor;
        uint256 healthFactor;
        uint256 totalCollateralValue;
        uint256 totalDebtValueRay;
        uint256 activeCollateralCount;
        uint256 borrowCount;
    }

    function getReserve(uint256 reserveId) external view returns (Reserve memory);

    /// @return enabled as collateral by the user, borrowed by the user
    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool);

    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);

    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256);

    /// @dev healthFactor is in WAD, type(uint256).max without debt
    function getUserAccountData(address user) external view returns (UserAccountData memory);

    function isPositionManager(address user, address positionManager) external view returns (bool);
}

/// @notice Aave's GiverPositionManager: supplies and repays for a user who made it one of their position managers on
/// the spoke. The tokens are pulled from the caller.
interface IAaveV4Giver {
    function isSpokeRegistered(address spoke) external view returns (bool);

    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 supplied);

    /// @dev repays at most the user's debt; refuses type(uint256).max
    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 repaid);
}

/// @notice Aave's TakerPositionManager: borrows and withdraws for a user, to the caller, within the allowance the
/// user gave the caller for that reserve of that spoke (a transaction or an EIP-712 permit).
interface IAaveV4Taker {
    struct WithdrawPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct BorrowPermit {
        address spoke;
        uint256 reserveId;
        address owner;
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    function isSpokeRegistered(address spoke) external view returns (bool);

    function approveWithdrawWithSig(WithdrawPermit calldata params, bytes calldata signature) external;

    function approveBorrowWithSig(BorrowPermit calldata params, bytes calldata signature) external;

    /// @dev called by the spender: sets its own allowance to 0
    function renounceWithdrawAllowance(address spoke, uint256 reserveId, address owner) external;

    function renounceBorrowAllowance(address spoke, uint256 reserveId, address owner) external;

    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 withdrawn);

    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        returns (uint256 shares, uint256 borrowed);

    function withdrawAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);

    function borrowAllowance(address spoke, uint256 reserveId, address owner, address spender)
        external
        view
        returns (uint256);
}
