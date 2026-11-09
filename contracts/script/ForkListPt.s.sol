// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Script, console} from "forge-std/Script.sol";

/**
 * FORK TESTS ONLY. Lists live Pendle PTs on an anvil fork of Aave v3 Ethereum Core, the way Aave lists them on mainnet
 * (LTV 0 outside eMode, one eMode per PT family, a linear-discount price feed), so that the app's PT loops can be tested
 * while no PT is active on the real market. Run with the Aave ACL admin unlocked:
 *   forge script script/ForkListPt.s.sol --rpc-url http://127.0.0.1:8545 --unlocked --sender <ACL admin> --broadcast
 * Another network: POOL=<Aave pool> REF=<any reserve> BORROW="usdc,usdt" PTS="pt1,pt2" (see app/e2e/fork.sh, NET=arbitrum).
 * PTS="pt1,pt2" picks the PTs (default PT-reUSDe-10DEC2026 and PT-sUSN-22JUL2027), SPLIT=1 puts the second PT in its own
 * eMode only (renewal through close + eMode change + open instead of one swapCollateral). DISCOUNTS="1500,800" sets each
 * PT's yearly oracle discount in bps (default 15 %); far from the Pendle implied rate, every buy reads as a loss.
 */

interface IProvider {
    function getPoolConfigurator() external view returns (address);
    function getACLManager() external view returns (address);
    function getPriceOracle() external view returns (address);
}

interface IPoolLite {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getReserveAToken(address) external view returns (address);
    function getReserveVariableDebtToken(address) external view returns (address);
    function getEModeCategoryCollateralConfig(uint8) external view returns (uint16, uint16, uint16);
}

interface IACL {
    function addPoolAdmin(address) external;
}

interface IOracle {
    function setAssetSources(address[] calldata assets, address[] calldata sources) external;
}

interface IConfigurator {
    struct InitReserveInput {
        address aTokenImpl;
        address variableDebtTokenImpl;
        address underlyingAsset;
        string aTokenName;
        string aTokenSymbol;
        string variableDebtTokenName;
        string variableDebtTokenSymbol;
        bytes params;
        bytes interestRateData;
    }

    function initReserves(InitReserveInput[] calldata input) external;
    function setSupplyCap(address asset, uint256 cap) external;
    function setEModeCategory(uint8 id, uint16 ltv, uint16 lt, uint16 bonus, string calldata label, bool isolated) external;
    function setAssetCollateralInEMode(address asset, uint8 id, bool on) external;
    function setAssetBorrowableInEMode(address asset, uint8 id, bool on) external;
}

interface IPt {
    function expiry() external view returns (uint256);
    function symbol() external view returns (string memory);
}

/// Same read surface as Aave's PendlePriceCapAdapter: price = 1 USD x (1 - discount x time left), 1 USD after maturity.
contract PtLinearDiscountFeed {
    uint256 public immutable MATURITY;
    uint256 public immutable discountRatePerYear;
    string public description;

    constructor(uint256 maturity, uint256 discount, string memory desc) {
        MATURITY = maturity;
        discountRatePerYear = discount;
        description = desc;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestAnswer() public view returns (int256) {
        if (block.timestamp >= MATURITY) return 1e8;
        uint256 off = (discountRatePerYear * (MATURITY - block.timestamp)) / 365 days;
        return int256((1e8 * (1e18 - off)) / 1e18);
    }
}

contract ForkListPt is Script {
    /// Aave Core Ethereum by default; POOL=0x… for another network (then REF, BORROW and PTS too)
    IPoolLite POOL;
    /// reference reserve whose token implementations are reused (default PT-srUSDe-22OCT2026)
    address REF;
    /// assets borrowable against the PTs in their eMode (default USDC, USDT, USDe of Ethereum)
    address[] borrow;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        POOL = IPoolLite(vm.envOr("POOL", address(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)));
        REF = vm.envOr("REF", address(0x59bC9FaE5D62B19d4f8d07D758047aCb9EE19d34));
        address[] memory defaultBorrow = new address[](3);
        defaultBorrow[0] = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // USDC
        defaultBorrow[1] = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // USDT
        defaultBorrow[2] = 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3; // USDe
        borrow = vm.envOr("BORROW", ",", defaultBorrow);
        address[] memory pts = vm.envOr("PTS", ",", _defaults());
        bool split = vm.envOr("SPLIT", false);
        uint256[] memory discounts = vm.envOr("DISCOUNTS", ",", new uint256[](0));
        IProvider provider = IProvider(POOL.ADDRESSES_PROVIDER());
        IConfigurator cf = IConfigurator(provider.getPoolConfigurator());
        address aImpl = address(uint160(uint256(vm.load(POOL.getReserveAToken(REF), IMPL_SLOT))));
        address dImpl = address(uint160(uint256(vm.load(POOL.getReserveVariableDebtToken(REF), IMPL_SLOT))));

        vm.startBroadcast();
        IACL(provider.getACLManager()).addPoolAdmin(msg.sender);
        IConfigurator.InitReserveInput[] memory input = new IConfigurator.InitReserveInput[](pts.length);
        address[] memory feeds = new address[](pts.length);
        for (uint256 i; i < pts.length; ++i) {
            string memory sym = IPt(pts[i]).symbol();
            input[i] = IConfigurator.InitReserveInput({
                aTokenImpl: aImpl,
                variableDebtTokenImpl: dImpl,
                underlyingAsset: pts[i],
                aTokenName: string.concat("Aave Ethereum ", sym),
                aTokenSymbol: string.concat("aEth", sym),
                variableDebtTokenName: string.concat("Aave Ethereum Variable Debt ", sym),
                variableDebtTokenSymbol: string.concat("variableDebtEth", sym),
                params: "",
                // borrowing stays disabled: the rate curve is never used
                interestRateData: abi.encode(uint16(4500), uint32(0), uint32(1000), uint32(30000))
            });
            // Aave sets the discount near the PT's implied rate; DISCOUNTS="1500,800" (bps, one per PT) does the same here
            uint256 discount = i < discounts.length ? discounts[i] * 1e14 : 0.15e18;
            feeds[i] = address(new PtLinearDiscountFeed(IPt(pts[i]).expiry(), discount, string.concat(sym, " linear discount (fork)")));
        }
        cf.initReserves(input);
        IOracle(provider.getPriceOracle()).setAssetSources(pts, feeds);

        uint8 shared = _freeEMode(0);
        cf.setEModeCategory(shared, 9000, 9200, 10300, "PT fork Stablecoins", false);
        _borrowables(cf, shared);
        for (uint256 i; i < pts.length; ++i) {
            cf.setSupplyCap(pts[i], 50_000_000);
            if (!split || i == 0) cf.setAssetCollateralInEMode(pts[i], shared, true);
        }
        console.log("eMode", shared);
        if (split && pts.length > 1) {
            uint8 own = _freeEMode(shared);
            cf.setEModeCategory(own, 9000, 9200, 10300, "PT fork 2 Stablecoins", false);
            _borrowables(cf, own);
            for (uint256 i = 1; i < pts.length; ++i) {
                cf.setAssetCollateralInEMode(pts[i], own, true);
            }
            console.log("eMode", own);
        }
        vm.stopBroadcast();
    }

    function _borrowables(IConfigurator cf, uint8 id) internal {
        for (uint256 i; i < borrow.length; ++i) {
            cf.setAssetBorrowableInEMode(borrow[i], id, true);
        }
    }

    function _freeEMode(uint8 after_) internal view returns (uint8) {
        for (uint8 id = after_ + 1; id < 255; ++id) {
            (, uint16 lt,) = POOL.getEModeCategoryCollateralConfig(id);
            if (lt == 0) return id;
        }
        revert("no free eMode id");
    }

    function _defaults() internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = 0x2aE4f59E500b6ddEB88c480edf277eDA54A00205; // PT-reUSDe-10DEC2026
        a[1] = 0x6A0EfC272E8Dd4fc5AFfEA17376DCf107CbcBC0f; // PT-sUSN-22JUL2027
    }
}
