// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {IMorpho, MarketParams, Authorization} from "../../src/interfaces/IMorpho.sol";
import {AttackRouter} from "../mocks/AttackRouter.sol";
import {IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {MockMorphoOracle} from "./MorphoMocks.sol";
import {MorphoBase, IMorphoAdmin} from "./MorphoBase.sol";

contract MorphoOpenTest is MorphoBase {
    function test_openWithAuth_levers_and_leaves_nothing() public {
        _openAsUser();
        (uint256 shares, uint256 coll) = _position(m1, user);
        assertEq(coll, 5000e18, "collateral");
        assertGt(shares, 0);
        assertEq(_debt(m1, user), 3800e6, "debt");
        // 4750 $ x 91.5 % / 3800 $
        assertApproxEqRel(ex.healthFactor(m1, user), 1.14375e18, 1e12);
        assertEq(pt1.balanceOf(user), 9000e18);
        _assertClean();
    }

    function test_open_returns_and_event() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectEmit(true, true, false, false, address(ex));
        emit LeverageExecutorMorpho.PositionOpened(user, _id(m1), address(pt1), 1000e18, 0, 0, 0);
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.openWithAuth(p, a);
        vm.stopPrank();
        assertEq(supplied, 5000e18);
        assertEq(borrowed, 3800e6);
        assertApproxEqRel(hf, 1.14375e18, 1e12);
    }

    function test_open_with_persistent_authorization() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex), true);
        pt1.approve(address(ex), p.capitalAmount);
        ex.open(p);
        vm.stopPrank();
        assertEq(_debt(m1, user), 3800e6);
    }

    function test_open_without_authorization_reverts() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(bytes("unauthorized"));
        ex.open(p);
        vm.stopPrank();
    }

    function test_open_with_loan_token_capital() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.capitalToken = address(usdc);
        p.capitalAmount = 950e6;
        p.steps = _one(_step(address(usdc), address(pt1), 4750e6, 4990e18));
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        usdc.approve(address(ex), p.capitalAmount);
        ex.openWithAuth(p, a);
        vm.stopPrank();
        (, uint256 coll) = _position(m1, user);
        assertEq(coll, 5000e18);
        assertEq(_debt(m1, user), 3800e6);
        _assertClean();
    }

    function test_open_with_other_capital_token() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.capitalToken = address(weth);
        p.capitalAmount = 1e18; // 3000 $ -> 3157.89 PT1
        p.capitalSteps = _one(_step(address(weth), address(pt1), 1e18, 3150e18));
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        weth.approve(address(ex), p.capitalAmount);
        ex.openWithAuth(p, a);
        vm.stopPrank();
        (, uint256 coll) = _position(m1, user);
        assertApproxEqAbs(coll, 3157.894736842105263157e18 + 4000e18, 1e6);
        _assertClean();
    }

    function test_open_deposit_only() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.debtAmount = 0;
        p.steps = _none();
        p.guard = _guard(0);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        ex.open(p); // supplyCollateral needs no authorization
        vm.stopPrank();
        (, uint256 coll) = _position(m1, user);
        assertEq(coll, 1000e18);
        assertEq(ex.healthFactor(m1, user), type(uint256).max);
    }

    function test_open_above_lltv_reverts() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.debtAmount = 11_000e6; // debt 11000 $ against 11950 $ of collateral x 91.5 % = 10934 $
        p.steps = _one(_step(address(usdc), address(pt1), 11_000e6, 0));
        p.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(bytes("insufficient collateral"));
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function test_open_min_health_factor() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.guard = _guard(1.2e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectPartialRevert(LeverageExecutorMorpho.HealthFactorTooLow.selector);
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function test_open_deadline() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.guard.deadline = block.timestamp - 1;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.Expired.selector, block.timestamp - 1));
        ex.open(p);
    }

    function test_open_slippage() public {
        router.setSlippageBps(100);
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.InsufficientOutput.selector, 3960e18, 3990e18));
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function test_open_same_asset_reverts() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.market.collateralToken = address(usdc);
        vm.prank(user);
        vm.expectRevert(LeverageExecutorMorpho.SameAsset.selector);
        ex.open(p);
    }
}

contract MorphoAuthTest is MorphoBase {
    function test_bad_revoke_signature_reverts_whole_call() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        a.revoke.s = bytes32(uint256(a.revoke.s) ^ 1);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(LeverageExecutorMorpho.AuthorizationNotRevoked.selector);
        ex.openWithAuth(p, a);
        vm.stopPrank();
        assertFalse(morpho.isAuthorized(user, address(ex)));
    }

    function test_frontrun_grant_still_works() public {
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        // someone replays the grant signature first: the authorization is in place, the call still goes through
        morpho.setAuthorizationWithSig(
            Authorization(user, address(ex), true, a.nonce, a.deadline), a.grant
        );
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        ex.openWithAuth(p, a);
        vm.stopPrank();
        assertEq(_debt(m1, user), 3800e6);
        assertFalse(morpho.isAuthorized(user, address(ex)));
    }

    function test_frontrun_grant_and_revoke_only_blocks() public {
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        morpho.setAuthorizationWithSig(Authorization(user, address(ex), true, a.nonce, a.deadline), a.grant);
        morpho.setAuthorizationWithSig(Authorization(user, address(ex), false, a.nonce + 1, a.deadline), a.revoke);
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(bytes("unauthorized"));
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function test_signatures_of_someone_else_are_useless() public {
        (address eve, uint256 eveKey) = makeAddrAndKey("eve");
        // Eve sends the user's signatures: the contract builds the authorization for msg.sender (Eve), so they fail
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        pt1.mint(eve, 1000e18);
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(eve);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(bytes("unauthorized"));
        ex.openWithAuth(p, a);
        vm.stopPrank();
        eveKey;
    }

    function test_persistent_authorization_cannot_be_used_by_others() public {
        _openAsUser();
        vm.prank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex), true);
        address eve = makeAddr("eve");
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.collateralToSell = 4000e18;
        c.steps = _one(_step(address(pt1), address(usdc), 4000e18, 0));
        c.guard = _guard(0);
        // the close acts on Eve's own (empty) position, never on the user's
        vm.prank(eve);
        vm.expectRevert(LeverageExecutorMorpho.ZeroAmount.selector);
        ex.close(c);
        (, uint256 coll) = _position(m1, user);
        assertEq(coll, 5000e18);
    }

    function test_malicious_route_cannot_use_the_authorization() public {
        AttackRouter attack = new AttackRouter(IPriceOracle(address(prices)));
        pt1.mint(address(attack), 1_000_000e18);
        address[] memory routers = new address[](1);
        routers[0] = address(attack);
        LeverageExecutorMorpho ex2 = new LeverageExecutorMorpho(morpho, routers);
        address eve = makeAddr("eve");
        // mid-swap, the route tries to borrow for the user (who authorized the executor for this transaction)
        attack.arm(address(morpho), abi.encodeCall(IMorpho.borrow, (m1, 1000e6, 0, user, eve)));
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.steps[0] = LeverageExecutorMorpho.Step(
            address(attack),
            address(pt1),
            abi.encodeCall(attack.swapAndCall, (address(usdc), address(pt1), 3800e6, address(ex2))),
            0
        );
        vm.startPrank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex2), true);
        pt1.approve(address(ex2), p.capitalAmount);
        vm.expectRevert(bytes("unauthorized"));
        ex2.open(p);
        vm.stopPrank();
    }

    function test_malicious_route_cannot_reenter() public {
        AttackRouter attack = new AttackRouter(IPriceOracle(address(prices)));
        pt1.mint(address(attack), 1_000_000e18);
        address[] memory routers = new address[](1);
        routers[0] = address(attack);
        LeverageExecutorMorpho ex2 = new LeverageExecutorMorpho(morpho, routers);
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = 1;
        c.collateralToWithdraw = 1;
        c.guard = _guard(0);
        c.steps = _none();
        attack.arm(address(ex2), abi.encodeCall(ex2.close, (c)));
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.steps[0] = LeverageExecutorMorpho.Step(
            address(attack),
            address(pt1),
            abi.encodeCall(attack.swapAndCall, (address(usdc), address(pt1), 3800e6, address(ex2))),
            0
        );
        vm.startPrank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex2), true);
        pt1.approve(address(ex2), p.capitalAmount);
        vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        ex2.open(p);
        vm.stopPrank();
    }

    function test_callback_only_from_morpho_and_only_when_expected() public {
        vm.expectRevert(LeverageExecutorMorpho.CallerNotLender.selector);
        ex.onMorphoFlashLoan(1, abi.encode(address(usdc), bytes("")));
        vm.prank(address(morpho));
        vm.expectRevert(LeverageExecutorMorpho.UnexpectedFlashLoan.selector);
        ex.onMorphoFlashLoan(1, abi.encode(address(usdc), bytes("")));
    }

    function test_router_checks() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.steps[0].router = address(0xBEEF);
        vm.startPrank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex), true);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.RouterNotAllowed.selector, address(0xBEEF)));
        ex.open(p);
        p.steps[0].tokenOut = address(usdc);
        p.steps[0].router = address(router);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.WrongFinalToken.selector, address(usdc), address(pt1)));
        ex.open(p);
        vm.stopPrank();
    }

    function test_greedy_router_reverts() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.steps[0].data = abi.encodeCall(router.swapGreedy, (address(usdc), address(pt1), 3800e6, address(ex)));
        vm.startPrank(user);
        IMorphoAdmin(address(morpho)).setAuthorization(address(ex), true);
        pt1.approve(address(ex), p.capitalAmount);
        vm.expectRevert(); // the router's transferFrom of more than approved fails
        ex.open(p);
        vm.stopPrank();
    }

    function test_constructor_refuses_bad_routers() public {
        address[] memory routers = new address[](1);
        routers[0] = address(morpho);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.InvalidRouter.selector, address(morpho)));
        new LeverageExecutorMorpho(morpho, routers);
        routers[0] = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.InvalidRouter.selector, routers[0]));
        new LeverageExecutorMorpho(morpho, routers);
        vm.expectRevert(LeverageExecutorMorpho.ZeroAddress.selector);
        new LeverageExecutorMorpho(IMorpho(address(0)), new address[](0));
    }
}

contract MorphoCloseTest is MorphoBase {
    function _closeAll(uint256 sell) internal returns (LeverageExecutorMorpho.CloseResult memory r) {
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.collateralToSell = sell;
        c.steps = _one(_step(address(pt1), address(usdc), sell, 0));
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        r = ex.closeWithAuth(c, a);
    }

    function test_full_close_after_a_year_of_interest() public {
        _openAsUser();
        vm.warp(block.timestamp + 365 days);
        uint256 debt = 3800e6 * 105127 / 100000; // continuous 5 %, Morpho's 3-term Taylor: ~5.127 %
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 ptBefore = pt1.balanceOf(user);
        LeverageExecutorMorpho.CloseResult memory r = _closeAll(4300e18); // 4085 USDC for ~3994.8 of debt
        (uint256 shares, uint256 coll) = _position(m1, user);
        assertEq(shares, 0, "no debt left");
        assertEq(coll, 0, "no collateral left");
        assertApproxEqRel(r.debtRepaid, debt, 1e15);
        assertEq(r.collateralWithdrawn, 5000e18);
        assertEq(r.collateralReturned, 700e18);
        assertEq(pt1.balanceOf(user) - ptBefore, 700e18);
        assertEq(usdc.balanceOf(user) - usdcBefore, 4085e6 - r.debtRepaid);
        assertEq(r.loanReturned, 4085e6 - r.debtRepaid);
        assertEq(r.healthFactor, type(uint256).max);
        _assertClean();
    }

    function test_close_not_enough_sold_reverts() public {
        _openAsUser();
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.collateralToSell = 3000e18; // 2850 USDC < 3800
        c.steps = _one(_step(address(pt1), address(usdc), 3000e18, 0));
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.InsufficientToRepayFlashLoan.selector, 2850e6, 3800e6));
        ex.closeWithAuth(c, a);
    }

    function test_deleverage() public {
        _openAsUser();
        // repay 1900, withdraw and sell 2000 PT1 (1900 USDC)
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = 1900e6;
        c.collateralToWithdraw = 2000e18;
        c.collateralToSell = 2000e18;
        c.steps = _one(_step(address(pt1), address(usdc), 2000e18, 1900e6));
        c.guard = _guard(1.3e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        LeverageExecutorMorpho.CloseResult memory r = ex.closeWithAuth(c, a);
        (, uint256 coll) = _position(m1, user);
        assertEq(coll, 3000e18);
        assertApproxEqAbs(_debt(m1, user), 1900e6, 1);
        // 2850 $ x 91.5 % / 1900
        assertApproxEqRel(r.healthFactor, 1.3725e18, 1e12);
        _assertClean();
    }

    function test_withdraw_too_much_reverts() public {
        _openAsUser();
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = 100e6;
        c.collateralToWithdraw = 4000e18;
        c.collateralToSell = 0;
        c.steps = _none();
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        vm.expectRevert(); // Morpho: insufficient collateral, or not enough loan token to give back the flash loan
        ex.closeWithAuth(c, a);
    }

    function test_sell_exceeds_withdrawn() public {
        _openAsUser();
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = 100e6;
        c.collateralToWithdraw = 100e18;
        c.collateralToSell = 200e18;
        c.steps = _one(_step(address(pt1), address(usdc), 200e18, 0));
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.SellExceedsWithdrawn.selector, 200e18, 100e18));
        ex.closeWithAuth(c, a);
    }

    function test_close_without_debt_only_withdraws() public {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.debtAmount = 0;
        p.steps = _none();
        p.guard = _guard(0);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        ex.open(p);
        vm.stopPrank();
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.steps = _none();
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        LeverageExecutorMorpho.CloseResult memory r = ex.closeWithAuth(c, a);
        assertEq(r.debtRepaid, 0);
        assertEq(r.collateralReturned, 1000e18);
        assertEq(pt1.balanceOf(user), 10_000e18);
        _assertClean();
    }

    function test_close_after_price_drop_keeps_health_check() public {
        _openAsUser();
        MockMorphoOracle(m1.oracle).set(0.8e24); // 4000 $ x 91.5 % < 3800: liquidatable
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = 100e6;
        c.collateralToWithdraw = 1e18;
        c.steps = _none();
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        vm.expectRevert(bytes("insufficient collateral"));
        ex.closeWithAuth(c, a);
    }
}

contract MorphoRollTest is MorphoBase {
    function _roll(MarketParams memory to, LeverageExecutorMorpho.Step[] memory steps, uint256 minHf)
        internal
        returns (LeverageExecutorMorpho.RollResult memory r)
    {
        LeverageExecutorMorpho.RollParams memory p;
        p.from = m1;
        p.to = to;
        p.repayAmount = type(uint256).max;
        p.collateralToMove = type(uint256).max;
        p.steps = steps;
        p.guard = _guard(minHf);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        r = ex.rollWithAuth(p, a);
    }

    function test_roll_pt_to_pt() public {
        _openAsUser();
        vm.warp(block.timestamp + 30 days);
        uint256 debt = _debtAccrued(m1);
        // 5000 PT1 (4750 $) -> 5107.53 PT2
        LeverageExecutorMorpho.RollResult memory r = _roll(m2, _one(_step(address(pt1), address(pt2), 5000e18, 5100e18)), 1.1e18);
        (uint256 s1, uint256 c1) = _position(m1, user);
        assertEq(s1, 0);
        assertEq(c1, 0);
        (, uint256 c2) = _position(m2, user);
        assertApproxEqAbs(c2, 5107.526881720430107526e18, 1e6);
        assertEq(r.collateralSupplied, c2);
        assertEq(r.debtRepaid, debt);
        assertEq(r.debtBorrowed, debt);
        assertApproxEqAbs(_debt(m2, user), debt, 1);
        _assertClean();
    }

    function test_roll_same_collateral_to_another_market() public {
        _openAsUser();
        LeverageExecutorMorpho.RollResult memory r = _roll(m3, _none(), 1.05e18);
        (, uint256 c3) = _position(m3, user);
        assertEq(c3, 5000e18);
        assertEq(r.collateralSupplied, 5000e18);
        // 4750 x 86 % / 3800
        assertApproxEqRel(r.healthFactor, 1.075e18, 1e12);
        _assertClean();
    }

    function test_roll_checks() public {
        _openAsUser();
        LeverageExecutorMorpho.RollParams memory p;
        p.from = m1;
        p.to = m1;
        p.repayAmount = type(uint256).max;
        p.collateralToMove = type(uint256).max;
        p.steps = _none();
        p.guard = _guard(0);
        vm.startPrank(user);
        vm.expectRevert(LeverageExecutorMorpho.SameMarket.selector);
        ex.roll(p);
        p.to = m2;
        p.to.loanToken = address(weth);
        vm.expectRevert(LeverageExecutorMorpho.LoanTokenMismatch.selector);
        ex.roll(p);
        p.to = m2;
        vm.expectRevert(LeverageExecutorMorpho.InvalidSteps.selector);
        ex.roll(p);
        p.to = m3;
        p.steps = _one(_step(address(pt1), address(pt1), 1, 0));
        vm.expectRevert(LeverageExecutorMorpho.UnexpectedSteps.selector);
        ex.roll(p);
        vm.stopPrank();
    }

    function test_roll_min_health_factor() public {
        _openAsUser();
        LeverageExecutorMorpho.RollParams memory p;
        p.from = m1;
        p.to = m3;
        p.repayAmount = type(uint256).max;
        p.collateralToMove = type(uint256).max;
        p.steps = _none();
        p.guard = _guard(1.1e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.prank(user);
        vm.expectPartialRevert(LeverageExecutorMorpho.HealthFactorTooLow.selector);
        ex.rollWithAuth(p, a);
    }

    function _debtAccrued(MarketParams memory m) internal returns (uint256) {
        morpho.accrueInterest(m);
        return _debt(m, user);
    }
}

contract MorphoFuzzTest is MorphoBase {
    function testFuzz_open_close(uint256 capital, uint256 leverageBps, uint256 days_) public {
        capital = bound(capital, 1e18, 10_000e18);
        leverageBps = bound(leverageBps, 10_100, 90_000); // 1.01x to 9x (max ~11.8x at 91.5 %)
        days_ = bound(days_, 0, 400);
        uint256 collValue = capital * 95 / 100 * leverageBps / 10_000; // in 1e18 $
        uint256 debt = (collValue - capital * 95 / 100) / 1e12; // USDC
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        p.capitalAmount = capital;
        p.debtAmount = debt;
        p.steps = _one(_step(address(usdc), address(pt1), debt, 0));
        p.guard = _guard(1e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), capital);
        ex.openWithAuth(p, a);
        vm.stopPrank();
        _assertClean();

        vm.warp(block.timestamp + days_ * 1 days);
        morpho.accrueInterest(m1);
        uint256 owed = _debt(m1, user);
        (, uint256 coll) = _position(m1, user);
        // sell enough PT1 to cover the debt (+1 % for rounding), never more than the collateral
        uint256 sell = owed * 1e12 * 101 / 95;
        if (sell > coll) sell = coll;
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = m1;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.collateralToSell = sell;
        c.steps = _one(_step(address(pt1), address(usdc), sell, 0));
        c.guard = _guard(0);
        a = _auth(userKey, user);
        bool enough = _quote(sell) >= owed;
        vm.prank(user);
        if (!enough) {
            vm.expectRevert();
            ex.closeWithAuth(c, a);
            return;
        }
        ex.closeWithAuth(c, a);
        (uint256 shares, uint256 left) = _position(m1, user);
        assertEq(shares, 0);
        assertEq(left, 0);
        _assertClean();
    }

    function _quote(uint256 pt) internal view returns (uint256) {
        return router.quote(address(pt1), address(usdc), pt);
    }
}
