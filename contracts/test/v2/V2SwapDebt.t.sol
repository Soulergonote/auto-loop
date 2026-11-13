// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";

/// @notice swapDebt (change 8): replace the debt asset, collateral unchanged. alice opens 3x WETH / USDX, then moves
/// her USDX debt to WBTC (the local market has no second stablecoin; the mechanism does not care).
contract V2SwapDebtTest is V2Base {
    address internal vWBTC;

    function setUp() public override {
        super.setUp();
        vWBTC = pool.getReserveData(WBTC).variableDebtTokenAddress;
    }

    /// @dev WBTC worth `usdx` USDX, plus `extraBps`
    function _wbtcFor(uint256 usdx, uint256 extraBps) internal view returns (uint256) {
        uint256 value = usdx * oracle.getAssetPrice(USDX) / 1e6;
        return value * 1e8 / oracle.getAssetPrice(WBTC) * (10_000 + extraBps) / 10_000;
    }

    function _params(uint256 newDebt, uint256 minRepaid)
        internal
        view
        returns (LeverageExecutorV2.SwapDebtParams memory)
    {
        return LeverageExecutorV2.SwapDebtParams({
            fromAsset: USDX,
            toAsset: WBTC,
            newDebtAmount: newDebt,
            minRepaid: minRepaid,
            steps: _one(_step(WBTC, USDX, newDebt, 50)),
            guard: _guard()
        });
    }

    function _delegate(address user, uint256 amount) internal {
        vm.prank(user);
        IDebtToken(vWBTC).approveDelegation(address(executor), amount);
    }

    function _swapAs(address user, LeverageExecutorV2.SwapDebtParams memory p)
        internal
        returns (LeverageExecutorV2.SwapDebtResult memory r)
    {
        vm.prank(user);
        r = executor.swapDebt(p);
    }

    function test_swapDebt_whole() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        uint256 collateral = _bal(aWETH, alice);
        uint256 newDebt = _wbtcFor(debt, 100);
        uint256 out = router.quote(WBTC, USDX, newDebt);
        uint256 usdxBefore = _bal(USDX, alice);
        _delegate(alice, newDebt);

        LeverageExecutorV2.SwapDebtResult memory r = _swapAs(alice, _params(newDebt, MAX));

        assertEq(_bal(vUSDX, alice), 0, "old debt gone");
        assertApproxEqAbs(_bal(vWBTC, alice), newDebt, 1, "new debt opened, no premium");
        assertEq(_bal(aWETH, alice), collateral, "collateral untouched");
        assertEq(r.repaid, debt);
        assertEq(r.borrowed, newDebt);
        assertEq(r.returned, out - debt, "what the swap bought above the debt goes back");
        assertEq(_bal(USDX, alice) - usdxBefore, out - debt);
        assertEq(r.healthFactor, _hf(alice));
        assertEq(IDebtToken(vWBTC).borrowAllowance(alice, address(executor)), 0, "delegation used exactly");
        _assertClean();
    }

    function test_swapDebt_part() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        uint256 newDebt = _wbtcFor(debt / 2, 0);
        uint256 out = router.quote(WBTC, USDX, newDebt);
        _delegate(alice, newDebt);

        LeverageExecutorV2.SwapDebtResult memory r = _swapAs(alice, _params(newDebt, out));

        assertEq(r.repaid, out, "everything bought repays the old debt");
        assertEq(r.returned, 0);
        assertApproxEqAbs(_bal(vUSDX, alice), debt - out, 1);
        assertApproxEqAbs(_bal(vWBTC, alice), newDebt, 1);
        _assertClean();
    }

    function test_swapDebtWithSig() public {
        _open(alice, 1e18, 300);
        uint256 newDebt = _wbtcFor(_bal(vUSDX, alice), 100);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = EIP712SigUtils.getCreditDelegationTypedDataHash(
            EIP712SigUtils.CreditDelegation({
                delegatee: address(executor), value: newDebt, nonce: 0, deadline: deadline
            }),
            bytes(IDebtToken(vWBTC).name()),
            bytes("1"),
            vWBTC
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePrivateKey, digest);
        LeverageExecutorV2.SwapDebtParams memory p = _params(newDebt, MAX);
        vm.prank(alice);
        executor.swapDebtWithSig(p, LeverageExecutorV2.Signature(newDebt, deadline, v, r, s));
        assertEq(_bal(vUSDX, alice), 0);
        assertApproxEqAbs(_bal(vWBTC, alice), newDebt, 1);
        _assertClean();
    }

    // ---------------------------------------------------------------------------------------------
    // guards
    // ---------------------------------------------------------------------------------------------

    function test_swapDebt_revertsWhenTooLittleRepaid() public {
        _open(alice, 1e18, 300);
        uint256 debt = _bal(vUSDX, alice);
        uint256 newDebt = _wbtcFor(debt / 2, 0);
        _delegate(alice, newDebt);
        LeverageExecutorV2.SwapDebtParams memory p = _params(newDebt, MAX);
        uint256 out = router.quote(WBTC, USDX, newDebt);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV2.RepaidTooLittle.selector, out, debt));
        executor.swapDebt(p);
    }

    function test_swapDebt_revertsUnderMinHealthFactor() public {
        _open(alice, 1e18, 300);
        uint256 newDebt = _wbtcFor(_bal(vUSDX, alice), 100);
        _delegate(alice, newDebt);
        LeverageExecutorV2.SwapDebtParams memory p = _params(newDebt, MAX);
        p.guard.minHealthFactor = 100e18;
        vm.prank(alice);
        vm.expectPartialRevert(LeverageExecutorV2.HealthFactorTooLow.selector);
        executor.swapDebt(p);
    }

    function test_swapDebt_revertsWithoutDelegation() public {
        _open(alice, 1e18, 300);
        LeverageExecutorV2.SwapDebtParams memory p = _params(_wbtcFor(_bal(vUSDX, alice), 100), MAX);
        vm.prank(alice);
        vm.expectRevert();
        executor.swapDebt(p);
    }

    function test_swapDebt_revertsOnSameAssetOrNothing() public {
        LeverageExecutorV2.SwapDebtParams memory p = _params(1e8, MAX);
        p.toAsset = USDX;
        vm.prank(alice);
        vm.expectRevert(SwapExecutorBase.SameAsset.selector);
        executor.swapDebt(p);

        p = _params(0, MAX);
        vm.prank(alice);
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        executor.swapDebt(p);

        // no USDX debt: nothing to repay
        p = _params(1e8, MAX);
        vm.prank(bob);
        vm.expectRevert(LeverageExecutorV2.ZeroAmount.selector);
        executor.swapDebt(p);
    }

    function test_swapDebt_revertsAfterDeadline() public {
        LeverageExecutorV2.SwapDebtParams memory p = _params(1e8, MAX);
        p.guard.deadline = block.timestamp - 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.Expired.selector, block.timestamp - 1));
        executor.swapDebt(p);
    }

    /// @dev alice's delegation can only ever serve alice: a call from the attacker borrows on the attacker's account
    function test_swapDebt_delegationServesOnlyItsOwner() public {
        _open(alice, 1e18, 300);
        uint256 newDebt = _wbtcFor(_bal(vUSDX, alice), 100);
        _delegate(alice, newDebt);
        LeverageExecutorV2.SwapDebtParams memory p = _params(newDebt, 1);
        vm.prank(attacker);
        vm.expectRevert();
        executor.swapDebt(p);
        assertEq(_bal(vWBTC, alice), 0);
        assertEq(IDebtToken(vWBTC).borrowAllowance(alice, address(executor)), newDebt);
    }

    function test_swapDebt_cannotBeCalledBackFromOutside() public {
        // a forged Aave callback is refused: nothing pending
        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        assets[0] = WBTC;
        amounts[0] = 1e8;
        vm.prank(address(pool));
        vm.expectRevert(LeverageExecutorV2.InitiatorNotSelf.selector);
        executor.executeOperation(assets, amounts, new uint256[](1), attacker, "");
    }
}
