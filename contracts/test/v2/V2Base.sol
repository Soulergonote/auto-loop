// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Real Aave v3 (aave-v3-origin, v3.6) deployed locally by the official test procedures
import {TestnetProcedures} from "aave-v3-origin/tests/utils/TestnetProcedures.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {MockMorpho, MockBalancerVault} from "../mocks/MockFlashLenders.sol";

interface IDebtToken {
    function approveDelegation(address delegatee, uint256 amount) external;
    function borrowAllowance(address fromUser, address toUser) external view returns (uint256);
    function name() external view returns (string memory);
}

/// @notice Shared setup for the v2 tests: local Aave v3.6 with WETH ($1800), WBTC ($27000), USDX ($1), an
/// oracle-priced mock aggregator, a Morpho-like and a Balancer-like flash lender, and a v2 executor.
abstract contract V2Base is TestnetProcedures {
    LeverageExecutorV2 internal executor;
    MockAggregatorRouter internal router;
    MockMorpho internal morpho;
    MockBalancerVault internal balancer;
    IAaveV3Pool internal pool;
    IPriceOracle internal oracle;

    address internal WETH;
    address internal USDX;
    address internal WBTC;
    address internal aWETH;
    address internal aWBTC;
    address internal aUSDX;
    address internal vUSDX;
    address internal vWETH;

    address internal attacker = makeAddr("attacker");

    uint256 internal constant MAX = type(uint256).max;

    function setUp() public virtual {
        initTestEnvironment();
        pool = IAaveV3Pool(report.poolProxy);
        oracle = IPriceOracle(report.aaveOracle);
        WETH = tokenList.weth;
        USDX = tokenList.usdx;
        WBTC = tokenList.wbtc;
        aWETH = pool.getReserveData(WETH).aTokenAddress;
        aWBTC = pool.getReserveData(WBTC).aTokenAddress;
        aUSDX = pool.getReserveData(USDX).aTokenAddress;
        vUSDX = pool.getReserveData(USDX).variableDebtTokenAddress;
        vWETH = pool.getReserveData(WETH).variableDebtTokenAddress;

        // pool liquidity (borrowable and flash-loanable)
        deal(USDX, carol, 10_000_000e6);
        deal(WBTC, carol, 1_000e8);
        deal(WETH, carol, 10_000e18);
        vm.startPrank(carol);
        contracts.poolProxy.supply(USDX, 10_000_000e6, carol, 0);
        contracts.poolProxy.supply(WBTC, 1_000e8, carol, 0);
        contracts.poolProxy.supply(WETH, 10_000e18, carol, 0);
        vm.stopPrank();

        router = new MockAggregatorRouter(oracle);
        _fund(address(router));
        morpho = new MockMorpho();
        _fund(address(morpho));
        balancer = new MockBalancerVault();
        _fund(address(balancer));

        executor = _deploy(address(router));
        vm.label(address(executor), "executor");
        vm.label(address(router), "router");
        vm.label(address(morpho), "morpho");
        vm.label(address(balancer), "balancer");
    }

    function _fund(address who) internal {
        deal(WETH, who, 100_000e18);
        deal(USDX, who, 100_000_000e6);
        deal(WBTC, who, 10_000e8);
    }

    function _deploy(address r) internal returns (LeverageExecutorV2) {
        address[] memory routers = new address[](1);
        routers[0] = r;
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](2);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, address(morpho));
        lenders[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, address(balancer));
        return new LeverageExecutorV2(pool, routers, lenders);
    }

    // ---------------------------------------------------------------------------------------------
    // builders
    // ---------------------------------------------------------------------------------------------

    function _guard() internal view returns (LeverageExecutorV2.Guard memory) {
        return LeverageExecutorV2.Guard({minHealthFactor: 0, deadline: block.timestamp + 1 hours});
    }

    /// @dev one swap step through `router`, minimum = quote minus `tolBps`
    function _step(address tokenIn, address tokenOut, uint256 amountIn, uint256 tolBps)
        internal
        view
        returns (LeverageExecutorV2.Step memory)
    {
        return _stepVia(address(router), tokenIn, tokenOut, amountIn, tolBps);
    }

    function _stepVia(address r, address tokenIn, address tokenOut, uint256 amountIn, uint256 tolBps)
        internal
        view
        returns (LeverageExecutorV2.Step memory)
    {
        return LeverageExecutorV2.Step({
            router: r,
            tokenOut: tokenOut,
            data: abi.encodeCall(MockAggregatorRouter.swap, (tokenIn, tokenOut, amountIn, address(executor))),
            minOut: router.quote(tokenIn, tokenOut, amountIn) * (10_000 - tolBps) / 10_000
        });
    }

    function _one(LeverageExecutorV2.Step memory s) internal pure returns (LeverageExecutorV2.Step[] memory a) {
        a = new LeverageExecutorV2.Step[](1);
        a[0] = s;
    }

    /// @dev tokenIn -> mid -> tokenOut, the second step quoted on the first step's minimum (what the app does)
    function _two(address tokenIn, address mid, address tokenOut, uint256 amountIn, uint256 tolBps)
        internal
        view
        returns (LeverageExecutorV2.Step[] memory a)
    {
        a = new LeverageExecutorV2.Step[](2);
        a[0] = _step(tokenIn, mid, amountIn, tolBps);
        a[1] = _step(mid, tokenOut, a[0].minOut, tolBps);
    }

    function _none() internal pure returns (LeverageExecutorV2.Step[] memory a) {}

    /// @dev debt (USDX units) for `initial` WETH of equity at leverage `levX100` (300 = 3x)
    function _debtFor(uint256 initial, uint256 levX100) internal view returns (uint256) {
        uint256 value = initial * oracle.getAssetPrice(WETH) / 1e18;
        return value * (levX100 - 100) / 100 * 1e6 / oracle.getAssetPrice(USDX);
    }

    /// @dev WETH to sell to get back `debt` + 0.05 % premium, with a 1 % buffer
    function _wethToCover(uint256 debt) internal view returns (uint256) {
        uint256 owed = debt + debt * 5 / 10_000 + 1;
        return owed * oracle.getAssetPrice(USDX) / 1e6 * 1e18 / oracle.getAssetPrice(WETH) * 101 / 100;
    }

    function _openParams(uint256 capital, uint256 debtAmount)
        internal
        view
        returns (LeverageExecutorV2.OpenParams memory)
    {
        return LeverageExecutorV2.OpenParams({
            collateralAsset: WETH,
            debtAsset: USDX,
            capitalToken: WETH,
            capitalAmount: capital,
            capitalSteps: _none(),
            debtAmount: debtAmount,
            steps: _one(_step(USDX, WETH, debtAmount, 50)),
            guard: _guard()
        });
    }

    function _approveOpen(address user, address capitalToken, uint256 capital, uint256 debtAmount) internal {
        vm.startPrank(user);
        IERC20(capitalToken).approve(address(executor), capital);
        IDebtToken(vUSDX).approveDelegation(address(executor), debtAmount);
        vm.stopPrank();
    }

    /// @dev opens `initial` WETH at `levX100` for `user`, collateral as capital
    function _open(address user, uint256 initial, uint256 levX100) internal returns (uint256 debtAmount) {
        debtAmount = _debtFor(initial, levX100);
        _approveOpen(user, WETH, initial, debtAmount);
        LeverageExecutorV2.OpenParams memory p = _openParams(initial, debtAmount);
        vm.prank(user);
        executor.open(p);
    }

    function _closeParams(uint256 repayAmount, uint256 toWithdraw, uint256 toSell, address lender)
        internal
        view
        returns (LeverageExecutorV2.CloseParams memory)
    {
        return LeverageExecutorV2.CloseParams({
            collateralAsset: WETH,
            debtAsset: USDX,
            repayAmount: repayAmount,
            collateralToWithdraw: toWithdraw,
            collateralToSell: toSell,
            steps: _one(_step(WETH, USDX, toSell, 50)),
            flashLender: lender,
            guard: _guard()
        });
    }

    function _hf(address user) internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(user);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    /// @dev the executor keeps no token and no allowance towards anybody it ever talks to
    function _assertClean(LeverageExecutorV2 ex, address r) internal view {
        address[6] memory tokens = [WETH, USDX, WBTC, aWETH, aWBTC, aUSDX];
        address[4] memory spenders = [r, address(pool), address(morpho), address(balancer)];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(address(ex)), 0, "executor balance");
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(IERC20(tokens[i]).allowance(address(ex), spenders[j]), 0, "executor allowance");
            }
        }
    }

    function _assertClean() internal view {
        _assertClean(executor, address(router));
    }
}
