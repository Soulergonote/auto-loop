// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutor} from "../../src/LeverageExecutor.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";

interface IPoolAddressesProviderLike {
    function getPriceOracle() external view returns (address);
}

interface IPoolLike {
    function ADDRESSES_PROVIDER() external view returns (address);
}

interface IOracleLike {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IDebtTokenLike {
    function approveDelegation(address delegatee, uint256 amount) external;
}

/// @notice Uniswap v3 SwapRouter02 (no deadline field). Used as a deterministic stand-in for an aggregator.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// @notice Fork tests against the live Aave v3 market on Base.
///   BASE_RPC_URL=... forge test --match-contract BaseForkTest -vv
/// Skipped when BASE_RPC_URL is not set.
///
/// `test_fork_open_aggregatorCalldata` replays real aggregator calldata produced by script/quote-velora.sh
/// (env AGG_ROUTER, AGG_DATA, AGG_SELL_AMOUNT, AGG_MIN_OUT). The quote must be taken with
/// EXECUTOR as taker, which is why the executor is deployed at a fixed address on the fork.
contract BaseForkTest is Test {
    address constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; // Aave v3 Pool, Base
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // aggregator routers on Base (to re-verify against each aggregator's docs before any deployment)
    address constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;
    address constant ONEINCH_ROUTER_V6 = 0x111111125421cA6dc452d289314280a0f8842A65;
    address constant VELORA_AUGUSTUS_V62 = 0x6A000F20005980200259B80c5102003040001068;
    address constant KYBER_META_AGGREGATOR_V2 = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;

    address constant EXECUTOR = address(uint160(uint256(keccak256("auto-loop.executor.fork"))));

    LeverageExecutor executor;
    IOracleLike oracle;
    address aWETH;
    address vUSDC;
    address user = makeAddr("user");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("BASE_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);

        address[] memory routers = new address[](5);
        routers[0] = UNI_ROUTER02;
        routers[1] = ZEROX_ALLOWANCE_HOLDER;
        routers[2] = ONEINCH_ROUTER_V6;
        routers[3] = VELORA_AUGUSTUS_V62;
        routers[4] = KYBER_META_AGGREGATOR_V2;
        deployCodeTo("LeverageExecutor.sol:LeverageExecutor", abi.encode(POOL, routers), EXECUTOR);
        executor = LeverageExecutor(EXECUTOR);

        oracle = IOracleLike(IPoolAddressesProviderLike(IPoolLike(POOL).ADDRESSES_PROVIDER()).getPriceOracle());
        aWETH = IAaveV3Pool(POOL).getReserveData(WETH).aTokenAddress;
        vUSDC = IAaveV3Pool(POOL).getReserveData(USDC).variableDebtTokenAddress;

        deal(WETH, user, 10e18);
    }

    function _usdcFor(uint256 wethAmount) internal view returns (uint256) {
        return wethAmount * oracle.getAssetPrice(WETH) / oracle.getAssetPrice(USDC) / 1e12;
    }

    function _wethFor(uint256 usdcAmount) internal view returns (uint256) {
        return usdcAmount * 1e12 * oracle.getAssetPrice(USDC) / oracle.getAssetPrice(WETH);
    }

    function _uniSwap(address tokenIn, address tokenOut, uint256 amountIn) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISwapRouter02.exactInputSingle,
            (ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, 500, EXECUTOR, amountIn, 0, 0))
        );
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,, hf) = IAaveV3Pool(POOL).getUserAccountData(user);
    }

    function test_fork_open3x_thenClose_uniswap() public {
        uint256 initial = 1e18;
        uint256 debtAmount = _usdcFor(initial) * 2; // 3x

        vm.startPrank(user);
        IERC20(WETH).approve(EXECUTOR, initial);
        IDebtTokenLike(vUSDC).approveDelegation(EXECUTOR, debtAmount);
        executor.open(
            LeverageExecutor.OpenParams({
                collateralAsset: WETH,
                debtAsset: USDC,
                initialCollateral: initial,
                debtAmount: debtAmount,
                swap: LeverageExecutor.Swap({
                    router: UNI_ROUTER02,
                    data: _uniSwap(USDC, WETH, debtAmount),
                    minOut: _wethFor(debtAmount) * 99 / 100
                })
            })
        );
        vm.stopPrank();

        emit log_named_decimal_uint("aWETH after open", IERC20(aWETH).balanceOf(user), 18);
        emit log_named_decimal_uint("USDC debt", IERC20(vUSDC).balanceOf(user), 6);
        emit log_named_decimal_uint("health factor", _hf(), 18);
        assertApproxEqRel(IERC20(aWETH).balanceOf(user), 3e18, 0.01e18);
        // Aave rounds the scaled debt balance up, so the debt can exceed debtAmount by a few wei
        assertApproxEqAbs(IERC20(vUSDC).balanceOf(user), debtAmount, 2);
        assertGt(_hf(), 1e18);

        vm.warp(block.timestamp + 7 days);
        uint256 debt = IERC20(vUSDC).balanceOf(user);
        uint256 toSell = _wethFor(debt + debt / 1000) * 102 / 100; // premium + 2% buffer

        vm.startPrank(user);
        IERC20(aWETH).approve(EXECUTOR, type(uint256).max);
        executor.close(
            LeverageExecutor.CloseParams({
                collateralAsset: WETH,
                debtAsset: USDC,
                repayAmount: type(uint256).max,
                collateralToWithdraw: type(uint256).max,
                collateralToSell: toSell,
                swap: LeverageExecutor.Swap({router: UNI_ROUTER02, data: _uniSwap(WETH, USDC, toSell), minOut: debt})
            })
        );
        vm.stopPrank();

        emit log_named_decimal_uint("WETH back in wallet", IERC20(WETH).balanceOf(user), 18);
        assertEq(IERC20(vUSDC).balanceOf(user), 0);
        assertEq(IERC20(aWETH).balanceOf(user), 0);
        assertEq(IERC20(WETH).balanceOf(EXECUTOR), 0);
        assertEq(IERC20(USDC).balanceOf(EXECUTOR), 0);
    }

    function test_fork_open_aggregatorCalldata() public {
        address aggRouter = vm.envOr("AGG_ROUTER", address(0));
        if (aggRouter == address(0)) {
            vm.skip(true);
            return;
        }
        bytes memory data = vm.envBytes("AGG_DATA");
        uint256 sellAmount = vm.envUint("AGG_SELL_AMOUNT");
        uint256 minOut = vm.envUint("AGG_MIN_OUT");
        uint256 initial = 1e18;

        vm.startPrank(user);
        IERC20(WETH).approve(EXECUTOR, initial);
        IDebtTokenLike(vUSDC).approveDelegation(EXECUTOR, sellAmount);
        executor.open(
            LeverageExecutor.OpenParams({
                collateralAsset: WETH,
                debtAsset: USDC,
                initialCollateral: initial,
                debtAmount: sellAmount,
                swap: LeverageExecutor.Swap({router: aggRouter, data: data, minOut: minOut})
            })
        );
        vm.stopPrank();

        emit log_named_decimal_uint("aWETH after open", IERC20(aWETH).balanceOf(user), 18);
        emit log_named_decimal_uint("health factor", _hf(), 18);
        assertApproxEqAbs(IERC20(vUSDC).balanceOf(user), sellAmount, 2);
        assertGe(IERC20(aWETH).balanceOf(user), initial + minOut - 1);
    }
}
