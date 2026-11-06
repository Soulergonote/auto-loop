// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Vm} from "forge-std/Vm.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {MockMorpho, LazyLender} from "../mocks/MockFlashLenders.sol";
import {V2Base} from "./V2Base.sol";

/// @notice Close and deleverage: free flash lenders (change 5), swap chains on the way out (change 1), guard
/// (change 3), return values and events (change 6).
contract V2CloseTest is V2Base {
    function _fullCloseParams(address lender) internal returns (LeverageExecutorV2.CloseParams memory p) {
        uint256 debt = _bal(vUSDX, alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        p = _closeParams(MAX, MAX, _wethToCover(debt), lender);
    }

    function _closeAs(address user, LeverageExecutorV2.CloseParams memory p)
        internal
        returns (LeverageExecutorV2.CloseResult memory r)
    {
        vm.prank(user);
        r = executor.close(p);
    }

    // ---------------------------------------------------------------------------------------------
    // full close through each lender
    // ---------------------------------------------------------------------------------------------

    function test_close_full_viaAave_paysPremium() public {
        _open(alice, 1e18, 300);
        vm.warp(block.timestamp + 30 days);
        uint256 debt = _bal(vUSDX, alice);
        uint256 aBal = _bal(aWETH, alice);
        uint256 wethBefore = _bal(WETH, alice);
        uint256 usdxBefore = _bal(USDX, alice);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(pool));

        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, p);

        assertGt(debt, 3600e6, "interest accrued");
        assertEq(r.debtRepaid, debt);
        assertEq(r.collateralWithdrawn, aBal);
        assertApproxEqAbs(r.flashPremium, debt * 5 / 10_000, 1, "0.05 % Aave premium");
        assertEq(r.collateralReturned, _bal(WETH, alice) - wethBefore);
        assertEq(r.collateralReturned, aBal - p.collateralToSell);
        assertEq(r.debtReturned, _bal(USDX, alice) - usdxBefore);
        assertEq(r.debtReturned, router.quote(WETH, USDX, p.collateralToSell) - debt - r.flashPremium);
        assertEq(r.healthFactor, type(uint256).max);
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, alice), 0);
        _assertClean();
    }

    function test_close_full_viaMorpho_isFree() public {
        _open(alice, 1e18, 300);
        vm.warp(block.timestamp + 30 days);
        uint256 debt = _bal(vUSDX, alice);
        uint256 usdxBefore = _bal(USDX, alice);
        uint256 morphoBefore = _bal(USDX, address(morpho));
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));

        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, p);

        assertEq(r.flashPremium, 0);
        assertEq(r.debtRepaid, debt);
        assertEq(r.debtReturned, _bal(USDX, alice) - usdxBefore);
        assertEq(r.debtReturned, router.quote(WETH, USDX, p.collateralToSell) - debt);
        assertEq(_bal(USDX, address(morpho)), morphoBefore, "Morpho got exactly its loan back");
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, alice), 0);
        _assertClean();
    }

    function test_close_morphoReturnsExactlyThePremiumMoreThanAave() public {
        _open(alice, 1e18, 400);
        vm.warp(block.timestamp + 7 days);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(pool));

        uint256 snap = vm.snapshotState();
        LeverageExecutorV2.CloseResult memory viaAave = _closeAs(alice, p);
        vm.revertToState(snap);
        p.flashLender = address(morpho);
        LeverageExecutorV2.CloseResult memory viaMorpho = _closeAs(alice, p);

        assertGt(viaAave.flashPremium, 0);
        assertEq(viaMorpho.debtReturned - viaAave.debtReturned, viaAave.flashPremium);
        assertEq(viaMorpho.collateralReturned, viaAave.collateralReturned);
    }

    function test_close_full_viaBalancer_noFee() public {
        _open(alice, 1e18, 300);
        uint256 balBefore = _bal(USDX, address(balancer));
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, _fullCloseParams(address(balancer)));
        assertEq(r.flashPremium, 0);
        assertEq(_bal(USDX, address(balancer)), balBefore);
        assertEq(_bal(vUSDX, alice), 0);
        _assertClean();
    }

    function test_close_full_viaBalancer_withFee() public {
        _open(alice, 1e18, 300);
        balancer.setFeeBps(3);
        uint256 debt = _bal(vUSDX, alice);
        uint256 balBefore = _bal(USDX, address(balancer));
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, _fullCloseParams(address(balancer)));
        assertEq(r.flashPremium, debt * 3 / 10_000);
        assertEq(_bal(USDX, address(balancer)), balBefore + r.flashPremium, "fee paid to the vault");
        _assertClean();
    }

    function test_close_ofAPositionOpenedWithoutTheExecutor() public {
        // any Aave position can be closed (v1 positions, positions opened on aave.com)
        deal(WETH, bob, 2e18);
        vm.startPrank(bob);
        IERC20(WETH).approve(address(pool), 2e18);
        pool.supply(WETH, 2e18, bob, 0);
        contractsBorrow(bob, 1500e6);
        IERC20(aWETH).approve(address(executor), MAX);
        vm.stopPrank();
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, _wethToCover(1500e6), address(morpho));
        vm.prank(bob);
        executor.close(p);
        assertEq(_bal(vUSDX, bob), 0);
        assertEq(_bal(aWETH, bob), 0);
        _assertClean();
    }

    function contractsBorrow(address, uint256 amount) internal {
        contracts.poolProxy.borrow(USDX, amount, 2, 0, bob);
    }

    // ---------------------------------------------------------------------------------------------
    // partial close, chains, signatures, events
    // ---------------------------------------------------------------------------------------------

    function test_close_partial_viaMorpho() public {
        _open(alice, 1e18, 300);
        uint256 hfBefore = _hf(alice);
        uint256 repay = 1800e6;
        uint256 toSell = _wethToCover(repay);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), toSell);
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, _closeParams(repay, toSell, toSell, address(morpho)));

        assertEq(r.debtRepaid, repay);
        assertEq(r.collateralWithdrawn, toSell);
        assertEq(r.collateralReturned, 0);
        assertEq(_bal(vUSDX, alice), 1800e6);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18 - toSell, 2);
        assertGt(r.healthFactor, hfBefore);
        assertEq(r.healthFactor, _hf(alice));
        assertEq(IERC20(aWETH).allowance(alice, address(executor)), 0, "exact aToken allowance consumed");
        _assertClean();
    }

    function test_close_twoSteps_viaWBTC() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        uint256 toSell = _wethToCover(debt) * 101 / 100;
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        p.collateralToSell = toSell;
        p.steps = _two(WETH, WBTC, USDX, toSell, 50);
        uint256 wbtcBefore = _bal(WBTC, alice);
        _closeAs(alice, p);
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(WBTC, alice) - wbtcBefore, router.quote(WETH, WBTC, toSell) - p.steps[0].minOut, "WBTC leftover");
        _assertClean();
    }

    function test_close_repayMoreThanDebt_extraReturned() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        uint256 usdxBefore = _bal(USDX, alice);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        p.repayAmount = debt + 500e6;
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, p);
        assertEq(r.debtRepaid, debt, "Aave takes only the debt");
        assertEq(_bal(USDX, alice) - usdxBefore, router.quote(WETH, USDX, p.collateralToSell) - debt);
        _assertClean();
    }

    function test_closeWithSig() public {
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
        LeverageExecutorV2.CloseParams memory p =
            _closeParams(MAX, MAX, _wethToCover(_bal(vUSDX, alice)), address(balancer));
        vm.prank(alice);
        executor.closeWithSig(p, LeverageExecutorV2.Signature(aBal, deadline, v, r, s));
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, alice), 0);
        _assertClean();
    }

    function test_close_emitsPositionClosedWithTheReturnedResult() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(pool));
        vm.expectEmit(true, true, true, false, address(executor));
        emit LeverageExecutorV2.Swapped(alice, address(router), WETH, USDX, p.collateralToSell, 0);
        vm.recordLogs();
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, p);

        bytes32 sig = keccak256(
            "PositionClosed(address,address,address,address,(uint256,uint256,uint256,uint256,uint256,uint256))"
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(executor) || logs[i].topics[0] != sig) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(WETH))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(USDX))));
            (address lender, LeverageExecutorV2.CloseResult memory e) =
                abi.decode(logs[i].data, (address, LeverageExecutorV2.CloseResult));
            assertEq(lender, address(pool));
            assertEq(keccak256(abi.encode(e)), keccak256(abi.encode(r)), "event = return value");
            ++found;
        }
        assertEq(found, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // reverts
    // ---------------------------------------------------------------------------------------------

    function test_revert_close_unregisteredLender() public {
        _open(alice, 1e18, 300);
        MockMorpho other = new MockMorpho();
        _fund(address(other));
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(other));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.FlashLenderNotAllowed.selector, address(other)));
        _closeAs(alice, p);
    }

    function test_revert_close_routerIsNotALender() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(router));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.FlashLenderNotAllowed.selector, address(router)));
        _closeAs(alice, p);
    }

    function test_revert_close_lenderNeverCallsBack() public {
        LazyLender lazy = new LazyLender();
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](1);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, address(lazy));
        LeverageExecutorV2 ex = new LeverageExecutorV2(pool, routers, lenders);

        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(ex), MAX);
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, 1e18, address(lazy));
        vm.expectRevert(LeverageExecutorV2.FlashLoanNotExecuted.selector);
        vm.prank(alice);
        ex.close(p);
    }

    function test_revert_close_notEnoughSoldToRepay() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        p.collateralToSell = _wethToCover(debt) / 2;
        p.steps = _one(_step(WETH, USDX, p.collateralToSell, 50));
        vm.expectPartialRevert(LeverageExecutorV2.InsufficientToRepayFlashLoan.selector);
        _closeAs(alice, p);
    }

    function test_revert_close_balancerFeeNotCovered() public {
        _open(alice, 1e18, 300);
        balancer.setFeeBps(200); // 2 %, more than the 1 % buffer
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(balancer));
        vm.expectPartialRevert(LeverageExecutorV2.InsufficientToRepayFlashLoan.selector);
        _closeAs(alice, p);
    }

    function test_revert_close_sellMoreThanWithdrawn() public {
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), 1e18);
        LeverageExecutorV2.CloseParams memory p = _closeParams(1800e6, 1e18, 1e18 + 1, address(morpho));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.SellExceedsWithdrawn.selector, 1e18 + 1, 1e18));
        _closeAs(alice, p);
    }

    function test_revert_close_stepsWithNothingToSell() public {
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), 1e18);
        LeverageExecutorV2.CloseParams memory p = _closeParams(1800e6, 1e18, 0, address(morpho));
        vm.expectRevert(LeverageExecutorV2.UnexpectedSteps.selector);
        _closeAs(alice, p);
    }

    function test_revert_close_chainMustEndInDebtAsset() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        p.steps = _one(_step(WETH, WBTC, p.collateralToSell, 50));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.WrongFinalToken.selector, WBTC, USDX));
        _closeAs(alice, p);
    }

    function test_revert_close_withdrawWouldBreakHF() public {
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        // repays a little, withdraws everything
        LeverageExecutorV2.CloseParams memory p = _closeParams(100e6, MAX, _wethToCover(100e6), address(morpho));
        vm.expectRevert(); // Aave: health factor lower than liquidation threshold
        _closeAs(alice, p);
    }

    function test_revert_close_noDebt() public {
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, 1e18, address(morpho));
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        _closeAs(alice, p);
    }

    function test_revert_close_sameAsset() public {
        LeverageExecutorV2.CloseParams memory p = _closeParams(1, 1, 1, address(morpho));
        p.debtAsset = WETH;
        vm.expectRevert(LeverageExecutorV2.SameAsset.selector);
        _closeAs(alice, p);
    }

    function test_revert_close_withoutATokenApproval() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p =
            _closeParams(MAX, MAX, _wethToCover(_bal(vUSDX, alice)), address(morpho));
        vm.expectRevert();
        _closeAs(alice, p);
    }

    // ---------------------------------------------------------------------------------------------
    // guard
    // ---------------------------------------------------------------------------------------------

    function test_revert_close_expired() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        vm.warp(p.guard.deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.Expired.selector, p.guard.deadline));
        _closeAs(alice, p);
    }

    function test_revert_close_partial_minHealthFactor() public {
        _open(alice, 1e18, 300);
        uint256 repay = 1800e6;
        uint256 toSell = _wethToCover(repay);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), toSell);
        LeverageExecutorV2.CloseParams memory p = _closeParams(repay, toSell, toSell, address(morpho));
        p.guard.minHealthFactor = 5e18;
        vm.expectPartialRevert(LeverageExecutorV2.HealthFactorTooLow.selector);
        _closeAs(alice, p);
    }

    function test_close_full_passesAnyMinHealthFactor() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _fullCloseParams(address(morpho));
        p.guard.minHealthFactor = type(uint256).max;
        LeverageExecutorV2.CloseResult memory r = _closeAs(alice, p);
        assertEq(r.healthFactor, type(uint256).max);
    }
}
