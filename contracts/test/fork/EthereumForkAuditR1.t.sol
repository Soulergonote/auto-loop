// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {IMorpho, MarketParams} from "../../src/interfaces/IMorpho.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";

interface IMorphoAdmin {
    function createMarket(MarketParams memory marketParams) external;
    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256, uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
}

/// @dev fixed price oracle: 1 WETH = 3 000 DAI (Morpho scale 1e36, both tokens 18 decimals)
contract FixedOracle {
    function price() external pure returns (uint256) {
        return 3000e36;
    }
}

/// @notice Internal audit R1 (2026-11-25), finding L-01: LeverageExecutorMorpho.refinance from an Aave v3 pool to Morpho
/// withdrew exactly the aTokens it pulled. On a pool that rounds aToken transfers and burns half up (SparkLend, Aave
/// v3.0 to v3.3), the aTokens received can be worth 1 wei less than the amount asked, and the withdrawal reverted
/// for a few percent of the amounts. Real SparkLend and Morpho Blue on an Ethereum fork, WETH collateral, DAI debt.
///   ETH_RPC_URL=... forge test --match-contract EthereumForkAuditR1Test -vv
/// Skipped when ETH_RPC_URL is not set.
contract EthereumForkAuditR1Test is Test {
    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IAaveV3Pool constant SPARK = IAaveV3Pool(0xC13e21B648A5Ee794902342038FF3aDAB66BE987);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant IRM = 0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC; // AdaptiveCurveIrm

    LeverageExecutorMorpho ex;
    MarketParams m;
    address aWeth;
    bool noFork;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(rpc);
        aWeth = SPARK.getReserveData(WETH).aTokenAddress;
        address[] memory pools = new address[](1);
        pools[0] = address(SPARK);
        ex = new LeverageExecutorMorpho(MORPHO, new address[](0), pools);

        // a WETH / DAI Morpho market with 1 000 000 DAI to lend
        m = MarketParams(DAI, WETH, address(new FixedOracle()), IRM, 0.86e18);
        IMorphoAdmin(address(MORPHO)).createMarket(m);
        deal(DAI, address(this), 1_000_000e18);
        IERC20(DAI).approve(address(MORPHO), type(uint256).max);
        IMorphoAdmin(address(MORPHO)).supply(m, 1_000_000e18, 0, address(this), "");
    }

    function _user(uint256 i, uint256 weth) internal returns (address u) {
        u = address(uint160(0xA0D17000 + i));
        deal(WETH, u, weth);
        vm.startPrank(u);
        IERC20(WETH).approve(address(SPARK), weth);
        SPARK.supply(WETH, weth, u, 0);
        SPARK.borrow(DAI, 1000e18, 2, 0, u);
        IERC20(aWeth).approve(address(ex), type(uint256).max);
        IMorphoAdmin(address(MORPHO)).setAuthorization(address(ex), true);
        vm.stopPrank();
    }

    function _params() internal view returns (LeverageExecutorMorpho.RefinanceParams memory p) {
        p.pool = address(SPARK);
        p.market = m;
        p.toMorpho = true;
        p.debtAmount = type(uint256).max;
        p.collateralAmount = type(uint256).max;
        p.guard = LeverageExecutorMorpho.Guard(1.1e18, block.timestamp + 1 hours);
    }

    /// 40 partial moves of slightly different sizes (the whole debt, part of the collateral) all go from SparkLend to
    /// Morpho, whatever the rounding. On the audited code a few of them reverted in Pool.withdraw.
    function test_L01_sparkToMorpho_everyPartialAmountMoves() public {
        if (noFork) return;
        for (uint256 i = 1; i <= 40; ++i) {
            address u = _user(i, 2e18);
            uint256 part = 1e18 + i * 1e15 + i * 7919;
            LeverageExecutorMorpho.RefinanceParams memory p = _params();
            p.collateralAmount = part;
            vm.prank(u);
            LeverageExecutorMorpho.RefinanceResult memory r = ex.refinance(p);
            assertApproxEqAbs(r.collateralMoved, part, 1, "collateral moved");
            (, uint128 shares, uint128 coll) = MORPHO.position(keccak256(abi.encode(m)), u);
            assertGt(shares, 0, "Morpho debt");
            assertEq(coll, r.collateralMoved, "Morpho collateral");
            assertEq(IERC20(aWeth).balanceOf(address(ex)), 0, "aTokens left in the executor");
            assertEq(IERC20(WETH).balanceOf(address(ex)), 0, "WETH left in the executor");
        }
    }

    /// The whole position (what the app sends) moves too.
    function test_L01_sparkToMorpho_wholePosition() public {
        if (noFork) return;
        address u = _user(1, 3e18 + 7919);
        uint256 supplied = IERC20(aWeth).balanceOf(u);
        vm.prank(u);
        LeverageExecutorMorpho.RefinanceResult memory r = ex.refinance(_params());
        assertApproxEqAbs(r.collateralMoved, supplied, 1, "collateral moved");
        assertLe(IERC20(aWeth).balanceOf(u), 1, "aTokens left on Spark");
        assertEq(IERC20(aWeth).balanceOf(address(ex)), 0, "aTokens left in the executor");
    }

    /// aTokens donated to the executor are never withdrawn with the caller's (same rule as LeverageExecutorV2, L-01
    /// of the V2 audit), and the caller's own move still succeeds.
    function test_L01_donationStaysAndMoveSucceeds() public {
        if (noFork) return;
        address d = _user(99, 5e18);
        vm.prank(d);
        IERC20(aWeth).transfer(address(ex), 1e18);
        uint256 donated = IERC20(aWeth).balanceOf(address(ex));
        address u = _user(1, 2e18 + 12345);
        vm.prank(u);
        ex.refinance(_params());
        assertApproxEqAbs(IERC20(aWeth).balanceOf(address(ex)), donated, 1, "donation untouched");
        assertEq(IERC20(WETH).balanceOf(address(ex)), 0, "WETH left in the executor");
    }
}
