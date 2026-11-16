// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {MarketParams} from "../../src/interfaces/IMorpho.sol";
import {MockSpokeV4, MockTaker} from "./V4Mocks.sol";
import {V4Base} from "./V4Base.sol";

/// @notice Collateral swap, debt swap and refinance between two spokes, against the local stand-ins of V4Base: a
/// third reserve DAI (collateral factor 80 %) in the spoke, and a second spoke served by the same position managers
/// that lists USDC as reserve 0 and WETH as reserve 1. Aave v3 and Morpho sides of a refinance: V4Refinance.t.sol.
contract V4ReshapeTest is V4Base {
    uint256 constant X = 2; // DAI reserve of `spoke`
    uint256 constant C2 = 1; // WETH reserve of `spoke2`
    uint256 constant D2 = 0; // USDC reserve of `spoke2`

    MockSpokeV4 spoke2;
    address stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        spoke.addReserve(address(dai), 8000);
        dai.mint(address(spoke), 10_000_000e18);
        dai.mint(address(morpho), 10_000_000e18);
        weth.mint(address(morpho), 10_000e18);

        spoke2 = new MockSpokeV4(prices);
        spoke2.addReserve(address(usdc), 0);
        spoke2.addReserve(address(weth), 8000);
        giver.registerSpoke(address(spoke2), true);
        taker.registerSpoke(address(spoke2), true);
        usdc.mint(address(spoke2), 10_000_000e6);
        vm.startPrank(user);
        spoke2.setUserPositionManager(address(giver), true);
        spoke2.setUserPositionManager(address(taker), true);
        spoke2.setUsingAsCollateral(C2, true, user);
        vm.stopPrank();

        _open3x(); // 30 WETH, 60 000 USDC on `spoke`
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _permitOn(address s, bytes32 typehash, uint256 id, uint256 amount, uint256 nonceOffset)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        p.amount = amount;
        p.nonce = taker.nonces(user, 0) + nonceOffset;
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                taker.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(typehash, s, id, user, address(ex), amount, p.nonce, p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(userKey, digest);
        p.signature = abi.encodePacked(r, sig, v);
    }

    function _collParams(uint256 fromAmount, uint256 sold)
        internal
        view
        returns (LeverageExecutorV4.SwapCollateralParams memory p)
    {
        p.spoke = address(spoke);
        p.fromId = C;
        p.toId = X;
        p.fromAmount = fromAmount;
        p.steps = _step(router, address(weth), address(dai), sold);
        p.toAmount = p.steps[0].minOut;
        p.guard = _guard(1.05e18);
    }

    function _debtParams(uint256 newDebt, uint256 minRepaid)
        internal
        view
        returns (LeverageExecutorV4.SwapDebtParams memory p)
    {
        p.spoke = address(spoke);
        p.fromId = D;
        p.toId = X;
        p.newDebtAmount = newDebt;
        p.minRepaid = minRepaid;
        p.steps = _step(router, address(dai), address(usdc), newDebt);
        p.guard = _guard(1.05e18);
    }

    function _v4(address s, uint256 c, uint256 d) internal pure returns (LeverageExecutorV4.Place memory pl) {
        pl.venue = LeverageExecutorV4.Venue.AaveV4;
        pl.target = s;
        pl.collateralId = c;
        pl.debtId = d;
    }

    function _refi(uint256 debtAmount, uint256 collateralAmount)
        internal
        view
        returns (LeverageExecutorV4.RefinanceParams memory p)
    {
        p.from = _v4(address(spoke), C, D);
        p.to = _v4(address(spoke2), C2, D2);
        p.debtAmount = debtAmount;
        p.collateralAmount = collateralAmount;
        p.guard = _guard(1.05e18);
    }

    function _noAuth() internal pure returns (LeverageExecutorV4.RefinanceAuth memory a) {}

    function _allowancesGone(address s, uint256 c, uint256 d) internal view {
        assertEq(taker.withdrawAllowance(s, c, user, address(ex)), 0, "withdraw allowance left");
        assertEq(taker.borrowAllowance(s, d, user, address(ex)), 0, "borrow allowance left");
    }

    // ---------------------------------------------------------------------------------------------
    // Swap collateral
    // ---------------------------------------------------------------------------------------------

    function test_swapCollateral_everything_withPermit() public {
        vm.prank(user);
        spoke.setUsingAsCollateral(X, true, user);
        LeverageExecutorV4.SwapCollateralParams memory p = _collParams(type(uint256).max, 30e18);
        LeverageExecutorV4.Permit memory permit = _permit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, 30e18);
        vm.prank(user);
        LeverageExecutorV4.SwapCollateralResult memory r = ex.swapCollateral(p, permit);

        assertEq(r.withdrawn, 30e18);
        assertEq(r.supplied, 90_000e18);
        assertEq(spoke.supplied(user, C), 0, "old collateral left");
        assertEq(spoke.supplied(user, X), 90_000e18);
        assertEq(spoke.debt(user, D), 60_000e6, "debt unchanged");
        assertEq(r.healthFactor, 1.2e18); // 90 000 x 0.80 / 60 000
        _allowancesGone(address(spoke), C, D);
        _assertClean();
    }

    function test_swapCollateral_part_plainAllowance_surplusSupplied() public {
        vm.startPrank(user);
        spoke.setUsingAsCollateral(X, true, user);
        taker.approveWithdraw(address(spoke), C, address(ex), 10e18);
        LeverageExecutorV4.SwapCollateralParams memory p = _collParams(10e18, 10e18);
        // a smaller flash loan: what the swap gives above it is supplied too
        p.toAmount = 20_000e18;
        LeverageExecutorV4.SwapCollateralResult memory r = ex.swapCollateral(p, _noPermit());
        vm.stopPrank();
        assertEq(r.supplied, 30_000e18);
        assertEq(spoke.supplied(user, C), 20e18);
        assertEq(spoke.supplied(user, X), 30_000e18);
        _assertClean();
    }

    function test_swapCollateral_reverts() public {
        LeverageExecutorV4.SwapCollateralParams memory p = _collParams(type(uint256).max, 30e18);
        vm.startPrank(user);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);
        // the new reserve must be a collateral of the account
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, X));
        ex.swapCollateral(p, _noPermit());
        spoke.setUsingAsCollateral(X, true, user);

        // the swap must repay the flash loan
        p.toAmount = 90_001e18;
        vm.expectRevert(
            abi.encodeWithSelector(LeverageExecutorV4.InsufficientToRepayFlashLoan.selector, 90_000e18, 90_001e18)
        );
        ex.swapCollateral(p, _noPermit());

        p = _collParams(type(uint256).max, 30e18);
        p.guard.minHealthFactor = 1.3e18;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.HealthFactorTooLow.selector, 1.2e18, 1.3e18));
        ex.swapCollateral(p, _noPermit());

        p = _collParams(type(uint256).max, 30e18);
        p.toId = C;
        vm.expectRevert(SwapExecutorBase.SameAsset.selector);
        ex.swapCollateral(p, _noPermit());

        p = _collParams(0, 30e18);
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.swapCollateral(p, _noPermit());

        // selling more than what was withdrawn is impossible: the step spends at most the withdrawal
        p = _collParams(10e18, 30e18);
        vm.expectRevert();
        ex.swapCollateral(p, _noPermit());

        // without the withdraw allowance
        taker.approveWithdraw(address(spoke), C, address(ex), 0);
        p = _collParams(type(uint256).max, 30e18);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientWithdrawAllowance.selector, 0, 30e18));
        ex.swapCollateral(p, _noPermit());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Swap debt
    // ---------------------------------------------------------------------------------------------

    function test_swapDebt_everything_withPermit() public {
        // 60 300 DAI sold for 60 300 USDC: the whole 60 000 USDC debt is repaid, 300 USDC go back to the user
        LeverageExecutorV4.SwapDebtParams memory p = _debtParams(60_300e18, type(uint256).max);
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), X, 60_300e18);
        vm.prank(user);
        LeverageExecutorV4.SwapDebtResult memory r = ex.swapDebt(p, permit);

        assertEq(r.repaid, 60_000e6);
        assertEq(r.borrowed, 60_300e18);
        assertEq(r.returned, 300e6);
        assertEq(usdc.balanceOf(user), 300e6);
        assertEq(spoke.debt(user, D), 0, "old debt left");
        assertEq(spoke.debt(user, X), 60_300e18);
        assertEq(spoke.supplied(user, C), 30e18, "collateral unchanged");
        _allowancesGone(address(spoke), C, X);
        _assertClean();
    }

    function test_swapDebt_part_plainAllowance() public {
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), X, address(ex), 20_000e18);
        LeverageExecutorV4.SwapDebtResult memory r = ex.swapDebt(_debtParams(20_000e18, 20_000e6), _noPermit());
        vm.stopPrank();
        assertEq(r.repaid, 20_000e6);
        assertEq(spoke.debt(user, D), 40_000e6);
        assertEq(spoke.debt(user, X), 20_000e18);
        _assertClean();
    }

    function test_swapDebt_reverts() public {
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), X, address(ex), type(uint256).max);
        // a whole switch that does not repay the whole debt
        LeverageExecutorV4.SwapDebtParams memory p = _debtParams(59_000e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.RepaidTooLittle.selector, 59_000e6, 60_000e6));
        ex.swapDebt(p, _noPermit());

        p = _debtParams(20_000e18, 20_000e6);
        p.steps = _none();
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.swapDebt(p, _noPermit());

        p = _debtParams(20_000e18, 20_000e6);
        p.steps[0].minOut = 20_001e6;
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InsufficientOutput.selector, 20_000e6, 20_001e6));
        ex.swapDebt(p, _noPermit());

        p = _debtParams(20_000e18, 20_000e6);
        p.guard.minHealthFactor = 2e18;
        vm.expectRevert();
        ex.swapDebt(p, _noPermit());

        // without the borrow allowance
        taker.approveBorrow(address(spoke), X, address(ex), 0);
        p = _debtParams(20_000e18, 20_000e6);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientBorrowAllowance.selector, 0, 20_000e18));
        ex.swapDebt(p, _noPermit());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Refinance between two spokes
    // ---------------------------------------------------------------------------------------------

    function test_refinance_spokeToSpoke_everything_withPermits() public {
        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _permitOn(address(spoke), taker.WITHDRAW_PERMIT_TYPEHASH(), C, 30e18, 0);
        a.enter = _permitOn(address(spoke2), taker.BORROW_PERMIT_TYPEHASH(), D2, 60_000e6, 1);
        vm.prank(user);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_refi(type(uint256).max, type(uint256).max), a);

        assertEq(r.debtMoved, 60_000e6);
        assertEq(r.collateralMoved, 30e18);
        assertEq(r.healthFactor, 1.2e18); // 90 000 x 0.80 / 60 000 on the second spoke
        assertEq(spoke.supplied(user, C), 0);
        assertEq(spoke.debt(user, D), 0);
        assertEq(spoke2.supplied(user, C2), 30e18);
        assertEq(spoke2.debt(user, D2), 60_000e6);
        _allowancesGone(address(spoke), C, D);
        _allowancesGone(address(spoke2), C2, D2);
        _assertClean();
    }

    function test_refinance_spokeToSpoke_part_plainAllowances() public {
        vm.startPrank(user);
        taker.approveWithdraw(address(spoke), C, address(ex), 10e18);
        taker.approveBorrow(address(spoke2), D2, address(ex), 20_000e6);
        ex.refinance(_refi(20_000e6, 10e18), _noAuth());
        vm.stopPrank();
        assertEq(spoke.supplied(user, C), 20e18);
        assertEq(spoke.debt(user, D), 40_000e6);
        assertEq(spoke2.supplied(user, C2), 10e18);
        assertEq(spoke2.debt(user, D2), 20_000e6);
        _assertClean();
    }

    function test_refinance_reverts() public {
        vm.startPrank(user);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);
        taker.approveBorrow(address(spoke2), D2, address(ex), type(uint256).max);
        LeverageExecutorV4.RefinanceParams memory p = _refi(type(uint256).max, type(uint256).max);

        p.to = p.from;
        vm.expectRevert(LeverageExecutorV4.SamePlace.selector);
        ex.refinance(p, _noAuth());

        // reserves that do not hold the same tokens
        p = _refi(type(uint256).max, type(uint256).max);
        p.to = _v4(address(spoke2), D2, C2);
        vm.expectRevert(LeverageExecutorV4.TokenMismatch.selector);
        ex.refinance(p, _noAuth());

        // Morpho market of another pair
        p = _refi(type(uint256).max, type(uint256).max);
        p.to.venue = LeverageExecutorV4.Venue.Morpho;
        p.to.market = MarketParams(address(dai), address(weth), address(0), address(0), 0.86e18);
        vm.expectRevert(LeverageExecutorV4.TokenMismatch.selector);
        ex.refinance(p, _noAuth());

        // an Aave v3 pool not fixed at deployment
        p = _refi(type(uint256).max, type(uint256).max);
        p.to.venue = LeverageExecutorV4.Venue.AaveV3;
        p.to.target = address(spoke2);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.PoolNotAllowed.selector, address(spoke2)));
        ex.refinance(p, _noAuth());

        // neither side on Aave v4
        p.from = p.to;
        vm.expectRevert(LeverageExecutorV4.NoAaveV4Side.selector);
        ex.refinance(p, _noAuth());

        // a spoke the position managers do not serve
        MockSpokeV4 other = new MockSpokeV4(prices);
        other.addReserve(address(usdc), 0);
        other.addReserve(address(weth), 8000);
        p = _refi(type(uint256).max, type(uint256).max);
        p.to.target = address(other);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, address(other)));
        ex.refinance(p, _noAuth());

        // the collateral flag at the target
        spoke2.setUsingAsCollateral(C2, false, user);
        p = _refi(type(uint256).max, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, C2));
        ex.refinance(p, _noAuth());
        spoke2.setUsingAsCollateral(C2, true, user);

        p.guard.minHealthFactor = 1.3e18;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.HealthFactorTooLow.selector, 1.2e18, 1.3e18));
        ex.refinance(p, _noAuth());

        // moving the debt without enough collateral: the target refuses the borrow
        p = _refi(type(uint256).max, 10e18);
        vm.expectRevert(MockSpokeV4.HealthFactorBelowThreshold.selector);
        ex.refinance(p, _noAuth());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Security
    // ---------------------------------------------------------------------------------------------

    /// @dev the user's allowances only ever serve the user: a stranger's calls act on the stranger's empty account
    function test_security_strangerCannotUseAllowances() public {
        vm.startPrank(user);
        spoke.setUsingAsCollateral(X, true, user);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);
        taker.approveBorrow(address(spoke), X, address(ex), type(uint256).max);
        taker.approveBorrow(address(spoke2), D2, address(ex), type(uint256).max);
        vm.stopPrank();

        LeverageExecutorV4.SwapCollateralParams memory c = _collParams(type(uint256).max, 30e18);
        LeverageExecutorV4.SwapDebtParams memory d = _debtParams(20_000e18, type(uint256).max);
        vm.startPrank(stranger);
        spoke.setUsingAsCollateral(X, true, stranger);
        vm.expectRevert(MockSpokeV4.Unauthorized.selector);
        ex.swapCollateral(c, _noPermit());
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.swapDebt(d, _noPermit());
        spoke2.setUsingAsCollateral(C2, true, stranger);
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.refinance(_refi(type(uint256).max, type(uint256).max), _noAuth());
        vm.stopPrank();

        assertEq(spoke.supplied(user, C), 30e18);
        assertEq(spoke.debt(user, D), 60_000e6);
    }

    /// @dev a signature for one spoke cannot be replayed for another, nor by somebody else
    function test_security_permitsAreBound() public {
        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _permitOn(address(spoke), taker.WITHDRAW_PERMIT_TYPEHASH(), C, 30e18, 0);
        a.enter = _permitOn(address(spoke), taker.BORROW_PERMIT_TYPEHASH(), D2, 60_000e6, 1); // wrong spoke
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientBorrowAllowance.selector, 0, 60_000e6));
        ex.refinance(_refi(type(uint256).max, type(uint256).max), a);

        a.enter = _permitOn(address(spoke2), taker.BORROW_PERMIT_TYPEHASH(), D2, 60_000e6, 1);
        vm.startPrank(stranger);
        spoke2.setUsingAsCollateral(C2, true, stranger);
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.refinance(_refi(type(uint256).max, type(uint256).max), a);
        vm.stopPrank();
        assertEq(taker.borrowAllowance(address(spoke2), D2, user, address(ex)), 0);
    }
}
