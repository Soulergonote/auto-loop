// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of Morpho Blue (morpho-org/morpho-blue, src/interfaces/IMorpho.sol) used by
/// LeverageExecutorMorpho. A market is identified by `keccak256(abi.encode(marketParams))`.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice EIP-712 message signed by `authorizer` (domain: chainId + Morpho's address, no name or version).
struct Authorization {
    address authorizer;
    address authorized;
    bool isAuthorized;
    uint256 nonce;
    uint256 deadline;
}

struct MorphoSignature {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

interface IMorpho {
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    /// @dev requires msg.sender to be `onBehalf` or authorized by it; reverts if the position ends unhealthy
    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

    /// @dev requires msg.sender to be `onBehalf` or authorized by it; exactly one of assets / shares is non-zero
    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    /// @dev exactly one of assets / shares is non-zero; pulls the assets from msg.sender
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    /// @dev free: sends `assets`, calls `onMorphoFlashLoan(assets, data)` on msg.sender, pulls `assets` back
    function flashLoan(address token, uint256 assets, bytes calldata data) external;

    function accrueInterest(MarketParams memory marketParams) external;

    function setAuthorizationWithSig(Authorization calldata authorization, MorphoSignature calldata signature) external;

    function isAuthorized(address authorizer, address authorized) external view returns (bool);

    function nonce(address authorizer) external view returns (uint256);

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    function idToMarketParams(bytes32 id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
}

/// @notice Morpho Blue oracle: price of 1 collateral asset in loan assets, scaled by
/// 1e36 * 10^(loan decimals) / 10^(collateral decimals).
interface IMorphoOracle {
    function price() external view returns (uint256);
}
