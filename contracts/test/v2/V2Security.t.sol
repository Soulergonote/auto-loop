// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {AttackRouter} from "../mocks/AttackRouter.sol";
import {MockMorpho} from "../mocks/MockFlashLenders.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

/// @notice Attacks on every entry point and callback: forged flash loan callbacks, re-entrancy from inside a
/// swap route, abuse of allowances other users left, deployment mistakes, and the bytecode itself.
contract V2SecurityTest is V2Base {
    // ---------------------------------------------------------------------------------------------
    // forged flash loan callbacks
    // ---------------------------------------------------------------------------------------------

    function _closeData(address victim) internal view returns (bytes memory) {
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, 1e18, address(balancer));
        // the attacker makes the "swap" pay him
        p.steps[0].data = abi.encodeCall(router.swap, (WETH, USDX, 1e18, attacker));
        p.steps[0].minOut = 0;
        return abi.encode(LeverageExecutorV2.Action.Close, victim, abi.encode(p));
    }

    function _victimWithOpenApprovals() internal {
        _open(alice, 1e18, 300);
        vm.startPrank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        IDebtToken(vUSDX).approveDelegation(address(executor), MAX);
        IERC20(WETH).approve(address(executor), MAX);
        vm.stopPrank();
    }

    function test_revert_executeOperation_notFromPool() public {
        address[] memory a = new address[](1);
        uint256[] memory n = new uint256[](1);
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(attacker);
        executor.executeOperation(a, n, n, address(executor), "");
    }

    function test_revert_aaveFlashLoanInitiatedByOther() public {
        _victimWithOpenApprovals();
        address[] memory assets = new address[](1);
        assets[0] = USDX;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000e6;
        uint256[] memory modes = new uint256[](1);
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.InitiatorNotSelf.selector);
        vm.prank(attacker);
        contracts.poolProxy.flashLoan(address(executor), assets, amounts, modes, attacker, forged, 0);
    }

    function test_revert_executeOperation_fromPoolWithNothingPending() public {
        // even with initiator == executor (impossible through the real Pool), nothing is pending
        address[] memory a = new address[](1);
        a[0] = USDX;
        uint256[] memory n = new uint256[](1);
        n[0] = 1;
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        vm.prank(address(pool));
        executor.executeOperation(a, n, n, address(executor), forged);
    }

    function test_revert_onMorphoFlashLoan_notFromMorpho() public {
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(attacker);
        executor.onMorphoFlashLoan(1, abi.encode(USDX, forged));
    }

    function test_revert_onMorphoFlashLoan_fromAnotherMorphoInstance() public {
        MockMorpho other = new MockMorpho();
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(address(other));
        executor.onMorphoFlashLoan(1, abi.encode(USDX, forged));
    }

    function test_revert_onMorphoFlashLoan_fromMorphoWithNothingPending() public {
        _victimWithOpenApprovals();
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        vm.prank(address(morpho));
        executor.onMorphoFlashLoan(3600e6, abi.encode(USDX, forged));
    }

    function test_revert_onMorphoFlashLoan_isNotABalancerVault() public {
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(address(balancer));
        executor.onMorphoFlashLoan(1, abi.encode(USDX, forged));
    }

    function test_revert_balancerFlashLoanNamingTheExecutor() public {
        // the Balancer Vault lets anyone name any recipient: the classic attack on flash loan receivers
        _victimWithOpenApprovals();
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(USDX);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _bal(vUSDX, alice);
        bytes memory forged = _closeData(alice);
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        vm.prank(attacker);
        balancer.flashLoan(address(executor), tokens, amounts, forged);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
    }

    function test_revert_receiveFlashLoan_notFromVault() public {
        IERC20[] memory tokens = new IERC20[](1);
        uint256[] memory n = new uint256[](1);
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(attacker);
        executor.receiveFlashLoan(tokens, n, n, "");
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(address(morpho));
        executor.receiveFlashLoan(tokens, n, n, "");
    }

    function test_revert_receiveFlashLoan_multipleTokens() public {
        IERC20[] memory tokens = new IERC20[](2);
        uint256[] memory n = new uint256[](2);
        vm.expectRevert(LeverageExecutorV2.InvalidFlashLoan.selector);
        vm.prank(address(balancer));
        executor.receiveFlashLoan(tokens, n, n, "");
    }

    // ---------------------------------------------------------------------------------------------
    // attacks from inside a swap route (a whitelisted router running hostile code)
    // ---------------------------------------------------------------------------------------------

    AttackRouter internal evil;
    LeverageExecutorV2 internal exEvil;

    function _evilSetup() internal {
        evil = new AttackRouter(oracle);
        _fund(address(evil));
        address[] memory routers = new address[](1);
        routers[0] = address(evil);
        LeverageExecutorV2.FlashLender[] memory lenders = new LeverageExecutorV2.FlashLender[](2);
        lenders[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, address(morpho));
        lenders[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, address(balancer));
        exEvil = new LeverageExecutorV2(pool, routers, lenders);
    }

    function _evilOpen(address user) internal returns (LeverageExecutorV2.OpenParams memory p) {
        uint256 debt = 3600e6;
        vm.startPrank(user);
        IERC20(WETH).approve(address(exEvil), 1e18);
        IDebtToken(vUSDX).approveDelegation(address(exEvil), debt);
        vm.stopPrank();
        p = _openParams(1e18, debt);
        p.steps[0].router = address(evil);
        p.steps[0].data = abi.encodeCall(evil.swapAndCall, (USDX, WETH, debt, address(exEvil)));
    }

    function _evilClose(address user, address lender) internal returns (LeverageExecutorV2.CloseParams memory p) {
        vm.prank(user);
        IERC20(aWETH).approve(address(exEvil), MAX);
        uint256 toSell = _wethToCover(_bal(vUSDX, user));
        p = _closeParams(MAX, MAX, toSell, lender);
        p.steps[0].router = address(evil);
        p.steps[0].data = abi.encodeCall(evil.swapAndCall, (WETH, USDX, toSell, address(exEvil)));
    }

    function test_revert_midSwap_reenterOpen() public {
        _evilSetup();
        LeverageExecutorV2.OpenParams memory inner = _openParams(0, 1e6);
        evil.arm(address(exEvil), abi.encodeCall(exEvil.open, (inner)));
        LeverageExecutorV2.OpenParams memory p = _evilOpen(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        exEvil.open(p);
    }

    function test_revert_midSwap_reenterCloseAndSwapCollateral() public {
        _evilSetup();
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory inner = _closeParams(MAX, MAX, 1e18, address(morpho));
        evil.arm(address(exEvil), abi.encodeCall(exEvil.close, (inner)));
        LeverageExecutorV2.CloseParams memory p = _evilClose(alice, address(morpho));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        exEvil.close(p);

        LeverageExecutorV2.SwapCollateralParams memory sc;
        evil.arm(address(exEvil), abi.encodeCall(exEvil.swapCollateral, (sc)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        exEvil.close(p);
    }

    function test_revert_midSwap_balancerFlashLoanToExecutor() public {
        // while bob opens, the route asks Balancer to call the executor with a close of alice's position
        _evilSetup();
        _open(alice, 1e18, 300);
        vm.prank(alice);
        IERC20(aWETH).approve(address(exEvil), MAX);
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(USDX);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _bal(vUSDX, alice);
        bytes memory forged = _closeData(alice);
        evil.arm(address(balancer), abi.encodeCall(balancer.flashLoan, (address(exEvil), tokens, amounts, forged)));
        LeverageExecutorV2.OpenParams memory p = _evilOpen(bob);
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        vm.prank(bob);
        exEvil.open(p);
    }

    function test_revert_midSwap_balancerReplaysThePendingCall() public {
        // during a close through Morpho, the route asks Balancer for a loan with the very same data: the pending
        // loan was already consumed by Morpho's callback, and it named another lender anyway
        _evilSetup();
        _open(alice, 1e18, 300);
        LeverageExecutorV2.CloseParams memory p = _evilClose(alice, address(morpho));
        uint256 debt = _bal(vUSDX, alice);
        LeverageExecutorV2.CloseParams memory stored = p;
        stored.repayAmount = debt;
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(USDX);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debt;
        bytes memory same = abi.encode(LeverageExecutorV2.Action.Close, alice, abi.encode(stored));
        evil.arm(address(balancer), abi.encodeCall(balancer.flashLoan, (address(exEvil), tokens, amounts, same)));
        vm.expectRevert(LeverageExecutorV2.UnexpectedFlashLoan.selector);
        vm.prank(alice);
        exEvil.close(p);
    }

    function test_revert_midSwap_callbacksDirectly() public {
        _evilSetup();
        LeverageExecutorV2.OpenParams memory p = _evilOpen(alice);
        bytes memory forged = _closeData(bob);
        evil.arm(address(exEvil), abi.encodeCall(exEvil.onMorphoFlashLoan, (1, abi.encode(USDX, forged))));
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(alice);
        exEvil.open(p);

        address[] memory a = new address[](1);
        uint256[] memory n = new uint256[](1);
        evil.arm(address(exEvil), abi.encodeCall(exEvil.executeOperation, (a, n, n, address(exEvil), "")));
        vm.expectRevert(LeverageExecutorV2.CallerNotLender.selector);
        vm.prank(alice);
        exEvil.open(p);
    }

    function test_revert_midSwap_aaveFlashLoanToExecutor() public {
        _evilSetup();
        address[] memory assets = new address[](1);
        assets[0] = USDX;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000e6;
        uint256[] memory modes = new uint256[](1);
        bytes memory forged = _closeData(bob);
        evil.arm(
            address(pool),
            abi.encodeCall(IAaveV3Pool.flashLoan, (address(exEvil), assets, amounts, modes, address(evil), forged, 0))
        );
        LeverageExecutorV2.OpenParams memory p = _evilOpen(alice);
        vm.expectRevert(LeverageExecutorV2.InitiatorNotSelf.selector);
        vm.prank(alice);
        exEvil.open(p);
    }

    function test_revert_midSwap_stealUserAllowances() public {
        // the route tries to pull another user's tokens and aTokens: the router is not the executor, it has no
        // allowance (users only approve the executor)
        _evilSetup();
        vm.prank(bob);
        IERC20(WETH).approve(address(exEvil), MAX);
        evil.arm(WETH, abi.encodeCall(IERC20.transferFrom, (bob, attacker, 1e18)));
        LeverageExecutorV2.OpenParams memory p = _evilOpen(alice);
        vm.expectRevert(); // ERC20: insufficient allowance
        vm.prank(alice);
        exEvil.open(p);
    }

    function test_midSwap_harmlessCallbackStillWorks() public {
        // control: the hostile router with a no-op payload is a normal router
        _evilSetup();
        evil.arm(address(oracle), abi.encodeCall(oracle.getAssetPrice, (WETH)));
        LeverageExecutorV2.OpenParams memory p = _evilOpen(alice);
        vm.prank(alice);
        exEvil.open(p);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
        _assertClean(exEvil, address(evil));
    }

    // ---------------------------------------------------------------------------------------------
    // allowances and delegations left by other users
    // ---------------------------------------------------------------------------------------------

    function test_revert_attackerCannotBorrowOnVictimDelegation() public {
        _victimWithOpenApprovals();
        uint256 debtBefore = _bal(vUSDX, alice);
        LeverageExecutorV2.OpenParams memory p = _openParams(0, 1000e6);
        vm.expectRevert(); // borrows on behalf of the attacker, who has no collateral and no delegation
        vm.prank(attacker);
        executor.open(p);
        assertEq(_bal(vUSDX, alice), debtBefore);
    }

    function test_revert_attackerCannotSpendVictimCapitalAllowance() public {
        _victimWithOpenApprovals();
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, 0);
        p.steps = _none();
        vm.expectRevert(); // transferFrom(attacker)
        vm.prank(attacker);
        executor.open(p);
    }

    function test_revert_attackerCannotCloseVictimPosition() public {
        _victimWithOpenApprovals();
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, 1e18, address(morpho));
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector); // the attacker's own debt
        vm.prank(attacker);
        executor.close(p);
        p.repayAmount = 1000e6;
        vm.expectRevert(); // Aave: no debt for the attacker
        vm.prank(attacker);
        executor.close(p);
        assertApproxEqAbs(_bal(aWETH, alice), 3e18, 1);
    }

    function test_revert_attackerCannotRouteToAToken() public {
        _victimWithOpenApprovals();
        LeverageExecutorV2.OpenParams memory p = _openParams(0, 1e6);
        p.steps[0].router = aWETH;
        p.steps[0].data = abi.encodeCall(IERC20.transferFrom, (alice, attacker, 1e18));
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.RouterNotAllowed.selector, aWETH));
        vm.prank(attacker);
        executor.open(p);
    }

    function test_closeWithSig_frontRunPermitStillCloses() public {
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
        vm.prank(attacker);
        IERC20PermitLike(aWETH).permit(alice, address(executor), aBal, deadline, v, r, s);

        LeverageExecutorV2.CloseParams memory p =
            _closeParams(MAX, MAX, _wethToCover(_bal(vUSDX, alice)), address(morpho));
        vm.prank(alice);
        executor.closeWithSig(p, LeverageExecutorV2.Signature(aBal, deadline, v, r, s));
        assertEq(_bal(vUSDX, alice), 0);
    }

    function test_donations_doNotBlockAndStay() public {
        // tokens sent to the executor by mistake do not block anything and stay there (deltas only; aTokens: V2Audit)
        deal(WETH, address(this), 1e18);
        IERC20(WETH).transfer(address(executor), 1e18);
        _open(alice, 1e18, 300);
        assertEq(_bal(WETH, address(executor)), 1e18, "a plain donation stays (deltas only)");

        LeverageExecutorV2.CloseParams memory p =
            _closeParams(MAX, MAX, _wethToCover(_bal(vUSDX, alice)), address(morpho));
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        vm.prank(alice);
        executor.close(p);
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, address(executor)), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // deployment
    // ---------------------------------------------------------------------------------------------

    function _lenders(LeverageExecutorV2.FlashKind kind, address l)
        internal
        pure
        returns (LeverageExecutorV2.FlashLender[] memory a)
    {
        a = new LeverageExecutorV2.FlashLender[](1);
        a[0] = LeverageExecutorV2.FlashLender(kind, l);
    }

    function _routers(address r) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = r;
    }

    function test_constructor_rejectsBadRouters() public {
        LeverageExecutorV2.FlashLender[] memory none;
        vm.expectRevert(SwapExecutorBase.ZeroAddress.selector);
        new LeverageExecutorV2(IAaveV3Pool(address(0)), _routers(address(router)), none);

        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, address(pool)));
        new LeverageExecutorV2(pool, _routers(address(pool)), none);

        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, address(0)));
        new LeverageExecutorV2(pool, _routers(address(0)), none);

        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, eoa));
        new LeverageExecutorV2(pool, _routers(eoa), none);

        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, self));
        new LeverageExecutorV2(pool, _routers(self), none);

        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, address(morpho)));
        new LeverageExecutorV2(
            pool, _routers(address(morpho)), _lenders(LeverageExecutorV2.FlashKind.Morpho, address(morpho))
        );
    }

    function test_constructor_rejectsAaveTokensAsRouters() public {
        // calling a token from the executor could spend allowances users gave it: no Aave token is ever a router
        LeverageExecutorV2.FlashLender[] memory none;
        address[4] memory aaveTokens = [WBTC, aWETH, vUSDX, USDX];
        for (uint256 i; i < aaveTokens.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, aaveTokens[i]));
            new LeverageExecutorV2(pool, _routers(aaveTokens[i]), none);
        }
    }

    function test_constructor_acceptsRoutersWithAFallback() public {
        // the aToken probe must not break on routers that answer anything (or nothing) to unknown selectors
        LeverageExecutorV2.FlashLender[] memory none;
        address[] memory rs = new address[](3);
        rs[0] = address(new FallbackReturnsWord());
        rs[1] = address(new FallbackReverts());
        rs[2] = address(new FallbackReturnsNothing());
        LeverageExecutorV2 ex = new LeverageExecutorV2(pool, rs, none);
        for (uint256 i; i < rs.length; ++i) {
            assertTrue(ex.isRouterAllowed(rs[i]));
        }
    }

    function test_constructor_rejectsBadLenders() public {
        address[] memory rs = _routers(address(router));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidFlashLender.selector, address(morpho)));
        new LeverageExecutorV2(pool, rs, _lenders(LeverageExecutorV2.FlashKind.None, address(morpho)));

        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidFlashLender.selector, address(pool)));
        new LeverageExecutorV2(pool, rs, _lenders(LeverageExecutorV2.FlashKind.Balancer, address(pool)));

        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidFlashLender.selector, eoa));
        new LeverageExecutorV2(pool, rs, _lenders(LeverageExecutorV2.FlashKind.Morpho, eoa));

        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidFlashLender.selector, self));
        new LeverageExecutorV2(pool, rs, _lenders(LeverageExecutorV2.FlashKind.Morpho, self));

        LeverageExecutorV2.FlashLender[] memory dup = new LeverageExecutorV2.FlashLender[](2);
        dup[0] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Morpho, address(morpho));
        dup[1] = LeverageExecutorV2.FlashLender(LeverageExecutorV2.FlashKind.Balancer, address(morpho));
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.InvalidFlashLender.selector, address(morpho)));
        new LeverageExecutorV2(pool, rs, dup);
    }

    function test_constructor_registersExactlyWhatItWasGiven() public view {
        assertTrue(executor.isRouterAllowed(address(router)));
        assertFalse(executor.isRouterAllowed(address(morpho)));
        assertFalse(executor.isRouterAllowed(address(pool)));
        assertEq(uint8(executor.flashLenderKind(address(morpho))), uint8(LeverageExecutorV2.FlashKind.Morpho));
        assertEq(uint8(executor.flashLenderKind(address(balancer))), uint8(LeverageExecutorV2.FlashKind.Balancer));
        assertEq(uint8(executor.flashLenderKind(address(router))), uint8(LeverageExecutorV2.FlashKind.None));
        assertEq(address(executor.POOL()), address(pool));
        assertEq(executor.MAX_STEPS(), 4);
    }

    function test_noAdmin_noOwnerSelectors() public {
        bytes4[5] memory admin = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("setRouter(address,bool)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("rescue(address,uint256)"))
        ];
        for (uint256 i; i < admin.length; ++i) {
            (bool ok,) = address(executor).call(abi.encodeWithSelector(admin[i]));
            assertFalse(ok);
        }
    }

    /// @dev walks the runtime bytecode (skipping PUSH data): no SELFDESTRUCT, no DELEGATECALL, no CALLCODE
    function test_bytecode_noSelfdestructNoDelegatecall() public view {
        bytes memory code = address(executor).code;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xff, "SELFDESTRUCT");
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // PUSH1..PUSH32
            ++i;
        }
    }
}

contract FallbackReturnsWord {
    fallback() external {
        assembly {
            mstore(0, 0xdead)
            return(0, 32)
        }
    }
}

contract FallbackReverts {
    fallback() external {
        revert();
    }
}

contract FallbackReturnsNothing {
    fallback() external {}
}

interface IERC20PermitLike {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
