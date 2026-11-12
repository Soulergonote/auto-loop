// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Vm} from "forge-std/Vm.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {LazyBalancer} from "../mocks/MockFlashLenders.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

/// @notice swapCollateral (change 4): replace the collateral, debt unchanged, through each flash lender, and the
/// Pendle-PT-like case of an asset that is collateral only inside an eMode (base LTV 0).
contract V2SwapCollateralTest is V2Base {
    uint8 internal constant PT_EMODE = 7;

    function _swapParams(uint256 fromAmount, uint256 sellAmount, uint256 toAmount, address lender)
        internal
        view
        returns (LeverageExecutorV2.SwapCollateralParams memory)
    {
        return LeverageExecutorV2.SwapCollateralParams({
            fromAsset: WETH,
            toAsset: WBTC,
            fromAmount: fromAmount,
            toAmount: toAmount,
            steps: _one(_step(WETH, WBTC, sellAmount, 50)),
            flashLender: lender,
            guard: _guard()
        });
    }

    /// @dev alice 3x WETH/USDX, then all of her WETH collateral -> WBTC, borrowing 99 % of the quote
    function _openAndFullSwapParams(address lender) internal returns (LeverageExecutorV2.SwapCollateralParams memory) {
        _open(alice, 1e18, 300);
        uint256 aBal = _bal(aWETH, alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        return _swapParams(MAX, aBal, router.quote(WETH, WBTC, aBal) * 99 / 100, lender);
    }

    function _swapAs(address user, LeverageExecutorV2.SwapCollateralParams memory p)
        internal
        returns (LeverageExecutorV2.SwapCollateralResult memory r)
    {
        vm.prank(user);
        r = executor.swapCollateral(p);
    }

    // ---------------------------------------------------------------------------------------------
    // through each lender
    // ---------------------------------------------------------------------------------------------

    function test_swapCollateral_full_viaAave() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(pool));
        uint256 aBal = _bal(aWETH, alice);
        uint256 debt = _bal(vUSDX, alice);
        uint256 out = router.quote(WETH, WBTC, aBal);

        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);

        assertEq(r.withdrawn, aBal);
        assertApproxEqAbs(r.flashPremium, p.toAmount * 5 / 10_000, 1);
        assertEq(r.supplied, out - r.flashPremium, "everything bought, minus the premium, is supplied");
        assertApproxEqAbs(_bal(aWBTC, alice), r.supplied, 1);
        assertEq(_bal(aWETH, alice), 0, "old collateral gone");
        assertEq(_bal(vUSDX, alice), debt, "debt untouched");
        assertEq(r.healthFactor, _hf(alice));
        _assertClean();
    }

    function test_swapCollateral_full_viaMorpho() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        uint256 out = router.quote(WETH, WBTC, _bal(aWETH, alice));
        uint256 morphoBefore = _bal(WBTC, address(morpho));
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);
        assertEq(r.flashPremium, 0);
        assertEq(r.supplied, out);
        assertEq(_bal(WBTC, address(morpho)), morphoBefore);
        assertEq(_bal(aWETH, alice), 0);
        _assertClean();
    }

    function test_swapCollateral_full_viaBalancer_withFee() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(balancer));
        balancer.setFeeBps(2);
        uint256 out = router.quote(WETH, WBTC, _bal(aWETH, alice));
        uint256 vaultBefore = _bal(WBTC, address(balancer));
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);
        assertEq(r.flashPremium, p.toAmount * 2 / 10_000);
        assertEq(r.supplied, out - r.flashPremium);
        assertEq(_bal(WBTC, address(balancer)), vaultBefore + r.flashPremium);
        _assertClean();
    }

    function test_swapCollateral_partial_keepsHealthFactorClose() public {
        _open(alice, 1e18, 300);
        uint256 hfBefore = _hf(alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), 1e18);
        LeverageExecutorV2.SwapCollateralParams memory p =
            _swapParams(1e18, 1e18, router.quote(WETH, WBTC, 1e18) * 995 / 1000, address(morpho));
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);
        assertEq(r.withdrawn, 1e18);
        assertApproxEqAbs(_bal(aWETH, alice), 2e18, 2);
        assertApproxEqRel(r.healthFactor, hfBefore, 0.001e18, "same LTV/LT, same value");
        assertEq(IERC20(aWETH).allowance(alice, address(executor)), 0);
        _assertClean();
    }

    function test_swapCollateral_twoSteps_viaUSDX() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        uint256 aBal = _bal(aWETH, alice);
        p.steps = _two(WETH, USDX, WBTC, aBal, 50);
        p.toAmount = p.steps[1].minOut;
        uint256 usdxBefore = _bal(USDX, alice);
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);
        assertEq(r.supplied, router.quote(USDX, WBTC, p.steps[0].minOut));
        assertEq(_bal(USDX, alice) - usdxBefore, router.quote(WETH, USDX, aBal) - p.steps[0].minOut, "USDX leftover");
        _assertClean();
    }

    function test_swapCollateral_routerUsesLess_unsoldCollateralReturned() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        uint256 aBal = _bal(aWETH, alice);
        router.setUseInputBps(9_000);
        p.steps = _one(_step(WETH, WBTC, aBal, 1_500));
        p.toAmount = p.steps[0].minOut;
        uint256 wethBefore = _bal(WETH, alice);
        _swapAs(alice, p);
        assertEq(_bal(WETH, alice) - wethBefore, aBal - aBal * 9_000 / 10_000, "unsold WETH back to the wallet");
        _assertClean();
    }

    function test_swapCollateralWithSig() public {
        _open(alice, 1e18, 300);
        uint256 aBal = _bal(aWETH, alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = EIP712SigUtils.getTypedDataHash(
            EIP712SigUtils.Permit({
                owner: alice, spender: address(executor), value: aBal, nonce: 0, deadline: deadline
            }),
            bytes(IERC20Metadata(aWETH).name()),
            bytes("1"),
            aWETH
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);
        LeverageExecutorV2.SwapCollateralParams memory p =
            _swapParams(MAX, aBal, router.quote(WETH, WBTC, aBal) * 99 / 100, address(morpho));
        vm.prank(alice);
        executor.swapCollateralWithSig(p, LeverageExecutorV2.Signature(aBal, deadline, v, r, s));
        assertEq(_bal(aWETH, alice), 0);
        assertGt(_bal(aWBTC, alice), 0);
        _assertClean();
    }

    function test_swapCollateral_emitsCollateralSwappedWithTheReturnedResult() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(pool));
        vm.recordLogs();
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);
        bytes32 sig = keccak256("CollateralSwapped(address,address,address,address,(uint256,uint256,uint256,uint256))");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor) || logs[i].topics[0] != sig) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(WETH))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(WBTC))));
            (address lender, LeverageExecutorV2.SwapCollateralResult memory e) =
                abi.decode(logs[i].data, (address, LeverageExecutorV2.SwapCollateralResult));
            assertEq(lender, address(pool));
            assertEq(keccak256(abi.encode(e)), keccak256(abi.encode(r)));
            ++found;
        }
        assertEq(found, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // reverts
    // ---------------------------------------------------------------------------------------------

    function test_revert_swapCollateral_swapDoesNotCoverTheLoan() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(pool));
        uint256 out = router.quote(WETH, WBTC, _bal(aWETH, alice));
        p.toAmount = out; // + 0.05 % premium > out
        vm.expectRevert(
            abi.encodeWithSelector(
                LeverageExecutorV2.InsufficientToRepayFlashLoan.selector, out, out + (out * 5 + 5_000) / 10_000
            )
        );
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_slippage() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        router.setSlippageBps(100);
        vm.expectPartialRevert(SwapExecutorBase.InsufficientOutput.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_wrongFinalToken() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        p.steps = _one(_step(WETH, USDX, 1e18, 50));
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.WrongFinalToken.selector, USDX, WBTC));
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_noSteps() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        p.steps = _none();
        vm.expectRevert(SwapExecutorBase.InvalidSteps.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_sameAsset() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _swapParams(1, 1, 1, address(morpho));
        p.toAsset = WETH;
        vm.expectRevert(SwapExecutorBase.SameAsset.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_zeroAmounts() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _swapParams(0, 1, 1, address(morpho));
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        _swapAs(alice, p);
        p = _swapParams(1, 1, 0, address(morpho));
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_maxWithNoCollateral() public {
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.SwapCollateralParams memory p = _swapParams(MAX, 1e18, 1e6, address(morpho));
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_withoutATokenApproval() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.SwapCollateralParams memory p = _swapParams(1e18, 1e18, 1e6, address(morpho));
        vm.expectRevert();
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_expired() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        vm.warp(p.guard.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.Expired.selector, p.guard.deadline));
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_minHealthFactor() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        p.guard.minHealthFactor = _hf(alice) * 2;
        vm.expectPartialRevert(LeverageExecutorV2.HealthFactorTooLow.selector);
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_unregisteredLender() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.FlashLenderNotAllowed.selector, address(0xBEEF)));
        _swapAs(alice, p);
    }

    function test_revert_swapCollateral_lenderNeverCallsBack() public {
        LazyBalancer lazy = new LazyBalancer();
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](1);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, address(lazy));
        LeverageExecutorV2 ex = new LeverageExecutorV2(pool, routers, lenders);
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(ex), MAX);
        LeverageExecutorV2.SwapCollateralParams memory p = _swapParams(MAX, 3e18, 0.1e8, address(lazy));
        vm.expectRevert(LeverageExecutorV2.FlashLoanNotExecuted.selector);
        vm.prank(alice);
        ex.swapCollateral(p);
    }

    function test_revert_swapCollateral_attackerCannotMoveVictimCollateral() public {
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        // alice left an unlimited aWETH allowance; the attacker calls with her parameters
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector); // max = the attacker's own (empty) balance
        _swapAs(attacker, p);
        p.fromAmount = 1e18;
        vm.expectRevert(); // transferFrom(attacker): no balance
        _swapAs(attacker, p);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
    }

    function test_revert_swapCollateral_toAssetNotCollateralForUser() public {
        // WBTC loses its LTV outside any eMode: once supplied it does not back the debt, so the old collateral
        // cannot leave
        vm.prank(poolAdmin);
        contracts.poolConfiguratorProxy.configureReserveAsCollateral(WBTC, 0, 75_00, 105_00);
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        vm.expectRevert(); // Aave: health factor below 1 on the aToken transfer
        _swapAs(alice, p);
    }

    // ---------------------------------------------------------------------------------------------
    // Pendle-PT-like: collateral only inside an eMode (base LTV 0)
    // ---------------------------------------------------------------------------------------------

    /// @dev WBTC plays the PT: base LTV 0, eMode PT_EMODE with LTV 90 % / LT 93 %, USDX borrowable in it
    function _ptLikeMarket() internal {
        vm.startPrank(poolAdmin);
        contracts.poolConfiguratorProxy.configureReserveAsCollateral(WBTC, 0, 75_00, 105_00);
        contracts.poolConfiguratorProxy.setEModeCategory(PT_EMODE, 90_00, 93_00, 101_00, "PT-like", false);
        contracts.poolConfiguratorProxy.setAssetCollateralInEMode(WBTC, PT_EMODE, true);
        contracts.poolConfiguratorProxy.setAssetBorrowableInEMode(USDX, PT_EMODE, true);
        vm.stopPrank();
    }

    function _openPtLike(address user, uint256 levX100) internal returns (LeverageExecutorV2.OpenParams memory p) {
        uint256 capital = 0.1e8; // 2700 $
        deal(WBTC, user, capital);
        uint256 debt = 2700e6 * (levX100 - 100) / 100;
        _approveOpen(user, WBTC, capital, debt);
        p = _openParams(capital, debt);
        p.collateralAsset = WBTC;
        p.capitalToken = WBTC;
        p.steps = _one(_step(USDX, WBTC, debt, 50));
    }

    function test_ptLike_open_8x_insideEMode() public {
        _ptLikeMarket();
        vm.prank(alice);
        _setUserEMode(PT_EMODE);
        LeverageExecutorV2.OpenParams memory p = _openPtLike(alice, 800);
        vm.prank(alice);
        (uint256 supplied, uint256 borrowed, uint256 hf) = executor.open(p);

        assertEq(supplied, 0.8e8);
        assertEq(borrowed, 18_900e6);
        (,,,, uint256 ltv,) = pool.getUserAccountData(alice);
        assertEq(ltv, 90_00, "the PT counts as collateral at the eMode LTV");
        assertApproxEqRel(hf, uint256(0.8e8) * 27_000 * 93 / 100 * 1e18 / 1e8 / 18_900, 0.001e18);
        _assertClean();
    }

    function test_revert_ptLike_open_outsideEMode() public {
        _ptLikeMarket();
        LeverageExecutorV2.OpenParams memory p = _openPtLike(alice, 300);
        vm.expectRevert(); // Aave: no collateral (base LTV 0)
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_ptLike_open_ltvZeroedInEMode() public {
        // what Aave's risk stewards do to a PT close to maturity or under stress
        _ptLikeMarket();
        vm.prank(poolAdmin);
        contracts.poolConfiguratorProxy.setAssetLtvzeroInEMode(WBTC, PT_EMODE, true);
        vm.prank(alice);
        _setUserEMode(PT_EMODE);
        LeverageExecutorV2.OpenParams memory p = _openPtLike(alice, 300);
        vm.expectRevert();
        vm.prank(alice);
        executor.open(p);
    }

    function test_ptLike_swapCollateral_intoEModeOnlyAsset() public {
        // rolling into a new PT: alice is in the PT eMode with WETH collateral (base LTV) and moves it to the PT
        _ptLikeMarket();
        vm.prank(alice);
        _setUserEMode(PT_EMODE);
        LeverageExecutorV2.SwapCollateralParams memory p = _openAndFullSwapParams(address(morpho));
        uint256 debt = _bal(vUSDX, alice);
        LeverageExecutorV2.SwapCollateralResult memory r = _swapAs(alice, p);

        (,,,, uint256 ltv,) = pool.getUserAccountData(alice);
        assertEq(ltv, 90_00, "new collateral enabled at the eMode LTV");
        assertEq(_bal(aWETH, alice), 0);
        assertEq(_bal(vUSDX, alice), debt);
        assertGt(r.healthFactor, 1e18);
        _assertClean();
    }

    function test_ptLike_rollOutAtFullLeverage() public {
        // 8x in the "PT", then everything moved to WETH... which is not collateral in the PT eMode at that
        // leverage: Aave refuses, the position stays as it was
        _ptLikeMarket();
        vm.prank(alice);
        _setUserEMode(PT_EMODE);
        LeverageExecutorV2.OpenParams memory o = _openPtLike(alice, 800);
        vm.prank(alice);
        executor.open(o);
        uint256 aBal = _bal(aWBTC, alice);
        vm.prank(alice);
        IERC20(aWBTC).approve(address(executor), MAX);
        LeverageExecutorV2.SwapCollateralParams memory p = LeverageExecutorV2.SwapCollateralParams({
            fromAsset: WBTC,
            toAsset: WETH,
            fromAmount: MAX,
            toAmount: router.quote(WBTC, WETH, aBal) * 99 / 100,
            steps: _one(_step(WBTC, WETH, aBal, 50)),
            flashLender: address(morpho),
            guard: _guard()
        });
        vm.expectRevert();
        _swapAs(alice, p);
        assertEq(_bal(aWBTC, alice), aBal);
    }

    function _setUserEMode(uint8 id) internal {
        contracts.poolProxy.setUserEMode(id);
    }
}
