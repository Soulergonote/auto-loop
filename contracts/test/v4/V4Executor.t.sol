// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorphoFlashLender} from "../../src/interfaces/IFlashLenders.sol";
import {IAaveV4Giver, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {AttackRouter} from "../mocks/AttackRouter.sol";
import {MockMorpho, LazyLender} from "../mocks/MockFlashLenders.sol";
import {TestToken, UsdPrices} from "../morpho/MorphoMocks.sol";
import {MockSpokeV4, MockGiver, MockTaker} from "./V4Mocks.sol";

/// @notice LeverageExecutorV4 against local stand-ins of an Aave v4 spoke and its position managers (V4Mocks.sol):
/// WETH (collateral factor 84 %, 3 000 $) against USDC, a router trading at those prices, Morpho-like flash loans.
/// The same flows run against the real protocol in test/fork/EthereumForkV4.t.sol.
contract V4ExecutorTest is Test {
    uint256 constant C = 0; // WETH reserve
    uint256 constant D = 1; // USDC reserve

    LeverageExecutorV4 ex;
    MockSpokeV4 spoke;
    MockGiver giver;
    MockTaker taker;
    MockMorpho morpho;
    MockAggregatorRouter router;
    AttackRouter attackRouter;
    UsdPrices prices;
    TestToken weth;
    TestToken usdc;
    TestToken dai;
    address user;
    uint256 userKey;

    function setUp() public {
        (user, userKey) = makeAddrAndKey("user");
        weth = new TestToken("WETH", 18);
        usdc = new TestToken("USDC", 6);
        dai = new TestToken("DAI", 18);
        prices = new UsdPrices();
        prices.set(address(weth), 3000e8);
        prices.set(address(usdc), 1e8);
        prices.set(address(dai), 1e8);

        spoke = new MockSpokeV4(prices);
        spoke.addReserve(address(weth), 8400);
        spoke.addReserve(address(usdc), 0);
        giver = new MockGiver();
        taker = new MockTaker();
        giver.registerSpoke(address(spoke), true);
        taker.registerSpoke(address(spoke), true);
        morpho = new MockMorpho();
        router = new MockAggregatorRouter(IPriceOracle(address(prices)));
        attackRouter = new AttackRouter(IPriceOracle(address(prices)));

        address[] memory routers = new address[](2);
        routers[0] = address(router);
        routers[1] = address(attackRouter);
        ex = new LeverageExecutorV4(
            IMorphoFlashLender(address(morpho)), IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers
        );

        usdc.mint(address(spoke), 10_000_000e6);
        usdc.mint(address(morpho), 10_000_000e6);
        address[2] memory rs = [address(router), address(attackRouter)];
        for (uint256 i; i < 2; ++i) {
            weth.mint(rs[i], 10_000e18);
            usdc.mint(rs[i], 10_000_000e6);
            dai.mint(rs[i], 10_000_000e18);
        }

        // the once-per-spoke setup, and the capital approval
        weth.mint(user, 10e18);
        vm.startPrank(user);
        spoke.setUserPositionManager(address(giver), true);
        spoke.setUserPositionManager(address(taker), true);
        spoke.setUsingAsCollateral(C, true, user);
        weth.approve(address(ex), type(uint256).max);
        usdc.approve(address(ex), type(uint256).max);
        dai.approve(address(ex), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _step(MockAggregatorRouter r, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (SwapExecutorBase.Step[] memory s)
    {
        s = new SwapExecutorBase.Step[](1);
        s[0] = SwapExecutorBase.Step(
            address(r),
            tokenOut,
            abi.encodeCall(r.swap, (tokenIn, tokenOut, amountIn, address(ex))),
            r.quote(tokenIn, tokenOut, amountIn)
        );
    }

    function _none() internal pure returns (SwapExecutorBase.Step[] memory) {
        return new SwapExecutorBase.Step[](0);
    }

    function _guard(uint256 minHf) internal view returns (LeverageExecutorV4.Guard memory) {
        return LeverageExecutorV4.Guard(minHf, block.timestamp + 20 minutes);
    }

    /// @dev 10 WETH of capital and `debtAmount` USDC borrowed and sold for WETH
    function _openParams(uint256 debtAmount) internal view returns (LeverageExecutorV4.OpenParams memory p) {
        p.spoke = address(spoke);
        p.collateralId = C;
        p.debtId = D;
        p.capitalToken = address(weth);
        p.capitalAmount = 10e18;
        p.capitalSteps = _none();
        p.debtAmount = debtAmount;
        p.steps = debtAmount == 0 ? _none() : _step(router, address(usdc), address(weth), debtAmount);
        p.guard = _guard(1.05e18);
    }

    function _permit(bytes32 typehash, uint256 id, uint256 amount)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        p.amount = amount;
        p.nonce = taker.nonces(user, 0);
        p.deadline = block.timestamp + 20 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                taker.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(typehash, address(spoke), id, user, address(ex), amount, p.nonce, p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    /// @dev 10 WETH at 3x: 60 000 USDC borrowed
    function _open3x() internal {
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), D, 60_000e6);
        vm.prank(user);
        ex.openWithPermit(p, permit);
    }

    function _closeParams(uint256 repay, uint256 withdraw, uint256 sell)
        internal
        view
        returns (LeverageExecutorV4.CloseParams memory p)
    {
        p.spoke = address(spoke);
        p.collateralId = C;
        p.debtId = D;
        p.repayAmount = repay;
        p.collateralToWithdraw = withdraw;
        p.collateralToSell = sell;
        p.steps = sell == 0 ? _none() : _step(router, address(weth), address(usdc), sell);
        p.guard = _guard(0);
    }

    function _assertClean() internal view {
        assertEq(weth.balanceOf(address(ex)), 0, "WETH left");
        assertEq(usdc.balanceOf(address(ex)), 0, "USDC left");
        assertEq(dai.balanceOf(address(ex)), 0, "DAI left");
        assertEq(weth.allowance(address(ex), address(giver)), 0);
        assertEq(usdc.allowance(address(ex), address(giver)), 0);
        assertEq(usdc.allowance(address(ex), address(morpho)), 0);
        assertEq(weth.allowance(address(ex), address(router)), 0);
        assertEq(usdc.allowance(address(ex), address(router)), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_constructor_rejectsBadAddresses() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        vm.expectRevert(SwapExecutorBase.ZeroAddress.selector);
        new LeverageExecutorV4(
            IMorphoFlashLender(makeAddr("eoa")), IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers
        );
        vm.expectRevert(SwapExecutorBase.ZeroAddress.selector);
        new LeverageExecutorV4(
            IMorphoFlashLender(address(morpho)), IAaveV4Giver(address(0)), IAaveV4Taker(address(taker)), routers
        );
        vm.expectRevert(SwapExecutorBase.ZeroAddress.selector);
        new LeverageExecutorV4(
            IMorphoFlashLender(address(morpho)), IAaveV4Giver(address(giver)), IAaveV4Taker(address(0)), routers
        );

        address[4] memory bad = [address(morpho), address(giver), address(taker), makeAddr("eoa router")];
        for (uint256 i; i < bad.length; ++i) {
            routers[0] = bad[i];
            vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, bad[i]));
            new LeverageExecutorV4(
                IMorphoFlashLender(address(morpho)), IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers
            );
        }
    }

    function test_immutablesAndRouters() public view {
        assertEq(address(ex.MORPHO()), address(morpho));
        assertEq(address(ex.GIVER()), address(giver));
        assertEq(address(ex.TAKER()), address(taker));
        assertTrue(ex.isRouterAllowed(address(router)));
        assertFalse(ex.isRouterAllowed(address(this)));
    }

    // ---------------------------------------------------------------------------------------------
    // Open
    // ---------------------------------------------------------------------------------------------

    function test_open_withPermit_3x() public {
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), D, 60_000e6);
        vm.expectEmit(true, true, false, true, address(ex));
        emit LeverageExecutorV4.PositionOpened(
            user, address(spoke), C, D, address(weth), 10e18, 30e18, 60_000e6, 1.26e18
        );
        vm.prank(user);
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.openWithPermit(p, permit);

        assertEq(supplied, 30e18);
        assertEq(borrowed, 60_000e6);
        assertEq(hf, 1.26e18); // 90 000 x 0.84 / 60 000
        assertEq(spoke.supplied(user, C), 30e18);
        assertEq(spoke.debt(user, D), 60_000e6);
        assertEq(weth.balanceOf(user), 0);
        assertEq(taker.borrowAllowance(address(spoke), D, user, address(ex)), 0, "nothing left to borrow with");
        _assertClean();
    }

    function test_open_plainAllowance_keepsTheRest() public {
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), 100_000e6);
        ex.open(p);
        vm.stopPrank();
        assertEq(spoke.debt(user, D), 60_000e6);
        assertEq(
            taker.borrowAllowance(address(spoke), D, user, address(ex)),
            40_000e6,
            "a transaction's allowance is the user's to manage"
        );
        _assertClean();
    }

    function test_open_permitFrontRun_stillOpens() public {
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), D, 60_000e6);
        // someone relays the signature first: the allowance is in place, the executor's own relay fails silently
        taker.approveBorrowWithSig(
            IAaveV4Taker.BorrowPermit(
                address(spoke), D, user, address(ex), permit.amount, permit.nonce, permit.deadline
            ),
            permit.signature
        );
        vm.prank(user);
        ex.openWithPermit(p, permit);
        assertEq(spoke.debt(user, D), 60_000e6);
    }

    function test_open_capitalInDebtAsset() public {
        usdc.mint(user, 30_000e6);
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.capitalToken = address(usdc);
        p.capitalAmount = 30_000e6;
        p.steps = _step(router, address(usdc), address(weth), 90_000e6);
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), 60_000e6);
        (uint256 supplied,,) = ex.open(p);
        vm.stopPrank();
        assertEq(supplied, 30e18);
        assertEq(usdc.balanceOf(user), 0);
        _assertClean();
    }

    function test_open_capitalInThirdToken() public {
        dai.mint(user, 30_000e18);
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.capitalToken = address(dai);
        p.capitalAmount = 30_000e18;
        p.capitalSteps = _step(router, address(dai), address(weth), 30_000e18);
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), 60_000e6);
        (uint256 supplied,,) = ex.open(p);
        vm.stopPrank();
        assertEq(supplied, 30e18);
        assertEq(dai.balanceOf(user), 0);
        _assertClean();
    }

    function test_open_increaseWithoutCapital() public {
        _open3x();
        LeverageExecutorV4.OpenParams memory p = _openParams(30_000e6);
        p.capitalAmount = 0;
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), D, 30_000e6);
        vm.prank(user);
        (uint256 supplied,, uint256 hf) = ex.openWithPermit(p, permit);
        assertEq(supplied, 10e18);
        assertEq(spoke.supplied(user, C), 40e18);
        assertEq(hf, 1.12e18); // 120 000 x 0.84 / 90 000
        _assertClean();
    }

    function test_open_plainDeposit() public {
        LeverageExecutorV4.OpenParams memory p = _openParams(0);
        vm.prank(user);
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.open(p);
        assertEq(supplied, 10e18);
        assertEq(borrowed, 0);
        assertEq(hf, type(uint256).max);
        _assertClean();
    }

    function test_open_leftoverDebtAssetGoesBack() public {
        // the router uses only 99 % of what it was approved for: the rest returns to the user
        router.setUseInputBps(9900);
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.steps[0].minOut = 19.8e18;
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), 60_000e6);
        ex.open(p);
        vm.stopPrank();
        assertEq(usdc.balanceOf(user), 600e6);
        _assertClean();
    }

    function test_open_reverts() public {
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);

        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.guard.deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.Expired.selector, p.guard.deadline));
        ex.open(p);

        p = _openParams(60_000e6);
        p.guard.minHealthFactor = 1.3e18;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.HealthFactorTooLow.selector, 1.26e18, 1.3e18));
        ex.open(p);

        p = _openParams(0);
        p.capitalAmount = 0;
        vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
        ex.open(p);

        p = _openParams(60_000e6);
        p.capitalSteps = _step(router, address(dai), address(weth), 1e18);
        vm.expectRevert(LeverageExecutorV4.UnexpectedSteps.selector);
        ex.open(p);

        p = _openParams(0);
        p.steps = _step(router, address(usdc), address(weth), 1e6);
        vm.expectRevert(LeverageExecutorV4.UnexpectedSteps.selector);
        ex.open(p);

        p = _openParams(60_000e6);
        p.debtId = C;
        vm.expectRevert(SwapExecutorBase.SameAsset.selector);
        ex.open(p);

        p = _openParams(60_000e6);
        p.steps[0].minOut += 1;
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InsufficientOutput.selector, 20e18, 20e18 + 1));
        ex.open(p);

        // beyond what the collateral backs: the spoke refuses the borrow (10 WETH at 7x: 0.84 x 7 / 6 = 0.98)
        p = _openParams(180_000e6);
        p.guard.minHealthFactor = 0;
        vm.expectRevert(MockSpokeV4.HealthFactorBelowThreshold.selector);
        ex.open(p);
        vm.stopPrank();
    }

    function test_open_needsSetupAndAllowance() public {
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientBorrowAllowance.selector, 0, 60_000e6));
        ex.open(p);

        taker.approveBorrow(address(spoke), D, address(ex), 60_000e6);
        spoke.setUsingAsCollateral(C, false, user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, C));
        ex.open(p);

        spoke.setUsingAsCollateral(C, true, user);
        spoke.setUserPositionManager(address(giver), false);
        vm.expectRevert(MockSpokeV4.Unauthorized.selector);
        ex.open(p);
        vm.stopPrank();
    }

    function test_unregisteredSpoke_refused() public {
        MockSpokeV4 other = new MockSpokeV4(prices);
        other.addReserve(address(weth), 8400);
        other.addReserve(address(usdc), 0);
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.spoke = address(other);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, address(other)));
        ex.open(p);

        // registered on one manager only is not enough
        giver.registerSpoke(address(other), true);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, address(other)));
        ex.open(p);

        LeverageExecutorV4.CloseParams memory c = _closeParams(1, 0, 0);
        c.spoke = makeAddr("not a contract");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, c.spoke));
        ex.close(c);
    }

    // ---------------------------------------------------------------------------------------------
    // Close
    // ---------------------------------------------------------------------------------------------

    function test_close_everything_withPermit() public {
        _open3x();
        spoke.accrue(user, D, 300e6); // interest
        // sell 20.2 WETH for 60 600 USDC: 300 USDC more than the debt
        LeverageExecutorV4.CloseParams memory p = _closeParams(type(uint256).max, type(uint256).max, 20.2e18);
        LeverageExecutorV4.Permit memory permit = _permit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, type(uint256).max);
        vm.prank(user);
        LeverageExecutorV4.CloseResult memory r = ex.closeWithPermit(p, permit);

        assertEq(r.debtRepaid, 60_300e6);
        assertEq(r.collateralWithdrawn, 30e18);
        assertEq(r.collateralReturned, 9.8e18);
        assertEq(r.debtAssetReturned, 300e6);
        assertEq(r.healthFactor, type(uint256).max);
        assertEq(spoke.debt(user, D), 0);
        assertEq(spoke.supplied(user, C), 0);
        assertEq(weth.balanceOf(user), 9.8e18);
        assertEq(usdc.balanceOf(user), 300e6);
        assertEq(taker.withdrawAllowance(address(spoke), C, user, address(ex)), 0, "renounced");
        _assertClean();
    }

    function test_close_partial_exactPermit() public {
        _open3x();
        // repay 30 000 USDC by selling 10 WETH: back to 2x
        LeverageExecutorV4.CloseParams memory p = _closeParams(30_000e6, 10e18, 10e18);
        p.guard.minHealthFactor = 1.6e18;
        LeverageExecutorV4.Permit memory permit = _permit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, 10e18);
        vm.prank(user);
        LeverageExecutorV4.CloseResult memory r = ex.closeWithPermit(p, permit);
        assertEq(r.debtRepaid, 30_000e6);
        assertEq(r.healthFactor, 1.68e18); // 60 000 x 0.84 / 30 000
        assertEq(spoke.supplied(user, C), 20e18);
        assertEq(r.collateralReturned, 0);
        assertEq(r.debtAssetReturned, 0);
        _assertClean();
    }

    function test_close_withoutDebt_onlyWithdraws() public {
        vm.startPrank(user);
        ex.open(_openParams(0));
        taker.approveWithdraw(address(spoke), C, address(ex), 4e18);
        LeverageExecutorV4.CloseResult memory r = ex.close(_closeParams(type(uint256).max, 4e18, 0));
        vm.stopPrank();
        assertEq(r.debtRepaid, 0);
        assertEq(r.collateralReturned, 4e18);
        assertEq(weth.balanceOf(user), 4e18);
        _assertClean();
    }

    function test_close_reverts() public {
        _open3x();
        vm.startPrank(user);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);

        LeverageExecutorV4.CloseParams memory p = _closeParams(type(uint256).max, 30e18, 20.2e18);
        p.guard.deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.Expired.selector, p.guard.deadline));
        ex.close(p);

        p = _closeParams(type(uint256).max, 10e18, 10e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SellExceedsWithdrawn.selector, 10e18 + 1, 10e18));
        ex.close(p);

        // sells too little to give the loan back
        p = _closeParams(type(uint256).max, 30e18, 19e18);
        vm.expectRevert(
            abi.encodeWithSelector(LeverageExecutorV4.InsufficientToRepayFlashLoan.selector, 57_000e6, 60_000e6)
        );
        ex.close(p);

        p = _closeParams(type(uint256).max, 30e18, 0);
        p.steps = _step(router, address(weth), address(usdc), 1e18);
        vm.expectRevert(LeverageExecutorV4.UnexpectedSteps.selector);
        ex.close(p);

        // withdrawing too much for the debt that stays: the spoke refuses
        p = _closeParams(10_000e6, 20e18, 4e18);
        vm.expectRevert(MockSpokeV4.HealthFactorBelowThreshold.selector);
        ex.close(p);

        p = _closeParams(30_000e6, 10e18, 10e18);
        p.guard.minHealthFactor = 2e18;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.HealthFactorTooLow.selector, 1.68e18, 2e18));
        ex.close(p);
        vm.stopPrank();
    }

    function test_close_needsWithdrawAllowance() public {
        _open3x();
        LeverageExecutorV4.CloseParams memory p = _closeParams(type(uint256).max, type(uint256).max, 20.2e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientWithdrawAllowance.selector, 0, 30e18));
        ex.close(p);
    }

    // ---------------------------------------------------------------------------------------------
    // Security
    // ---------------------------------------------------------------------------------------------

    /// The contract only acts for its caller: a stranger gets nothing out of a user's standing allowances.
    function test_security_strangerCannotUseAllowances() public {
        _open3x();
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);
        vm.stopPrank();

        address thief = makeAddr("thief");
        vm.startPrank(thief);
        vm.expectRevert(abi.encodeWithSelector(MockTaker.InsufficientWithdrawAllowance.selector, 0, 1e18));
        ex.close(_closeParams(0, 1e18, 0));

        LeverageExecutorV4.OpenParams memory p = _openParams(1000e6);
        p.capitalAmount = 0;
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, C));
        ex.open(p);
        vm.stopPrank();
        assertEq(spoke.supplied(user, C), 30e18);
        assertEq(spoke.debt(user, D), 60_000e6);
    }

    function test_security_flashCallback() public {
        vm.expectRevert(LeverageExecutorV4.CallerNotLender.selector);
        ex.onMorphoFlashLoan(1, "");

        // Morpho itself calling without a loan this contract asked for
        bytes memory data = abi.encode(address(usdc), abi.encode(LeverageExecutorV4.Action.Close, user, bytes("")));
        vm.prank(address(morpho));
        vm.expectRevert(LeverageExecutorV4.UnexpectedFlashLoan.selector);
        ex.onMorphoFlashLoan(1, data);
    }

    function test_security_lenderThatNeverCallsBack() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        LeverageExecutorV4 lazy = new LeverageExecutorV4(
            IMorphoFlashLender(address(new LazyLender())),
            IAaveV4Giver(address(giver)),
            IAaveV4Taker(address(taker)),
            routers
        );
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        vm.startPrank(user);
        weth.approve(address(lazy), 10e18);
        vm.expectRevert(LeverageExecutorV4.FlashLoanNotExecuted.selector);
        lazy.open(p);
        vm.stopPrank();
    }

    function test_security_routers() public {
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);

        // not whitelisted
        MockAggregatorRouter rogue = new MockAggregatorRouter(IPriceOracle(address(prices)));
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.steps[0].router = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.RouterNotAllowed.selector, address(rogue)));
        ex.open(p);

        // pulls more than approved
        p = _openParams(60_000e6);
        p.steps[0].data = abi.encodeCall(router.swapGreedy, (address(usdc), address(weth), 60_000e6, address(ex)));
        vm.expectRevert();
        ex.open(p);

        // too many steps
        p = _openParams(60_000e6);
        SwapExecutorBase.Step memory one = p.steps[0];
        p.steps = new SwapExecutorBase.Step[](5);
        for (uint256 i; i < 5; ++i) {
            p.steps[i] = one;
        }
        vm.expectRevert(SwapExecutorBase.InvalidSteps.selector);
        ex.open(p);

        // the chain must end on the collateral
        p = _openParams(60_000e6);
        p.steps[0].tokenOut = address(dai);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.WrongFinalToken.selector, address(dai), address(weth)));
        ex.open(p);
        vm.stopPrank();
    }

    /// A route that calls back into the executor in the middle of a swap is stopped by the reentrancy guard.
    function test_security_reentrancyFromRoute() public {
        LeverageExecutorV4.OpenParams memory inner = _openParams(0);
        attackRouter.arm(address(ex), abi.encodeCall(ex.open, (inner)));
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.steps[0].router = address(attackRouter);
        p.steps[0].data =
            abi.encodeCall(attackRouter.swapAndCall, (address(usdc), address(weth), 60_000e6, address(ex)));
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ex.open(p);
        vm.stopPrank();
    }

    /// A route cannot replay the flash loan callback either: it is one-shot and only Morpho may call it.
    function test_security_routeCannotReplayCallback() public {
        attackRouter.arm(address(ex), abi.encodeCall(ex.onMorphoFlashLoan, (1, "")));
        LeverageExecutorV4.OpenParams memory p = _openParams(60_000e6);
        p.steps[0].router = address(attackRouter);
        p.steps[0].data =
            abi.encodeCall(attackRouter.swapAndCall, (address(usdc), address(weth), 60_000e6, address(ex)));
        vm.startPrank(user);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);
        vm.expectRevert(LeverageExecutorV4.CallerNotLender.selector);
        ex.open(p);
        vm.stopPrank();
    }

    /// Tokens someone left in the contract stay out of a user's operation, and no function moves them.
    function test_security_donationsAreNotSwept() public {
        usdc.mint(address(ex), 500e6);
        weth.mint(address(ex), 1e18);
        _open3x();
        assertEq(usdc.balanceOf(address(ex)), 500e6);
        assertEq(weth.balanceOf(address(ex)), 1e18);
        assertEq(usdc.balanceOf(user), 0);
    }

    function testFuzz_openThenCloseAll(uint256 capital, uint256 leverageBps) public {
        capital = bound(capital, 0.01e18, 10e18);
        leverageBps = bound(leverageBps, 10_500, 50_000); // 1.05x to 5x (HF 1.05 at 5x)
        uint256 debtAmount = capital * (leverageBps - 10_000) / 10_000 * 3000 / 1e12;
        vm.assume(debtAmount > 0);

        LeverageExecutorV4.OpenParams memory p = _openParams(debtAmount);
        p.capitalAmount = capital;
        p.guard.minHealthFactor = 1.04e18;
        LeverageExecutorV4.Permit memory permit = _permit(taker.BORROW_PERMIT_TYPEHASH(), D, debtAmount);
        vm.prank(user);
        (uint256 supplied,,) = ex.openWithPermit(p, permit);

        // sell just enough collateral for the debt, rounded up
        uint256 toSell = (debtAmount * 1e12 + 2999) / 3000;
        LeverageExecutorV4.CloseParams memory c = _closeParams(type(uint256).max, type(uint256).max, toSell);
        LeverageExecutorV4.Permit memory wPermit = _permit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, supplied);
        vm.prank(user);
        ex.closeWithPermit(c, wPermit);

        assertEq(spoke.debt(user, D), 0);
        assertEq(spoke.supplied(user, C), 0);
        // at oracle prices and no slippage the user gets the capital back, within the rounding of the last swap
        assertApproxEqAbs(weth.balanceOf(user) + usdc.balanceOf(user) * 1e12 / 3000, 10e18, 1e12);
        _assertClean();
    }
}
