// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MarketParams} from "../../src/interfaces/IMorpho.sol";

contract TestToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory symbol, uint8 decimals_) ERC20(symbol, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice USD prices (8 decimals) for MockAggregatorRouter.
contract UsdPrices {
    mapping(address => uint256) public getAssetPrice;

    function set(address asset, uint256 price) external {
        getAssetPrice[asset] = price;
    }
}

/// @notice Morpho Blue oracle with a settable price (1e36 scale, adjusted for decimals).
contract MockMorphoOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function set(uint256 price_) external {
        price = price_;
    }
}

/// @notice Morpho Blue IRM with a fixed borrow rate per second.
contract FixedRateIrm {
    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    uint256 public immutable RATE;

    constructor(uint256 rate) {
        RATE = rate;
    }

    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return RATE;
    }

    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return RATE;
    }
}
