// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// Real Aave v3 (aave-v3-origin, v3.6) deployed locally by the official test procedures
import {TestnetProcedures} from "aave-v3-origin/tests/utils/TestnetProcedures.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";
import {Errors} from "aave-v3-origin/src/contracts/protocol/libraries/helpers/Errors.sol";
import {ICreditDelegationToken} from "aave-v3-origin/src/contracts/interfaces/ICreditDelegationToken.sol";

import {LeverageExecutor} from "../src/LeverageExecutor.sol";
import {IAaveV3Pool} from "../src/interfaces/IAaveV3.sol";
import {MockAggregatorRouter, IPriceOracle} from "./mocks/MockAggregatorRouter.sol";

interface IDebtToken {
    function approveDelegation(address delegatee, uint256 amount) external;
    function borrowAllowance(address fromUser, address toUser) external view returns (uint256);
    function name() external view returns (string memory);
}

contract LeverageExecutorTest is TestnetProcedures {
    LeverageExecutor internal executor;
    MockAggregatorRouter internal router;
    IAaveV3Pool internal pool;
    IPriceOracle internal oracle;

    address internal WETH;
    address internal USDX;
    address internal aWETH;
    address internal vUSDX;

    address internal attacker = makeAddr("attacker");

    function setUp() public {
        initTestEnvironment();
        pool = IAaveV3Pool(report.poolProxy);
        oracle = IPriceOracle(report.aaveOracle);
        WETH = tokenList.weth;
        USDX = tokenList.usdx;
        aWETH = pool.getReserveData(WETH).aTokenAddress;
        vUSDX = pool.getReserveData(USDX).variableDebtTokenAddress;

        // borrowable liquidity
        deal(USDX, carol, 10_000_000e6);
        vm.prank(carol);
        contracts.poolProxy.supply(USDX, 10_000_000e6, carol, 0);

        // the "aggregator" holds inventory on both sides
        router = new MockAggregatorRouter(oracle);
        deal(WETH, address(router), 100_000e18);
        deal(USDX, address(router), 100_000_000e6);

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        executor = new LeverageExecutor(pool, address(this), routers);

        vm.label(address(executor), "executor");
        vm.label(address(router), "router");
    }

    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev debt (in USDX units) to borrow for `initial` WETH at leverage `levX100` (300 = 3x)
    function _debtFor(uint256 initial, uint256 levX100) internal view returns (uint256) {
        uint256 value = initial * oracle.getAssetPrice(WETH) / 1e18; // base currency, 8 dec
        return value * (levX100 - 100) / 100 * 1e6 / oracle.getAssetPrice(USDX);
    }

    function _openParams(uint256 initial, uint256 debtAmount, uint256 slippageToleranceBps)
        internal
        view
        returns (LeverageExecutor.OpenParams memory p)
    {
        uint256 expected = router.quote(USDX, WETH, debtAmount);
        p = LeverageExecutor.OpenParams({
            collateralAsset: WETH,
            debtAsset: USDX,
            initialCollateral: initial,
            debtAmount: debtAmount,
            swap: LeverageExecutor.Swap({
                router: address(router),
                data: abi.encodeCall(MockAggregatorRouter.swap, (USDX, WETH, debtAmount, address(executor))),
                minOut: expected * (10_000 - slippageToleranceBps) / 10_000
            })
        });
    }

    function _approveOpen(address user, uint256 initial, uint256 debtAmount) internal {
        vm.startPrank(user);
        IERC20(WETH).approve(address(executor), initial);
        IDebtToken(vUSDX).approveDelegation(address(executor), debtAmount);
        vm.stopPrank();
    }

    function _open(address user, uint256 initial, uint256 levX100) internal returns (uint256 debtAmount) {
        debtAmount = _debtFor(initial, levX100);
        _approveOpen(user, initial, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(initial, debtAmount, 50);
        vm.prank(user);
        executor.open(p);
    }

    /// @dev WETH to sell to get back `debt` + flash premium, with a 1% buffer
    function _wethToCover(uint256 debt) internal view returns (uint256) {
        uint256 owed = debt + debt * 5 / 10_000 + 1;
        uint256 value = owed * oracle.getAssetPrice(USDX) / 1e6;
        return value * 1e18 / oracle.getAssetPrice(WETH) * 101 / 100;
    }

    function _closeParams(uint256 repayAmount, uint256 toWithdraw, uint256 toSell)
        internal
        view
        returns (LeverageExecutor.CloseParams memory)
    {
        return LeverageExecutor.CloseParams({
            collateralAsset: WETH,
            debtAsset: USDX,
            repayAmount: repayAmount,
            collateralToWithdraw: toWithdraw,
            collateralToSell: toSell,
            swap: LeverageExecutor.Swap({
                router: address(router),
                data: abi.encodeCall(MockAggregatorRouter.swap, (WETH, USDX, toSell, address(executor))),
                minOut: router.quote(WETH, USDX, toSell) * 9950 / 10_000
            })
        });
    }

    function _hf(address user) internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(user);
    }

    function _assertExecutorClean() internal view {
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor WETH");
        assertEq(IERC20(USDX).balanceOf(address(executor)), 0, "executor USDX");
        assertEq(IERC20(aWETH).balanceOf(address(executor)), 0, "executor aWETH");
        assertEq(IERC20(WETH).allowance(address(executor), address(router)), 0, "allowance WETH->router");
        assertEq(IERC20(USDX).allowance(address(executor), address(router)), 0, "allowance USDX->router");
        assertEq(IERC20(USDX).allowance(address(executor), address(pool)), 0, "allowance USDX->pool");
        assertEq(IERC20(WETH).allowance(address(executor), address(pool)), 0, "allowance WETH->pool");
    }

    // ---------------------------------------------------------------------------------------------
    // open
    // ---------------------------------------------------------------------------------------------

    function test_open_3x() public {
        uint256 initial = 1e18;
        uint256 wethBefore = IERC20(WETH).balanceOf(alice);

        uint256 debtAmount = _open(alice, initial, 300);

        assertEq(debtAmount, 3600e6, "2x of 1 WETH @1800 in USDX");
        assertEq(IERC20(vUSDX).balanceOf(alice), debtAmount, "variable debt opened for alice, no premium");
        assertApproxEqAbs(IERC20(aWETH).balanceOf(alice), 3e18, 1, "3 WETH supplied for alice");
        assertEq(IERC20(WETH).balanceOf(alice), wethBefore - initial, "only the initial capital left the wallet");
        assertEq(IDebtToken(vUSDX).borrowAllowance(alice, address(executor)), 0, "delegation consumed");
        // HF = 3 * 1800 * 0.86 / 3600 = 1.29
        assertApproxEqRel(_hf(alice), 1.29e18, 1e15);
        _assertExecutorClean();
    }

    function test_open_withSlippage_suppliesWhatWasReceived() public {
        router.setSlippageBps(30); // 0.3 %
        uint256 debtAmount = _open(alice, 2e18, 250);
        uint256 received = debtAmount * 1e12 / 1800 * 9970 / 10_000;
        assertApproxEqAbs(IERC20(aWETH).balanceOf(alice), 2e18 + received, 1e6);
        _assertExecutorClean();
    }

    function test_open_onTopOfExistingPosition_zeroInitial() public {
        vm.prank(alice);
        contracts.poolProxy.supply(WETH, 1e18, alice, 0);

        uint256 debtAmount = _debtFor(1e18, 200);
        _approveOpen(alice, 0, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(0, debtAmount, 0);
        vm.prank(alice);
        executor.open(p);

        assertApproxEqAbs(IERC20(aWETH).balanceOf(alice), 2e18, 1);
        assertEq(IERC20(vUSDX).balanceOf(alice), debtAmount);
    }

    function test_open_routerUsesLess_leftoverReturnedToUser() public {
        router.setUseInputBps(9_000); // router only takes 90 % of the sell amount
        uint256 usdxBefore = IERC20(USDX).balanceOf(alice);
        uint256 debtAmount = _debtFor(1e18, 300);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 1_100);
        vm.prank(alice);
        executor.open(p);

        assertEq(IERC20(vUSDX).balanceOf(alice), debtAmount);
        assertEq(IERC20(USDX).balanceOf(alice), usdxBefore + debtAmount / 10, "unsold 10 % back to alice");
        _assertExecutorClean();
    }

    function test_openWithSig() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = EIP712SigUtils.getCreditDelegationTypedDataHash(
            EIP712SigUtils.CreditDelegation({
                delegatee: address(executor), value: debtAmount, nonce: 0, deadline: deadline
            }),
            bytes(IDebtToken(vUSDX).name()),
            bytes("1"),
            vUSDX
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);

        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        vm.prank(alice);
        executor.openWithSig(p, LeverageExecutor.Signature(debtAmount, deadline, v, r, s));

        assertEq(IERC20(vUSDX).balanceOf(alice), debtAmount);
        assertApproxEqAbs(IERC20(aWETH).balanceOf(alice), 3e18, 1);
    }

    function test_revert_open_tooMuchLeverage() public {
        // max ~ 1 / (1 - 0.825) = 5.7x
        uint256 debtAmount = _debtFor(1e18, 600);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        vm.expectRevert(Errors.CollateralCannotCoverNewBorrow.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_withoutDelegation() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        vm.prank(alice);
        IERC20(WETH).approve(address(executor), 1e18);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        vm.expectPartialRevert(ICreditDelegationToken.InsufficientBorrowAllowance.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_slippageAboveMinOut() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50); // tolerates 0.5 %
        router.setSlippageBps(100); // market moved: 1 %
        vm.expectPartialRevert(LeverageExecutor.InsufficientOutput.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_routerNotWhitelisted() public {
        MockAggregatorRouter rogue = new MockAggregatorRouter(oracle);
        uint256 debtAmount = _debtFor(1e18, 300);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        p.swap.router = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutor.RouterNotAllowed.selector, address(rogue)));
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_outputSentElsewhere() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        p.swap.data = abi.encodeCall(MockAggregatorRouter.swap, (USDX, WETH, debtAmount, attacker));
        vm.expectPartialRevert(LeverageExecutor.InsufficientOutput.selector);
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_greedyRouterCannotPullMoreThanApproved() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        _approveOpen(alice, 1e18, debtAmount);
        LeverageExecutor.OpenParams memory p = _openParams(1e18, debtAmount, 50);
        p.swap.data = abi.encodeCall(MockAggregatorRouter.swapGreedy, (USDX, WETH, debtAmount, address(executor)));
        vm.expectRevert();
        vm.prank(alice);
        executor.open(p);
    }

    function test_revert_open_sameAsset() public {
        LeverageExecutor.OpenParams memory p = _openParams(1e18, 1e6, 0);
        p.debtAsset = WETH;
        vm.expectRevert(LeverageExecutor.SameAsset.selector);
        executor.open(p);
    }

    // ---------------------------------------------------------------------------------------------
    // close
    // ---------------------------------------------------------------------------------------------

    function test_close_full_afterInterestAccrued() public {
        _open(alice, 1e18, 300);
        vm.warp(block.timestamp + 90 days);

        uint256 debt = IERC20(vUSDX).balanceOf(alice);
        assertGt(debt, 3600e6, "interest accrued");
        uint256 toSell = _wethToCover(debt);
        uint256 wethBefore = IERC20(WETH).balanceOf(alice);
        uint256 usdxBefore = IERC20(USDX).balanceOf(alice);
        uint256 aBal = IERC20(aWETH).balanceOf(alice);

        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), type(uint256).max);
        LeverageExecutor.CloseParams memory p = _closeParams(type(uint256).max, type(uint256).max, toSell);
        vm.prank(alice);
        executor.close(p);

        assertEq(IERC20(vUSDX).balanceOf(alice), 0, "debt fully repaid");
        assertEq(IERC20(aWETH).balanceOf(alice), 0, "collateral fully withdrawn");
        uint256 wethBack = IERC20(WETH).balanceOf(alice) - wethBefore;
        assertApproxEqAbs(wethBack, aBal - toSell, 2, "unsold collateral returned");
        assertGt(IERC20(USDX).balanceOf(alice), usdxBefore, "swap excess returned");
        _assertExecutorClean();
    }

    function test_close_partial() public {
        _open(alice, 1e18, 300);
        uint256 hfBefore = _hf(alice);

        uint256 repay = 1800e6;
        uint256 toSell = _wethToCover(repay);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), toSell);
        LeverageExecutor.CloseParams memory p = _closeParams(repay, toSell, toSell);
        vm.prank(alice);
        executor.close(p);

        assertEq(IERC20(vUSDX).balanceOf(alice), 1800e6);
        assertApproxEqAbs(IERC20(aWETH).balanceOf(alice), 3e18 - toSell, 2);
        assertGt(_hf(alice), hfBefore, "deleveraging raises HF");
        _assertExecutorClean();
    }

    function test_closeWithSig() public {
        _open(alice, 1e18, 300);
        uint256 debt = IERC20(vUSDX).balanceOf(alice);
        uint256 toSell = _wethToCover(debt);
        uint256 aBal = IERC20(aWETH).balanceOf(alice);
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

        LeverageExecutor.CloseParams memory p = _closeParams(type(uint256).max, type(uint256).max, toSell);
        vm.prank(alice);
        executor.closeWithSig(p, LeverageExecutor.Signature(aBal, deadline, v, r, s));

        assertEq(IERC20(vUSDX).balanceOf(alice), 0);
        assertEq(IERC20(aWETH).balanceOf(alice), 0);
        _assertExecutorClean();
    }

    function test_revert_close_notEnoughSoldToRepayFlashLoan() public {
        _open(alice, 1e18, 300);
        uint256 debt = IERC20(vUSDX).balanceOf(alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), type(uint256).max);
        LeverageExecutor.CloseParams memory p =
            _closeParams(type(uint256).max, type(uint256).max, _wethToCover(debt) / 2);
        vm.expectPartialRevert(LeverageExecutor.InsufficientToRepayFlashLoan.selector);
        vm.prank(alice);
        executor.close(p);
    }

    function test_revert_close_withdrawWouldBreakHF() public {
        _open(alice, 1e18, 300);
        // repay a little but try to take all collateral out
        uint256 toSell = _wethToCover(100e6);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), type(uint256).max);
        LeverageExecutor.CloseParams memory p = _closeParams(100e6, type(uint256).max, toSell);
        vm.expectRevert(Errors.HealthFactorLowerThanLiquidationThreshold.selector);
        vm.prank(alice);
        executor.close(p);
    }

    // ---------------------------------------------------------------------------------------------
    // access control / abuse
    // ---------------------------------------------------------------------------------------------

    function test_revert_attackerCannotUseVictimDelegation() public {
        uint256 debtAmount = _debtFor(1e18, 300);
        // victim has collateral in Aave and granted delegation + approvals to the executor
        vm.prank(alice);
        contracts.poolProxy.supply(WETH, 10e18, alice, 0);
        _approveOpen(alice, 1e18, debtAmount);

        LeverageExecutor.OpenParams memory p = _openParams(0, debtAmount, 50);
        vm.expectPartialRevert(ICreditDelegationToken.InsufficientBorrowAllowance.selector);
        vm.prank(attacker);
        executor.open(p);

        assertEq(IERC20(vUSDX).balanceOf(alice), 0, "victim debt untouched");
        assertEq(IDebtToken(vUSDX).borrowAllowance(alice, address(executor)), debtAmount);
    }

    function test_revert_attackerCannotCloseVictimPosition() public {
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), type(uint256).max);
        uint256 aBal = IERC20(aWETH).balanceOf(alice);

        // with "max" the debt read is the attacker's own (0)
        LeverageExecutor.CloseParams memory p = _closeParams(type(uint256).max, type(uint256).max, 1e18);
        vm.expectRevert(LeverageExecutor.ZeroAmount.selector);
        vm.prank(attacker);
        executor.close(p);

        // with an explicit amount, Aave refuses to repay a debt the attacker does not have
        deal(USDX, attacker, 0);
        p = _closeParams(100e6, aBal, 1e18);
        vm.expectRevert(Errors.NoDebtOfSelectedType.selector);
        vm.prank(attacker);
        executor.close(p);

        assertEq(IERC20(aWETH).balanceOf(alice), aBal, "victim collateral untouched");
    }

    function test_revert_executeOperation_notPool() public {
        address[] memory a = new address[](1);
        uint256[] memory n = new uint256[](1);
        vm.expectRevert(LeverageExecutor.CallerNotPool.selector);
        vm.prank(attacker);
        executor.executeOperation(a, n, n, address(executor), "");
    }

    function test_revert_flashLoanInitiatedByOther() public {
        // attacker asks Aave to call the executor with crafted params targeting alice
        _approveOpen(alice, 1e18, 3600e6);
        LeverageExecutor.OpenParams memory p = _openParams(0, 3600e6, 50);
        bytes memory params = abi.encode(LeverageExecutor.Action.Open, alice, abi.encode(p));
        address[] memory assets = new address[](1);
        assets[0] = USDX;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 3600e6;
        uint256[] memory modes = new uint256[](1);

        vm.expectRevert(LeverageExecutor.InitiatorNotSelf.selector);
        vm.prank(attacker);
        contracts.poolProxy.flashLoan(address(executor), assets, amounts, modes, attacker, params, 0);
    }

    function test_revert_setRouter_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        executor.setRouter(attacker, true);
    }

    function test_revert_setRouter_poolForbidden() public {
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutor.InvalidRouter.selector, address(pool)));
        executor.setRouter(address(pool), true);
    }

    // ---------------------------------------------------------------------------------------------
    // fuzz
    // ---------------------------------------------------------------------------------------------

    /// @dev Any leverage up to 5x opens with HF > 1 and the expected exposure, then closes back to zero.
    function testFuzz_openThenClose(uint256 initial, uint256 levX100) public {
        initial = bound(initial, 0.01e18, 50e18);
        levX100 = bound(levX100, 110, 500);

        uint256 debtAmount = _open(alice, initial, levX100);
        assertGt(_hf(alice), 1e18);
        assertApproxEqRel(IERC20(aWETH).balanceOf(alice), initial * levX100 / 100, 0.001e18);
        assertEq(IERC20(vUSDX).balanceOf(alice), debtAmount);

        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), type(uint256).max);
        LeverageExecutor.CloseParams memory p =
            _closeParams(type(uint256).max, type(uint256).max, _wethToCover(debtAmount));
        vm.prank(alice);
        executor.close(p);

        assertEq(IERC20(vUSDX).balanceOf(alice), 0);
        assertEq(IERC20(aWETH).balanceOf(alice), 0);
        _assertExecutorClean();
    }
}
