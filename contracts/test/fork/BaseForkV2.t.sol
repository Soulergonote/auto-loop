// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";

interface IAddressesProviderV2 {
    function getPriceOracle() external view returns (address);
}

interface IPoolProviderV2 {
    function ADDRESSES_PROVIDER() external view returns (address);
}

interface IOracleV2 {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IDebtTokenV2 {
    function approveDelegation(address delegatee, uint256 amount) external;
}

interface ISwapRouter02V2 {
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

/// @notice v2 against the live Aave v3 market on Base, the real Morpho Blue singleton and the real Balancer v2 Vault,
/// with Uniswap v3 (SwapRouter02) as a deterministic stand-in for an aggregator.
///   BASE_RPC_URL=... forge test --match-contract BaseForkV2Test -vv
/// Skipped when BASE_RPC_URL is not set.
contract BaseForkV2Test is Test {
    address constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;

    LeverageExecutorV2 ex;
    IOracleV2 oracle;
    address aWETH;
    address aWSTETH;
    address aUSDC;
    address vUSDC;
    address user = makeAddr("user");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        // every router the app whitelists on Base must pass the constructor checks (code, not an Aave token, ...)
        address[] memory routers = new address[](6);
        routers[0] = UNI_ROUTER02;
        routers[1] = 0x6A000F20005980200259B80c5102003040001068; // Velora Augustus v6.2
        routers[2] = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5; // KyberSwap MetaAggregationRouterV2
        routers[3] = 0x111111125421cA6dc452d289314280a0f8842A65; // 1inch v6
        routers[4] = 0x0000000000001fF3684f28c67538d4D072C22734; // 0x AllowanceHolder
        routers[5] = 0x888888888889758F76e7103c6CbF23ABbF58F946; // Pendle Router v4
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](2);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, MORPHO);
        lenders[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, BALANCER_VAULT);
        // a fresh address: the default first deployment address holds dust on mainnets
        address at = address(uint160(uint256(keccak256("auto-loop.executor-v2.fork"))));
        deployCodeTo("LeverageExecutorV2.sol:LeverageExecutorV2", abi.encode(POOL, routers, lenders), at);
        ex = LeverageExecutorV2(at);

        oracle = IOracleV2(IAddressesProviderV2(IPoolProviderV2(POOL).ADDRESSES_PROVIDER()).getPriceOracle());
        aWETH = IAaveV3Pool(POOL).getReserveData(WETH).aTokenAddress;
        aWSTETH = IAaveV3Pool(POOL).getReserveData(WSTETH).aTokenAddress;
        aUSDC = IAaveV3Pool(POOL).getReserveData(USDC).aTokenAddress;
        vUSDC = IAaveV3Pool(POOL).getReserveData(USDC).variableDebtTokenAddress;
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    function _value(address token, uint256 amount, uint256 dec) internal view returns (uint256) {
        return amount * oracle.getAssetPrice(token) / dec;
    }

    /// @dev expected output at the Aave oracle price
    function _at(address tokenIn, uint256 decIn, address tokenOut, uint256 decOut, uint256 amountIn)
        internal
        view
        returns (uint256)
    {
        return _value(tokenIn, amountIn, decIn) * decOut / oracle.getAssetPrice(tokenOut);
    }

    /// @dev one Uniswap v3 step, minimum = oracle price minus `tolBps`
    function _uni(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 expectedOut, uint256 tolBps)
        internal
        view
        returns (LeverageExecutorV2.Step memory)
    {
        return LeverageExecutorV2.Step({
            router: UNI_ROUTER02,
            tokenOut: tokenOut,
            data: abi.encodeCall(
                ISwapRouter02V2.exactInputSingle,
                (ISwapRouter02V2.ExactInputSingleParams(tokenIn, tokenOut, fee, address(ex), amountIn, 0, 0))
            ),
            minOut: expectedOut * (10_000 - tolBps) / 10_000
        });
    }

    function _one(LeverageExecutorV2.Step memory s) internal pure returns (LeverageExecutorV2.Step[] memory a) {
        a = new LeverageExecutorV2.Step[](1);
        a[0] = s;
    }

    function _guard() internal view returns (LeverageExecutorV2.Guard memory) {
        return LeverageExecutorV2.Guard(1.05e18, block.timestamp);
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,, hf) = IAaveV3Pool(POOL).getUserAccountData(user);
    }

    function _assertClean() internal view {
        address[6] memory tokens = [WETH, USDC, WSTETH, aWETH, aWSTETH, aUSDC];
        address[4] memory spenders = [UNI_ROUTER02, POOL, MORPHO, BALANCER_VAULT];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(address(ex)), 0, "executor balance");
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(IERC20(tokens[i]).allowance(address(ex), spenders[j]), 0, "executor allowance");
            }
        }
    }

    /// @dev 3x WETH/USDC from `capital` USDC (capital in the debt asset)
    function _openWethFromUsdc(uint256 capital) internal returns (uint256 supplied) {
        uint256 debt = capital * 2;
        deal(USDC, user, capital);
        vm.startPrank(user);
        IERC20(USDC).approve(address(ex), capital);
        IDebtTokenV2(vUSDC).approveDelegation(address(ex), debt);
        LeverageExecutorV2.OpenParams memory p;
        p.collateralAsset = WETH;
        p.debtAsset = USDC;
        p.capitalToken = USDC;
        p.capitalAmount = capital;
        p.debtAmount = debt;
        p.steps = _one(_uni(USDC, WETH, 500, capital + debt, _at(USDC, 1e6, WETH, 1e18, capital + debt), 100));
        p.guard = _guard();
        (supplied,,) = ex.open(p);
        vm.stopPrank();
    }

    function _closeAll(address lender, LeverageExecutorV2.Step[] memory steps, address collateral, uint256 toSell)
        internal
        returns (LeverageExecutorV2.CloseResult memory r)
    {
        address aC = IAaveV3Pool(POOL).getReserveData(collateral).aTokenAddress;
        vm.startPrank(user);
        IERC20(aC).approve(address(ex), type(uint256).max);
        r = ex.close(
            LeverageExecutorV2.CloseParams({
                collateralAsset: collateral,
                debtAsset: USDC,
                repayAmount: type(uint256).max,
                collateralToWithdraw: type(uint256).max,
                collateralToSell: toSell,
                steps: steps,
                flashLender: lender,
                guard: LeverageExecutorV2.Guard(0, block.timestamp)
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // tests
    // ---------------------------------------------------------------------------------------------

    function test_forkV2_usdcCapital_open3x_closeViaMorpho() public {
        uint256 supplied = _openWethFromUsdc(3_000e6);
        emit log_named_decimal_uint("WETH supplied", supplied, 18);
        emit log_named_decimal_uint("health factor", _hf(), 18);
        assertApproxEqRel(_value(WETH, supplied, 1e18), _value(USDC, 9_000e6, 1e6), 0.01e18);
        assertApproxEqAbs(IERC20(vUSDC).balanceOf(user), 6_000e6, 2);
        assertEq(IERC20(USDC).balanceOf(user), 0, "capital pulled");
        _assertClean();

        vm.warp(block.timestamp + 1 days);
        uint256 debt = IERC20(vUSDC).balanceOf(user);
        uint256 toSell = _at(USDC, 1e6, WETH, 1e18, debt) * 102 / 100;
        uint256 morphoBefore = IERC20(USDC).balanceOf(MORPHO);
        LeverageExecutorV2.CloseResult memory r =
            _closeAll(MORPHO, _one(_uni(WETH, USDC, 500, toSell, debt, 0)), WETH, toSell);

        emit log_named_decimal_uint("WETH back", r.collateralReturned, 18);
        emit log_named_decimal_uint("USDC back", r.debtReturned, 6);
        assertEq(r.flashPremium, 0, "Morpho is free");
        assertEq(r.debtRepaid, debt);
        assertEq(IERC20(vUSDC).balanceOf(user), 0);
        assertEq(IERC20(aWETH).balanceOf(user), 0);
        assertEq(IERC20(USDC).balanceOf(MORPHO), morphoBefore, "Morpho repaid exactly");
        assertEq(r.collateralReturned, IERC20(WETH).balanceOf(user));
        _assertClean();
    }

    function test_forkV2_twoStepChain_wstETH_closeViaBalancer() public {
        // 1 WETH capital, USDC -> WETH -> wstETH, collateral wstETH
        uint256 capital = 1e18;
        deal(WETH, user, capital);
        uint256 debt = _value(WETH, capital, 1e18) * 1e6 / oracle.getAssetPrice(USDC); // 2x
        uint256 wethMid = _at(USDC, 1e6, WETH, 1e18, debt) * 99 / 100;

        LeverageExecutorV2.OpenParams memory p;
        p.collateralAsset = WSTETH;
        p.debtAsset = USDC;
        p.capitalToken = WETH;
        p.capitalAmount = capital;
        p.capitalSteps = _one(_uni(WETH, WSTETH, 100, capital, _at(WETH, 1e18, WSTETH, 1e18, capital), 100));
        p.debtAmount = debt;
        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](2);
        s[0] = _uni(USDC, WETH, 500, debt, _at(USDC, 1e6, WETH, 1e18, debt), 100);
        s[0].minOut = wethMid;
        s[1] = _uni(WETH, WSTETH, 100, wethMid, _at(WETH, 1e18, WSTETH, 1e18, wethMid), 100);
        p.steps = s;
        p.guard = _guard();

        vm.startPrank(user);
        IERC20(WETH).approve(address(ex), capital);
        IDebtTokenV2(vUSDC).approveDelegation(address(ex), debt);
        (uint256 supplied,,) = ex.open(p);
        vm.stopPrank();
        emit log_named_decimal_uint("wstETH supplied", supplied, 18);
        emit log_named_decimal_uint("WETH leftover returned", IERC20(WETH).balanceOf(user), 18);
        assertApproxEqRel(_value(WSTETH, supplied, 1e18), 2 * _value(WETH, capital, 1e18), 0.02e18);
        _assertClean();

        // out: wstETH -> WETH -> USDC through the Balancer Vault (fee 0 on v2)
        uint256 owed = IERC20(vUSDC).balanceOf(user);
        uint256 toSell = _at(USDC, 1e6, WSTETH, 1e18, owed) * 103 / 100;
        uint256 wethOut = _at(WSTETH, 1e18, WETH, 1e18, toSell) * 99 / 100;
        LeverageExecutorV2.Step[] memory c = new LeverageExecutorV2.Step[](2);
        c[0] = _uni(WSTETH, WETH, 100, toSell, wethOut, 0);
        c[0].minOut = wethOut;
        c[1] = _uni(WETH, USDC, 500, wethOut, owed, 0);
        LeverageExecutorV2.CloseResult memory r = _closeAll(BALANCER_VAULT, c, WSTETH, toSell);
        emit log_named_decimal_uint("Balancer fee", r.flashPremium, 6);
        assertEq(IERC20(vUSDC).balanceOf(user), 0);
        assertEq(IERC20(aWSTETH).balanceOf(user), 0);
        _assertClean();
    }

    function _swapWethToWsteth(address lender) internal returns (LeverageExecutorV2.SwapCollateralResult memory r) {
        _openWethFromUsdc(3_000e6);
        uint256 aBal = IERC20(aWETH).balanceOf(user);
        uint256 out = _at(WETH, 1e18, WSTETH, 1e18, aBal);
        uint256 debt = IERC20(vUSDC).balanceOf(user);
        uint256 hfBefore = _hf();
        vm.startPrank(user);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        r = ex.swapCollateral(
            LeverageExecutorV2.SwapCollateralParams({
                fromAsset: WETH,
                toAsset: WSTETH,
                fromAmount: type(uint256).max,
                toAmount: out * 98 / 100,
                steps: _one(_uni(WETH, WSTETH, 100, aBal, out, 100)),
                flashLender: lender,
                guard: LeverageExecutorV2.Guard(1.05e18, block.timestamp)
            })
        );
        vm.stopPrank();
        emit log_named_decimal_uint("wstETH supplied", r.supplied, 18);
        emit log_named_decimal_uint("HF before", hfBefore, 18);
        emit log_named_decimal_uint("HF after", r.healthFactor, 18);
        assertEq(r.withdrawn, aBal);
        assertEq(IERC20(aWETH).balanceOf(user), 0, "old collateral gone");
        assertApproxEqAbs(IERC20(aWSTETH).balanceOf(user), r.supplied, 2);
        assertApproxEqAbs(IERC20(vUSDC).balanceOf(user), debt, 2, "debt untouched");
        _assertClean();
    }

    function test_forkV2_swapCollateral_WETHtoWstETH_viaMorpho() public {
        LeverageExecutorV2.SwapCollateralResult memory r = _swapWethToWsteth(MORPHO);
        assertEq(r.flashPremium, 0);
    }

    function test_forkV2_swapCollateral_WETHtoWstETH_viaAave() public {
        LeverageExecutorV2.SwapCollateralResult memory r = _swapWethToWsteth(POOL);
        emit log_named_decimal_uint("Aave premium (wstETH)", r.flashPremium, 18);
        assertGt(r.flashPremium, 0);
    }

    function test_forkV2_forgedBalancerCallbackRejected() public {
        _openWethFromUsdc(3_000e6);
        vm.prank(user);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(USDC);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1_000e6;
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        IBalancerVaultV2(BALANCER_VAULT).flashLoan(address(ex), tokens, amounts, abi.encode(uint8(1), user, ""));
    }

    /// Audit L-02: during a Balancer v2 flash loan the Vault is locked (one reentrancy guard for flashLoan, swap,
    /// batchSwap, joins, exits, manageUserBalance), so a route that goes through a Balancer v2 pool reverts with
    /// BAL#400. The same route works with Morpho as the lender.
    function test_forkV2_L02_balancerRouteFailsUnderBalancerFlash() public {
        BalancerTouchingRouter br = new BalancerTouchingRouter(BALANCER_VAULT);
        deal(USDC, address(br), 1_000_000e6);
        address[] memory routers = new address[](1);
        routers[0] = address(br);
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](2);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, MORPHO);
        lenders[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, BALANCER_VAULT);
        LeverageExecutorV2 ex2 = new LeverageExecutorV2(IAaveV3Pool(POOL), routers, lenders);

        _openWethFromUsdc(3_000e6);
        uint256 debt = IERC20(vUSDC).balanceOf(user);
        uint256 toSell = _at(USDC, 1e6, WETH, 1e18, debt) * 102 / 100;
        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](1);
        s[0] = LeverageExecutorV2.Step({
            router: address(br),
            tokenOut: USDC,
            data: abi.encodeCall(BalancerTouchingRouter.swap, (WETH, USDC, toSell, debt * 102 / 100, address(ex2))),
            minOut: debt
        });
        LeverageExecutorV2.CloseParams memory p = LeverageExecutorV2.CloseParams({
            collateralAsset: WETH,
            debtAsset: USDC,
            repayAmount: type(uint256).max,
            collateralToWithdraw: type(uint256).max,
            collateralToSell: toSell,
            steps: s,
            flashLender: BALANCER_VAULT,
            guard: LeverageExecutorV2.Guard(0, block.timestamp)
        });
        vm.startPrank(user);
        IERC20(aWETH).approve(address(ex2), type(uint256).max);
        vm.expectRevert(bytes("BAL#400"));
        ex2.close(p);

        p.flashLender = MORPHO;
        ex2.close(p);
        vm.stopPrank();
        assertEq(IERC20(vUSDC).balanceOf(user), 0, "closed through Morpho");
    }
}

/// @dev stand-in for an aggregator route through a Balancer v2 pool: touches a Vault function guarded like swap
contract BalancerTouchingRouter {
    address immutable vault;

    constructor(address vault_) {
        vault = vault_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient) external {
        IVaultUserBalance(vault).manageUserBalance(new IVaultUserBalance.UserBalanceOp[](0));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

interface IVaultUserBalance {
    struct UserBalanceOp {
        uint8 kind;
        address asset;
        uint256 amount;
        address sender;
        address payable recipient;
    }

    function manageUserBalance(UserBalanceOp[] memory ops) external payable;
}

interface IBalancerVaultV2 {
    function flashLoan(address recipient, IERC20[] memory tokens, uint256[] memory amounts, bytes memory userData)
        external;
}
