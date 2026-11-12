// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {MockAggregatorRouter} from "../mocks/MockAggregatorRouter.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

interface IScaled {
    function scaledBalanceOf(address user) external view returns (uint256);
}

/// @notice Random sequences of open / partial close / full close / swapCollateral / time by several users,
/// through random flash lenders and random 1- or 2-step routes. After every call:
///   - the executor holds no token and no allowance
///   - no user's position (scaled aToken and debt balances) moved unless that user made the call
contract V2Handler is Test {
    LeverageExecutorV2 internal ex;
    MockAggregatorRouter internal router;
    IAaveV3Pool internal pool;
    address internal WETH;
    address internal WBTC;
    address internal USDX;
    address[3] internal lenders;
    address[] public actors;
    address[] internal tracked; // aWETH, aWBTC, vUSDX

    bool public crossUserChange;
    uint256 public calls;
    uint256 public successes;
    mapping(bytes4 => uint256) public successBy;

    constructor(
        LeverageExecutorV2 ex_,
        MockAggregatorRouter router_,
        IAaveV3Pool pool_,
        address[3] memory tokens, // WETH, WBTC, USDX
        address[3] memory lenders_,
        address[] memory actors_
    ) {
        ex = ex_;
        router = router_;
        pool = pool_;
        (WETH, WBTC, USDX) = (tokens[0], tokens[1], tokens[2]);
        lenders = lenders_;
        actors = actors_;
        tracked.push(pool.getReserveData(WETH).aTokenAddress);
        tracked.push(pool.getReserveData(WBTC).aTokenAddress);
        tracked.push(pool.getReserveData(USDX).variableDebtTokenAddress);
    }

    // ---------------------------------------------------------------------------------------------

    function _snapshot() internal view returns (uint256[] memory s) {
        s = new uint256[](actors.length * tracked.length);
        for (uint256 i; i < actors.length; ++i) {
            for (uint256 j; j < tracked.length; ++j) {
                s[i * tracked.length + j] = IScaled(tracked[j]).scaledBalanceOf(actors[i]);
            }
        }
    }

    modifier checked(uint256 actorSeed) {
        address user = actors[actorSeed % actors.length];
        uint256[] memory before = _snapshot();
        ++calls;
        vm.startPrank(user);
        _;
        vm.stopPrank();
        uint256[] memory afterS = _snapshot();
        for (uint256 i; i < actors.length; ++i) {
            if (actors[i] == user) continue;
            for (uint256 j; j < tracked.length; ++j) {
                if (before[i * tracked.length + j] != afterS[i * tracked.length + j]) crossUserChange = true;
            }
        }
    }

    function _user(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _step(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (SwapExecutorBase.Step memory)
    {
        return SwapExecutorBase.Step({
            router: address(router),
            tokenOut: tokenOut,
            data: abi.encodeCall(router.swap, (tokenIn, tokenOut, amountIn, address(ex))),
            minOut: router.quote(tokenIn, tokenOut, amountIn) * 9_950 / 10_000
        });
    }

    /// @dev 1 step, or 2 steps through `mid`
    function _route(address tokenIn, address tokenOut, address mid, uint256 amountIn, bool two)
        internal
        view
        returns (SwapExecutorBase.Step[] memory s)
    {
        if (!two) {
            s = new SwapExecutorBase.Step[](1);
            s[0] = _step(tokenIn, tokenOut, amountIn);
        } else {
            s = new SwapExecutorBase.Step[](2);
            s[0] = _step(tokenIn, mid, amountIn);
            s[1] = _step(mid, tokenOut, s[0].minOut);
        }
    }

    function _guard() internal view returns (LeverageExecutorV2.Guard memory) {
        return LeverageExecutorV2.Guard(0, block.timestamp);
    }

    /// @dev the collateral the user holds (WETH or WBTC), or address(0)
    function _collateralOf(address user) internal view returns (address c, address aC) {
        if (IERC20(tracked[0]).balanceOf(user) != 0) return (WETH, tracked[0]);
        if (IERC20(tracked[1]).balanceOf(user) != 0) return (WBTC, tracked[1]);
    }

    function _price(address a) internal view returns (uint256) {
        return router.oracle().getAssetPrice(a);
    }

    function _dec(address a) internal view returns (uint256) {
        return a == USDX ? 1e6 : a == WBTC ? 1e8 : 1e18;
    }

    // ---------------------------------------------------------------------------------------------
    // actions
    // ---------------------------------------------------------------------------------------------

    function open(uint256 actorSeed, uint256 capitalUsd, uint256 levX100, uint256 flavour) external checked(actorSeed) {
        address user = _user(actorSeed);
        (address c,) = _collateralOf(user);
        if (c == address(0)) c = flavour % 2 == 0 ? WETH : WBTC;
        capitalUsd = bound(capitalUsd, 50, 50_000);
        levX100 = bound(levX100, 100, 450);
        uint256 debt = capitalUsd * (levX100 - 100) / 100 * 1e6;

        // capital in the collateral, in USDX (debt asset), or in the other volatile token
        uint256 kind = (flavour >> 1) % 3;
        address capitalToken = kind == 0 ? c : kind == 1 ? USDX : (c == WETH ? WBTC : WETH);
        uint256 capital = capitalUsd * _dec(capitalToken) * 1e8 / _price(capitalToken);
        deal(capitalToken, user, capital);
        IERC20(capitalToken).approve(address(ex), capital);
        IDebtToken(tracked[2]).approveDelegation(address(ex), debt);

        LeverageExecutorV2.OpenParams memory p;
        p.collateralAsset = c;
        p.debtAsset = USDX;
        p.capitalToken = capitalToken;
        p.capitalAmount = capital;
        p.debtAmount = debt;
        p.guard = _guard();
        bool two = (flavour >> 3) % 2 == 1;
        address mid = c == WETH ? WBTC : WETH;
        if (kind == 2) p.capitalSteps = _route(capitalToken, c, USDX, capital, two);
        uint256 toSell = debt + (kind == 1 ? capital : 0);
        if (toSell != 0) p.steps = _route(USDX, c, mid, toSell, two);

        try ex.open(p) {
            ++successes;
            ++successBy[this.open.selector];
        } catch {}
        // a failed open leaves allowances behind in the wallet, never in the executor
        IERC20(capitalToken).approve(address(ex), 0);
        IDebtToken(tracked[2]).approveDelegation(address(ex), 0);
    }

    function close(uint256 actorSeed, uint256 shareBps, uint256 lenderSeed, bool two) external checked(actorSeed) {
        (LeverageExecutorV2.CloseParams memory p, address aC, uint256 allowance) =
            _closeFor(_user(actorSeed), shareBps, two);
        if (allowance == 0) return;
        p.flashLender = lenders[lenderSeed % 3];
        IERC20(aC).approve(address(ex), allowance);
        try ex.close(p) {
            ++successes;
            ++successBy[this.close.selector];
        } catch {}
        IERC20(aC).approve(address(ex), 0);
    }

    function _closeFor(address user, uint256 shareBps, bool two)
        internal
        view
        returns (LeverageExecutorV2.CloseParams memory p, address aC, uint256 allowance)
    {
        address c;
        (c, aC) = _collateralOf(user);
        uint256 debt = IERC20(tracked[2]).balanceOf(user);
        if (c == address(0) || debt == 0) return (p, aC, 0);
        shareBps = bound(shareBps, 1, 10_000);
        bool full = shareBps == 10_000 || shareBps % 3 == 0;
        uint256 repay = full ? debt : debt * shareBps / 10_000;
        if (repay == 0) return (p, aC, 0);

        uint256 owed = repay + repay * 5 / 10_000 + 1;
        uint256 toSell = owed * _price(USDX) / 1e6 * _dec(c) / _price(c) * 102 / 100;
        uint256 aBal = IERC20(aC).balanceOf(user);
        if (toSell > aBal) toSell = aBal;

        p.collateralAsset = c;
        p.debtAsset = USDX;
        p.repayAmount = full ? type(uint256).max : repay;
        p.collateralToWithdraw = full ? type(uint256).max : toSell;
        p.collateralToSell = toSell;
        p.steps = _route(c, USDX, c == WETH ? WBTC : WETH, toSell, two);
        p.guard = _guard();
        allowance = full ? type(uint256).max : toSell;
    }

    function swapCollateral(uint256 actorSeed, uint256 lenderSeed, bool two) external checked(actorSeed) {
        address user = _user(actorSeed);
        (address from, address aFrom) = _collateralOf(user);
        if (from == address(0)) return;
        address to = from == WETH ? WBTC : WETH;
        uint256 aBal = IERC20(aFrom).balanceOf(user);

        LeverageExecutorV2.SwapCollateralParams memory p;
        p.fromAsset = from;
        p.toAsset = to;
        p.fromAmount = type(uint256).max;
        p.steps = _route(from, to, USDX, aBal, two);
        p.toAmount = p.steps[p.steps.length - 1].minOut * 99 / 100;
        p.flashLender = lenders[lenderSeed % 3];
        p.guard = _guard();
        if (p.toAmount == 0) return;
        IERC20(aFrom).approve(address(ex), type(uint256).max);
        try ex.swapCollateral(p) {
            ++successes;
            ++successBy[this.swapCollateral.selector];
        } catch {}
        IERC20(aFrom).approve(address(ex), 0);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }
}

contract V2InvariantTest is V2Base {
    V2Handler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory actors = new address[](3);
        actors[0] = makeAddr("u0");
        actors[1] = makeAddr("u1");
        actors[2] = makeAddr("u2");
        handler = new V2Handler(
            executor, router, pool, [WETH, WBTC, USDX], [address(pool), address(morpho), address(balancer)], actors
        );
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](4);
        sel[0] = V2Handler.open.selector;
        sel[1] = V2Handler.close.selector;
        sel[2] = V2Handler.swapCollateral.selector;
        sel[3] = V2Handler.warp.selector;
        targetSelector(FuzzSelector(address(handler), sel));
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 40
    function invariant_executorHoldsNothing() public view {
        _assertClean();
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 40
    function invariant_noCrossUserEffect() public view {
        assertFalse(handler.crossUserChange(), "a call moved another user's position");
    }

    function afterInvariant() public view {
        // the run must have exercised every action, not only reverts
        assertGt(handler.successBy(V2Handler.open.selector), 0, "no successful open");
    }

    // ---------------------------------------------------------------------------------------------
    // plain fuzz
    // ---------------------------------------------------------------------------------------------

    function testFuzz_openThenClose(uint256 initial, uint256 levX100, uint256 lenderSeed, bool twoSteps) public {
        initial = bound(initial, 0.01e18, 50e18);
        levX100 = bound(levX100, 110, 450);
        address lender = [address(pool), address(morpho), address(balancer)][lenderSeed % 3];
        deal(WETH, alice, initial);
        uint256 debt = _debtFor(initial, levX100);
        _approveOpen(alice, WETH, initial, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(initial, debt);
        if (twoSteps) p.steps = _two(USDX, WBTC, WETH, debt, 50);
        vm.prank(alice);
        (uint256 supplied, uint256 borrowed, uint256 hf) = executor.open(p);
        assertEq(borrowed, debt);
        assertApproxEqAbs(_bal(aWETH, alice), supplied, 1);
        assertGt(hf, 1e18);
        _assertClean();

        vm.warp(block.timestamp + 10 days);
        uint256 owedDebt = _bal(vUSDX, alice);
        uint256 toSell = _wethToCover(owedDebt);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.CloseParams memory c = _closeParams(MAX, MAX, toSell, lender);
        if (twoSteps) {
            c.collateralToSell = toSell * 101 / 100;
            c.steps = _two(WETH, WBTC, USDX, c.collateralToSell, 50);
        }
        vm.prank(alice);
        LeverageExecutorV2.CloseResult memory r = executor.close(c);
        assertEq(r.debtRepaid, owedDebt);
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, alice), 0);
        assertEq(r.healthFactor, type(uint256).max);
        _assertClean();
    }

    function testFuzz_swapCollateralRoundTrip(uint256 initial, uint256 levX100, uint256 lenderSeed) public {
        initial = bound(initial, 0.01e18, 50e18);
        levX100 = bound(levX100, 110, 400);
        address lender = [address(pool), address(morpho), address(balancer)][lenderSeed % 3];
        deal(WETH, alice, initial);
        _open(alice, initial, levX100);
        uint256 debt = _bal(vUSDX, alice);

        uint256 aBal = _bal(aWETH, alice);
        vm.startPrank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        IERC20(aWBTC).approve(address(executor), MAX);
        vm.stopPrank();
        LeverageExecutorV2.SwapCollateralParams memory p = LeverageExecutorV2.SwapCollateralParams({
            fromAsset: WETH,
            toAsset: WBTC,
            fromAmount: MAX,
            toAmount: router.quote(WETH, WBTC, aBal) * 99 / 100,
            steps: _one(_step(WETH, WBTC, aBal, 50)),
            flashLender: lender,
            guard: _guard()
        });
        vm.prank(alice);
        executor.swapCollateral(p);
        assertEq(_bal(aWETH, alice), 0);
        assertEq(_bal(vUSDX, alice), debt);
        _assertClean();

        uint256 bBal = _bal(aWBTC, alice);
        p = LeverageExecutorV2.SwapCollateralParams({
            fromAsset: WBTC,
            toAsset: WETH,
            fromAmount: MAX,
            toAmount: router.quote(WBTC, WETH, bBal) * 99 / 100,
            steps: _one(_step(WBTC, WETH, bBal, 50)),
            flashLender: lender,
            guard: _guard()
        });
        vm.prank(alice);
        executor.swapCollateral(p);
        assertEq(_bal(aWBTC, alice), 0);
        // two Aave premiums of 0.05 % each, or only rounding through a free lender
        uint256 tol = lender == address(pool) ? 0.0011e18 : 0.0002e18;
        assertApproxEqRel(_bal(aWETH, alice), aBal, tol, "back where it started, minus rounding and premiums");
        assertLe(_bal(aWETH, alice), aBal + 1, "never more than it started with");
        assertEq(_bal(vUSDX, alice), debt);
        _assertClean();
    }

    function testFuzz_capitalInAnyToken(uint256 capitalUsd, uint256 levX100, uint8 kind) public {
        capitalUsd = bound(capitalUsd, 10, 1_000_000);
        levX100 = bound(levX100, 100, 450);
        kind = kind % 3;
        address capitalToken = kind == 0 ? WETH : kind == 1 ? USDX : WBTC;
        uint256 dec = kind == 0 ? 1e18 : kind == 1 ? 1e6 : 1e8;
        uint256 capital = capitalUsd * dec * 1e8 / oracle.getAssetPrice(capitalToken);
        uint256 debt = capitalUsd * (levX100 - 100) / 100 * 1e6;
        deal(capitalToken, alice, capital);
        _approveOpen(alice, capitalToken, capital, debt);

        LeverageExecutorV2.OpenParams memory p = _openParams(capital, debt);
        p.capitalToken = capitalToken;
        if (kind == 2) p.capitalSteps = _one(_step(WBTC, WETH, capital, 50));
        uint256 toSell = debt + (kind == 1 ? capital : 0);
        p.steps = toSell == 0 ? _none() : _one(_step(USDX, WETH, toSell, 50));
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);

        uint256 expected = capitalUsd * levX100 / 100 * 1e18 * 1e8 / oracle.getAssetPrice(WETH);
        assertApproxEqRel(supplied, expected, 0.0001e18);
        assertEq(_bal(capitalToken, alice), 0, "exact capital pulled");
        assertEq(_bal(vUSDX, alice), debt);
        _assertClean();
    }
}
