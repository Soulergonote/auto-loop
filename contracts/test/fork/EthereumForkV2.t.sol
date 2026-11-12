// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

interface IAaveEMode {
    function setUserEMode(uint8 categoryId) external;
}

interface IAaveOracleEth {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IDebtTokenEth {
    function approveDelegation(address delegatee, uint256 amount) external;
}

/// @notice Curve stableswap-ng pool (USDe/USDC): pulls `dx` from the caller, sends to `receiver`.
interface ICurveNg {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy, address receiver) external returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
}

/// @notice Pendle Router v4 (proxy 0x8888...F946, same address on every chain), structs as in IPAllActionTypeV3.
interface IPendleRouter {
    struct SwapData {
        uint8 swapType;
        address extRouter;
        bytes extCalldata;
        bool needScale;
    }

    struct TokenOutput {
        address tokenOut;
        uint256 minTokenOut;
        address tokenRedeemSy;
        address pendleSwap;
        SwapData swapData;
    }

    function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256 netTokenOut, uint256 netSyInterm);
}

/// @notice v2 against Aave v3 Core on Ethereum, where USDe and sUSDe have a base LTV of 0 and are collateral only
/// inside an eMode, exactly like Pendle PTs; with the Pendle router (change 7: just a whitelisted router) and the
/// real Morpho Blue and Balancer v2 flash lenders.
///   ETH_RPC_URL=... forge test --match-contract EthereumForkV2Test -vv
/// Skipped when ETH_RPC_URL is not set.
contract EthereumForkV2Test is Test {
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2; // Aave v3 Core
    address constant ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant PENDLE_ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;
    address constant CURVE_USDE_USDC = 0x02950460E2b9529D0E00284A5fA2d7bDF3fA4d72; // coins: 0 USDe, 1 USDC

    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDE = 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3;
    address constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;
    // PT-srUSDe-22OCT2026 (matured) and its YT; its SY redeems to sUSDe
    address constant PT = 0x59bC9FaE5D62B19d4f8d07D758047aCb9EE19d34;
    address constant YT = 0xfe6040719Cca36AeB85E352F48fE956057728814;

    uint8 constant EMODE_SUSDE_STABLES = 2; // sUSDe + USDe collateral (LTV 90 %), USDC/USDT borrowable

    LeverageExecutorV2 ex;
    address aUSDE;
    address aSUSDE;
    address aUSDC;
    address vUSDC;
    address user = makeAddr("user");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        address[] memory routers = new address[](5);
        routers[0] = PENDLE_ROUTER;
        routers[1] = CURVE_USDE_USDC;
        routers[2] = 0x6A000F20005980200259B80c5102003040001068; // Velora Augustus v6.2
        routers[3] = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5; // KyberSwap MetaAggregationRouterV2
        routers[4] = 0x111111125421cA6dc452d289314280a0f8842A65; // 1inch v6
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](2);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, MORPHO);
        lenders[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, BALANCER_VAULT);
        // a fresh address: the default first deployment address holds dust on mainnets
        address at = address(uint160(uint256(keccak256("auto-loop.executor-v2.fork"))));
        deployCodeTo("LeverageExecutorV2.sol:LeverageExecutorV2", abi.encode(POOL, routers, lenders), at);
        ex = LeverageExecutorV2(at);

        aUSDE = IAaveV3Pool(POOL).getReserveData(USDE).aTokenAddress;
        aSUSDE = IAaveV3Pool(POOL).getReserveData(SUSDE).aTokenAddress;
        aUSDC = IAaveV3Pool(POOL).getReserveData(USDC).aTokenAddress;
        vUSDC = IAaveV3Pool(POOL).getReserveData(USDC).variableDebtTokenAddress;
    }

    function _ltv() internal view returns (uint256 ltv) {
        (,,,, ltv,) = IAaveV3Pool(POOL).getUserAccountData(user);
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,, hf) = IAaveV3Pool(POOL).getUserAccountData(user);
    }

    function _one(SwapExecutorBase.Step memory s) internal pure returns (SwapExecutorBase.Step[] memory a) {
        a = new SwapExecutorBase.Step[](1);
        a[0] = s;
    }

    function _curve(bool usdcToUsde, uint256 amountIn, uint256 tolBps)
        internal
        view
        returns (SwapExecutorBase.Step memory)
    {
        (int128 i, int128 j) = usdcToUsde ? (int128(1), int128(0)) : (int128(0), int128(1));
        uint256 dy = ICurveNg(CURVE_USDE_USDC).get_dy(i, j, amountIn);
        return SwapExecutorBase.Step({
            router: CURVE_USDE_USDC,
            tokenOut: usdcToUsde ? USDE : USDC,
            data: abi.encodeCall(ICurveNg.exchange, (i, j, amountIn, 0, address(ex))),
            minOut: dy * (10_000 - tolBps) / 10_000
        });
    }

    function _assertClean() internal view {
        address[7] memory tokens = [USDC, USDE, SUSDE, PT, aUSDE, aSUSDE, aUSDC];
        address[5] memory spenders = [PENDLE_ROUTER, CURVE_USDE_USDC, POOL, MORPHO, BALANCER_VAULT];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(address(ex)), 0, "executor balance");
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(IERC20(tokens[i]).allowance(address(ex), spenders[j]), 0, "executor allowance");
            }
        }
    }

    /// @dev 5x USDe/USDC from `capital` USDC, everything sold through Curve
    function _openUsdeLoop(uint256 capital) internal returns (LeverageExecutorV2.OpenParams memory p) {
        uint256 debt = capital * 4;
        deal(USDC, user, capital);
        vm.startPrank(user);
        IERC20(USDC).approve(address(ex), capital);
        IDebtTokenEth(vUSDC).approveDelegation(address(ex), debt);
        vm.stopPrank();
        p.collateralAsset = USDE;
        p.debtAsset = USDC;
        p.capitalToken = USDC;
        p.capitalAmount = capital;
        p.debtAmount = debt;
        p.steps = _one(_curve(true, capital + debt, 30));
        p.guard = LeverageExecutorV2.Guard(1.05e18, block.timestamp);
    }

    // ---------------------------------------------------------------------------------------------

    function test_forkEthV2_usdeLoop5x_eModeOnlyCollateral_closeViaMorpho() public {
        vm.prank(user);
        IAaveEMode(POOL).setUserEMode(EMODE_SUSDE_STABLES);
        LeverageExecutorV2.OpenParams memory p = _openUsdeLoop(10_000e6);
        vm.prank(user);
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.open(p);
        emit log_named_decimal_uint("USDe supplied", supplied, 18);
        emit log_named_decimal_uint("health factor", hf, 18);
        assertEq(borrowed, 40_000e6);
        assertEq(_ltv(), 90_00, "USDe (base LTV 0) counts at the eMode LTV once supplied by the executor");
        assertGt(supplied, 49_500e18);
        _assertClean();

        vm.warp(block.timestamp + 1 days);
        uint256 debt = IERC20(vUSDC).balanceOf(user);
        uint256 toSell = debt * 1e12 * 1005 / 1000; // USDe ~ 1 USDC, 0.5 % buffer
        vm.startPrank(user);
        IERC20(aUSDE).approve(address(ex), type(uint256).max);
        LeverageExecutorV2.CloseResult memory r = ex.close(
            LeverageExecutorV2.CloseParams({
                collateralAsset: USDE,
                debtAsset: USDC,
                repayAmount: type(uint256).max,
                collateralToWithdraw: type(uint256).max,
                collateralToSell: toSell,
                steps: _one(_curve(false, toSell, 30)),
                flashLender: MORPHO,
                guard: LeverageExecutorV2.Guard(0, block.timestamp)
            })
        );
        vm.stopPrank();
        emit log_named_decimal_uint("USDe back", r.collateralReturned, 18);
        emit log_named_decimal_uint("USDC back", r.debtReturned, 6);
        assertEq(r.flashPremium, 0);
        assertEq(IERC20(vUSDC).balanceOf(user), 0);
        assertEq(IERC20(aUSDE).balanceOf(user), 0);
        _assertClean();
    }

    function test_forkEthV2_usdeLoop_partialCloseViaBalancer() public {
        vm.prank(user);
        IAaveEMode(POOL).setUserEMode(EMODE_SUSDE_STABLES);
        LeverageExecutorV2.OpenParams memory p = _openUsdeLoop(10_000e6);
        vm.prank(user);
        ex.open(p);
        uint256 hfBefore = _hf();

        uint256 repay = 20_000e6;
        uint256 toSell = repay * 1e12 * 1005 / 1000;
        vm.startPrank(user);
        IERC20(aUSDE).approve(address(ex), toSell);
        LeverageExecutorV2.CloseResult memory r = ex.close(
            LeverageExecutorV2.CloseParams({
                collateralAsset: USDE,
                debtAsset: USDC,
                repayAmount: repay,
                collateralToWithdraw: toSell,
                collateralToSell: toSell,
                steps: _one(_curve(false, toSell, 30)),
                flashLender: BALANCER_VAULT,
                guard: LeverageExecutorV2.Guard(hfBefore, block.timestamp)
            })
        );
        vm.stopPrank();
        emit log_named_decimal_uint("Balancer fee", r.flashPremium, 6);
        emit log_named_decimal_uint("HF after", r.healthFactor, 18);
        assertEq(r.debtRepaid, repay);
        assertGt(r.healthFactor, hfBefore);
        _assertClean();
    }

    function test_revert_forkEthV2_usdeLoop_outsideEMode() public {
        // base LTV 0: without the eMode the supplied USDe backs nothing and Aave refuses the borrow
        LeverageExecutorV2.OpenParams memory p = _openUsdeLoop(10_000e6);
        vm.expectRevert();
        vm.prank(user);
        ex.open(p);
    }

    function test_forkEthV2_maturedPtAsCapital_redeemedThroughPendle() public {
        // a matured PT in the wallet becomes sUSDe collateral in one call: capital PT -> Pendle redeem -> sUSDe
        vm.prank(user);
        IAaveEMode(POOL).setUserEMode(EMODE_SUSDE_STABLES);
        uint256 ptAmount = 10_000e18;
        deal(PT, user, ptAmount);
        uint256 expected =
            ptAmount * IAaveOracleEth(ORACLE).getAssetPrice(USDE) / IAaveOracleEth(ORACLE).getAssetPrice(SUSDE);

        IPendleRouter.TokenOutput memory out = IPendleRouter.TokenOutput({
            tokenOut: SUSDE,
            minTokenOut: 0,
            tokenRedeemSy: SUSDE,
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData(0, address(0), "", false)
        });
        LeverageExecutorV2.OpenParams memory p;
        p.collateralAsset = SUSDE;
        p.debtAsset = USDC;
        p.capitalToken = PT;
        p.capitalAmount = ptAmount;
        p.capitalSteps = _one(
            SwapExecutorBase.Step({
                router: PENDLE_ROUTER,
                tokenOut: SUSDE,
                data: abi.encodeCall(IPendleRouter.redeemPyToToken, (address(ex), YT, ptAmount, out)),
                minOut: expected * 97 / 100
            })
        );
        p.guard = LeverageExecutorV2.Guard(0, block.timestamp);

        vm.startPrank(user);
        IERC20(PT).approve(address(ex), ptAmount);
        (uint256 supplied,,) = ex.open(p);
        vm.stopPrank();
        emit log_named_decimal_uint("sUSDe supplied", supplied, 18);
        emit log_named_decimal_uint("sUSDe at the oracle", expected, 18);
        assertEq(IERC20(PT).balanceOf(user), 0);
        assertApproxEqAbs(IERC20(aSUSDE).balanceOf(user), supplied, 2);
        assertEq(_ltv(), 90_00, "sUSDe enabled as collateral in the eMode");
        _assertClean();
    }
}
