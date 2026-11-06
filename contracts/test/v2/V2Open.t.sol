// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";

/// @notice Open: swap chains (change 1), any-token capital (change 2), guard (change 3), return values and
/// events (change 6).
contract V2OpenTest is V2Base {
    // ---------------------------------------------------------------------------------------------
    // basics and return values
    // ---------------------------------------------------------------------------------------------

    function test_open_3x_returnsWhatMoved() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);

        vm.prank(alice);
        (uint256 supplied, uint256 borrowed, uint256 hf) = executor.open(p);

        assertEq(supplied, 3e18, "1 WETH capital + 2 WETH bought");
        assertApproxEqAbs(_bal(aWETH, alice), supplied, 1, "supplied for alice");
        assertEq(borrowed, debt);
        assertEq(_bal(vUSDX, alice), debt, "debt opened for alice");
        assertEq(hf, _hf(alice), "returned HF is Aave's");
        assertEq(_bal(WETH, alice), 100e18 - 1e18, "exact capital pulled");
        assertEq(IDebtToken(vUSDX).borrowAllowance(alice, address(executor)), 0, "delegation used up");
        _assertClean();
    }

    function test_open_emitsSwappedAndPositionOpened() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);

        vm.expectEmit(true, true, true, true, address(executor));
        emit LeverageExecutorV2.Swapped(alice, address(router), USDX, WETH, debt, 2e18);
        // the HF is checked against the return value below
        vm.expectEmit(true, true, true, false, address(executor));
        emit LeverageExecutorV2.PositionOpened(alice, WETH, USDX, WETH, 1e18, 3e18, debt, 0);
        vm.recordLogs();
        vm.prank(alice);
        (,, uint256 hf) = executor.open(p);

        // decode PositionOpened fully
        bytes32 sig = keccak256("PositionOpened(address,address,address,address,uint256,uint256,uint256,uint256)");
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(executor) && logs[i].topics[0] == sig) {
                (address cap, uint256 capAmt, uint256 sup, uint256 bor, uint256 h) =
                    abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256));
                assertEq(cap, WETH);
                assertEq(capAmt, 1e18);
                assertEq(sup, 3e18);
                assertEq(bor, debt);
                assertEq(h, hf);
                found = true;
            }
        }
        assertTrue(found, "PositionOpened emitted");
    }

    function test_open_onTopOfExistingPosition_noCapital() public {
        _open(alice, 1e18, 200);
        uint256 extra = 1800e6;
        vm.prank(alice);
        IDebtToken(vUSDX).approveDelegation(address(executor), extra);
        LeverageExecutorV2.OpenParams memory p = _openParams(0, extra);
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);

        assertEq(supplied, 1e18);
        assertEq(_bal(vUSDX, alice), 1800e6 + extra);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 2);
        _assertClean();
    }

    function test_openWithSig() public {
        uint256 debt = _debtFor(1e18, 300);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = EIP712SigUtils.getCreditDelegationTypedDataHash(
            EIP712SigUtils.CreditDelegation({delegatee: address(executor), value: debt, nonce: 0, deadline: deadline}),
            bytes(IDebtToken(vUSDX).name()),
            bytes("1"),
            vUSDX
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);

        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.prank(alice);
        executor.openWithSig(p, LeverageExecutorV2.Signature(debt, deadline, v, r, s));

        assertEq(_bal(vUSDX, alice), debt);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
        _assertClean();
    }

    function test_openWithSig_frontRunSignatureStillOpens() public {
        uint256 debt = _debtFor(1e18, 300);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = EIP712SigUtils.getCreditDelegationTypedDataHash(
            EIP712SigUtils.CreditDelegation({delegatee: address(executor), value: debt, nonce: 0, deadline: deadline}),
            bytes(IDebtToken(vUSDX).name()),
            bytes("1"),
            vUSDX
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);
        // somebody submits the signature first
        vm.prank(attacker);
        ICreditDelegationTokenLike(vUSDX).delegationWithSig(alice, address(executor), debt, deadline, v, r, s);

        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.prank(alice);
        executor.openWithSig(p, LeverageExecutorV2.Signature(debt, deadline, v, r, s));
        assertEq(_bal(vUSDX, alice), debt);
    }

    // ---------------------------------------------------------------------------------------------
    // change 1: swap chains
    // ---------------------------------------------------------------------------------------------

    function test_chain_open_twoSteps_viaWBTC() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);

        uint256 wbtcOut = router.quote(USDX, WBTC, debt);
        uint256 wethOut = router.quote(WBTC, WETH, p.steps[0].minOut);
        uint256 wbtcBefore = _bal(WBTC, alice);
        vm.expectEmit(true, true, true, true, address(executor));
        emit LeverageExecutorV2.Swapped(alice, address(router), USDX, WBTC, debt, wbtcOut);
        vm.expectEmit(true, true, true, true, address(executor));
        // the second step's calldata sells the first step's minimum (as the app quotes it)
        emit LeverageExecutorV2.Swapped(alice, address(router), WBTC, WETH, p.steps[0].minOut, wethOut);
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);

        assertEq(supplied, 1e18 + wethOut);
        assertApproxEqAbs(_bal(aWETH, alice), supplied, 1);
        // what the second step did not sell comes back to alice, in WBTC
        assertEq(_bal(WBTC, alice) - wbtcBefore, wbtcOut - p.steps[0].minOut, "intermediate leftover returned");
        _assertClean();
    }

    function test_chain_open_fourSteps() public {
        uint256 debt = _debtFor(1e18, 250);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](4);
        s[0] = _step(USDX, WBTC, debt, 50);
        s[1] = _step(WBTC, WETH, s[0].minOut, 50);
        s[2] = _step(WETH, WBTC, s[1].minOut, 50);
        s[3] = _step(WBTC, WETH, s[2].minOut, 50);
        p.steps = s;
        uint256 wbtcBefore = _bal(WBTC, alice);
        uint256 wethBefore = _bal(WETH, alice);
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);
        assertGt(supplied, 1e18 + 1.4e18);
        assertGt(_bal(WBTC, alice), wbtcBefore, "leftovers of steps 1 and 3");
        assertGt(_bal(WETH, alice) + 1e18, wethBefore, "leftover of step 2 (collateral) returned too");
        _assertClean();
    }

    function test_revert_chain_noSteps() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _none();
        vm.expectRevert(LeverageExecutorV2.InvalidSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_fiveSteps() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](5);
        s[0] = _step(USDX, WBTC, debt, 50);
        s[1] = _step(WBTC, WETH, s[0].minOut, 50);
        s[2] = _step(WETH, WBTC, s[1].minOut, 50);
        s[3] = _step(WBTC, USDX, s[2].minOut, 50);
        s[4] = _step(USDX, WETH, s[3].minOut, 50);
        p.steps = s;
        vm.expectRevert(LeverageExecutorV2.InvalidSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_wrongFinalToken() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _one(_step(USDX, WBTC, debt, 50));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.WrongFinalToken.selector, WBTC, WETH));
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_stepOutputEqualsInput() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](2);
        s[0] = _step(USDX, WETH, debt, 50);
        s[0].tokenOut = USDX; // a "swap" USDX -> USDX would measure nothing
        s[1] = _step(USDX, WETH, debt, 50);
        p.steps = s;
        vm.expectRevert(LeverageExecutorV2.SameAsset.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_intermediateMinOut() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);
        router.setSlippageBps(100); // 1 % below the quote, tolerance was 0.5 %
        vm.expectPartialRevert(LeverageExecutorV2.InsufficientOutput.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_secondStepMinOutOnly() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);
        p.steps[1].minOut = router.quote(WBTC, WETH, p.steps[0].minOut) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                LeverageExecutorV2.InsufficientOutput.selector,
                router.quote(WBTC, WETH, p.steps[0].minOut),
                p.steps[1].minOut
            )
        );
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_unlistedRouterInAnyStep() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);
        address rogue = address(new RogueRouterStub());
        p.steps[1].router = rogue;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.RouterNotAllowed.selector, rogue));
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_routerIsAnOperationToken() public {
        // a token that is not on Aave (an intermediate token of a route, e.g. a PT or an SY) whitelisted as a
        // router by mistake: it can never be called in an operation that moves it
        MintableToken pt = new MintableToken();
        address[] memory routers = new address[](2);
        routers[0] = address(router);
        routers[1] = address(pt);
        LeverageExecutorV2 ex = _deployWith(routers);
        uint256 debt = _debtFor(1e18, 300);
        vm.startPrank(alice);
        IERC20(WETH).approve(address(ex), 1e18);
        IDebtToken(vUSDX).approveDelegation(address(ex), debt);
        vm.stopPrank();

        LeverageExecutorV2.Step[] memory s = new LeverageExecutorV2.Step[](3);
        s[0] = _stepFor(ex, USDX, WBTC, debt, 50);
        s[1] = LeverageExecutorV2.Step({
            router: address(pt),
            tokenOut: address(pt),
            data: abi.encodeCall(IERC20.transferFrom, (alice, attacker, 1)),
            minOut: 0
        });
        s[2] = LeverageExecutorV2.Step({router: address(router), tokenOut: WETH, data: "", minOut: 0});
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = s;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidRouter.selector, address(pt)));
        vm.prank(alice);
        ex.open(p);
    }

    function test_revert_chain_greedyRouterInSecondStep() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);
        // the second step tries to pull everything the first one delivered + 1
        uint256 wbtcOut = router.quote(USDX, WBTC, debt);
        p.steps[1].data = abi.encodeCall(router.swapGreedy, (WBTC, WETH, wbtcOut, address(executor)));
        vm.expectRevert(); // ERC20: insufficient allowance
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_chain_outputSentElsewhere() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _two(USDX, WBTC, WETH, debt, 50);
        p.steps[0].data = abi.encodeCall(router.swap, (USDX, WBTC, debt, attacker));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InsufficientOutput.selector, 0, p.steps[0].minOut));
        vm.prank(alice);
        executor.open(p);
    }

    // ---------------------------------------------------------------------------------------------
    // change 2: capital in any token
    // ---------------------------------------------------------------------------------------------

    function test_capital_inDebtAsset() public {
        // 1800 USDX of capital + 3600 borrowed, all sold for WETH in one step
        uint256 capital = 1800e6;
        uint256 debt = 3600e6;
        deal(USDX, alice, capital);
        _approveOpen(alice, USDX, capital, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, debt);
        p.capitalToken = USDX;
        p.steps = _one(_step(USDX, WETH, capital + debt, 50));

        vm.prank(alice);
        (uint256 supplied, uint256 borrowed,) = executor.open(p);
        assertEq(supplied, 3e18);
        assertEq(borrowed, debt);
        assertEq(_bal(USDX, alice), 0, "capital pulled");
        assertEq(_bal(vUSDX, alice), debt);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
        _assertClean();
    }

    function test_capital_otherToken_oneCapitalStep() public {
        // 0.1 WBTC = 2700 $ = 1.5 WETH, then x2
        uint256 capital = 0.1e8;
        deal(WBTC, alice, capital);
        uint256 debt = 2700e6;
        _approveOpen(alice, WBTC, capital, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, debt);
        p.capitalToken = WBTC;
        p.capitalSteps = _one(_step(WBTC, WETH, capital, 50));

        vm.expectEmit(true, true, true, true, address(executor));
        emit LeverageExecutorV2.Swapped(alice, address(router), WBTC, WETH, capital, 1.5e18);
        vm.expectEmit(true, true, true, true, address(executor));
        emit LeverageExecutorV2.Swapped(alice, address(router), USDX, WETH, debt, 1.5e18);
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);
        assertEq(supplied, 3e18);
        assertEq(_bal(WBTC, alice), 0);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
        _assertClean();
    }

    function test_capital_otherToken_twoCapitalSteps() public {
        uint256 capital = 0.1e8;
        deal(WBTC, alice, capital);
        uint256 debt = 2700e6;
        _approveOpen(alice, WBTC, capital, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, debt);
        p.capitalToken = WBTC;
        p.capitalSteps = _two(WBTC, USDX, WETH, capital, 50);
        uint256 usdxFromCapital = router.quote(WBTC, USDX, capital);

        uint256 usdxBefore = _bal(USDX, alice);
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);
        assertGt(supplied, 2.98e18);
        // the USDX the second capital step did not sell is returned (USDX is also the debt asset)
        assertEq(_bal(USDX, alice) - usdxBefore, usdxFromCapital - p.capitalSteps[0].minOut);
        _assertClean();
    }

    function test_capital_otherToken_noDebt_isAPlainSwapAndDeposit() public {
        uint256 capital = 0.1e8;
        deal(WBTC, alice, capital);
        vm.prank(alice);
        IERC20(WBTC).approve(address(executor), capital);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, 0);
        p.capitalToken = WBTC;
        p.capitalSteps = _one(_step(WBTC, WETH, capital, 50));
        p.steps = _none();
        vm.prank(alice);
        (uint256 supplied, uint256 borrowed, uint256 hf) = executor.open(p);
        assertEq(supplied, 1.5e18);
        assertEq(borrowed, 0);
        assertEq(hf, type(uint256).max);
        assertEq(_bal(vUSDX, alice), 0);
        _assertClean();
    }

    function test_capital_collateral_noDebt_isAPlainDeposit() public {
        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, 0);
        p.steps = _none();
        vm.recordLogs();
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);
        assertEq(supplied, 1e18);
        assertEq(_bal(aWETH, alice), 1e18);
        _assertClean();
    }

    function test_capital_debtAsset_noDebt_swapAndDeposit() public {
        deal(USDX, alice, 1800e6);
        vm.prank(alice);
        IERC20(USDX).approve(address(executor), 1800e6);
        LeverageExecutorV2.OpenParams memory p = _openParams(1800e6, 0);
        p.capitalToken = USDX;
        p.steps = _one(_step(USDX, WETH, 1800e6, 50));
        vm.prank(alice);
        (uint256 supplied,,) = executor.open(p);
        assertEq(supplied, 1e18);
        assertEq(_bal(vUSDX, alice), 0);
        _assertClean();
    }

    function test_capital_routerUsesLess_leftoversReturned() public {
        uint256 capital = 0.1e8;
        deal(WBTC, alice, capital);
        uint256 debt = 2700e6;
        _approveOpen(alice, WBTC, capital, debt);
        router.setUseInputBps(9_000);
        uint256 usdxBefore = _bal(USDX, alice);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, debt);
        p.capitalToken = WBTC;
        p.capitalSteps = _one(_step(WBTC, WETH, capital, 1_500));
        p.steps = _one(_step(USDX, WETH, debt, 1_500));
        vm.prank(alice);
        executor.open(p);
        assertEq(_bal(WBTC, alice), capital / 10, "unused capital returned");
        assertEq(_bal(USDX, alice) - usdxBefore, debt / 10, "unused debt returned");
        _assertClean();
    }

    function test_revert_capital_collateralWithCapitalSteps() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.capitalSteps = _one(_step(WETH, USDX, 1e18, 50));
        vm.expectRevert(LeverageExecutorV2.UnexpectedSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_debtAssetWithCapitalSteps() public {
        deal(USDX, alice, 1800e6);
        _approveOpen(alice, USDX, 1800e6, 3600e6);
        LeverageExecutorV2.OpenParams memory p = _openParams(1800e6, 3600e6);
        p.capitalToken = USDX;
        p.capitalSteps = _one(_step(USDX, WETH, 1800e6, 50));
        vm.expectRevert(LeverageExecutorV2.UnexpectedSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_stepsWithoutCapital() public {
        vm.prank(alice);
        IDebtToken(vUSDX).approveDelegation(address(executor), 1000e6);
        _open(alice, 1e18, 200);
        LeverageExecutorV2.OpenParams memory p = _openParams(0, 1000e6);
        p.capitalSteps = _one(_step(WBTC, WETH, 1, 50));
        vm.expectRevert(LeverageExecutorV2.UnexpectedSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_stepsWithoutAnythingToSell() public {
        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, 0); // steps still set
        vm.expectRevert(LeverageExecutorV2.UnexpectedSteps.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_capitalChainWrongFinalToken() public {
        uint256 capital = 0.1e8;
        deal(WBTC, alice, capital);
        _approveOpen(alice, WBTC, capital, 2700e6);
        LeverageExecutorV2.OpenParams memory p = _openParams(capital, 2700e6);
        p.capitalToken = WBTC;
        p.capitalSteps = _one(_step(WBTC, USDX, capital, 50));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.WrongFinalToken.selector, USDX, WETH));
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_zeroEverything() public {
        LeverageExecutorV2.OpenParams memory p = _openParams(0, 0);
        p.steps = _none();
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_capital_withoutApproval() public {
        uint256 debt = _debtFor(1e18, 300);
        vm.prank(alice);
        IDebtToken(vUSDX).approveDelegation(address(executor), debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.expectRevert();
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_sameAsset() public {
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, 1e6);
        p.debtAsset = WETH;
        vm.expectRevert(LeverageExecutorV2.SameAsset.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_zeroAddressToken() public {
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, 1e6);
        p.steps[0].tokenOut = address(0);
        vm.expectRevert(LeverageExecutorV2.ZeroAddress.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_tooMuchLeverage() public {
        uint256 debt = _debtFor(1e18, 700);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.expectRevert(); // Aave: collateral cannot cover the new borrow
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_withoutDelegation() public {
        uint256 debt = _debtFor(1e18, 300);
        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.expectRevert(); // Aave: not enough borrow allowance
        vm.prank(alice);
        executor.open(p);
    }

    // ---------------------------------------------------------------------------------------------
    // change 3: guard
    // ---------------------------------------------------------------------------------------------

    function test_guard_deadlineIsInclusive() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.guard.deadline = block.timestamp;
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_guard_expired() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.warp(p.guard.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.Expired.selector, p.guard.deadline));
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_guard_zeroDeadlineIsNotNoDeadline() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.guard.deadline = 0;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.Expired.selector, 0));
        vm.prank(alice);
        executor.open(p);
    }

    function test_guard_minHealthFactor_exactPasses_oneAboveFails() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (,, uint256 hf) = executor.open(p);
        vm.revertToState(snap);

        p.guard.minHealthFactor = hf + 1;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.HealthFactorTooLow.selector, hf, hf + 1));
        vm.prank(alice);
        executor.open(p);

        p.guard.minHealthFactor = hf;
        vm.prank(alice);
        executor.open(p);
        assertEq(_hf(alice), hf);
    }

    function test_revert_guard_slippageWithinStepsButHFTooLow() public {
        // every step passes its own minimum, the final HF does not: the guard catches what minOut cannot
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        p.steps = _one(_step(USDX, WETH, debt, 500));
        p.guard.minHealthFactor = 1.4e18; // ~1.43 expected at the quote
        router.setSlippageBps(400);
        vm.expectPartialRevert(LeverageExecutorV2.HealthFactorTooLow.selector);
        vm.prank(alice);
        executor.open(p);
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    function _deployWith(address[] memory routers) internal returns (LeverageExecutorV2) {
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](0);
        return new LeverageExecutorV2(pool, routers, lenders);
    }

    function _stepFor(LeverageExecutorV2 ex, address tokenIn, address tokenOut, uint256 amountIn, uint256 tolBps)
        internal
        view
        returns (LeverageExecutorV2.Step memory)
    {
        return LeverageExecutorV2.Step({
            router: address(router),
            tokenOut: tokenOut,
            data: abi.encodeCall(router.swap, (tokenIn, tokenOut, amountIn, address(ex))),
            minOut: router.quote(tokenIn, tokenOut, amountIn) * (10_000 - tolBps) / 10_000
        });
    }
}

interface ICreditDelegationTokenLike {
    function delegationWithSig(
        address delegator,
        address delegatee,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract MintableToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract RogueRouterStub {
    fallback() external {}
}
