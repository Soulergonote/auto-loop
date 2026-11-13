// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {V2Base, IDebtToken} from "./V2Base.sol";

/// @notice A pool without flash premium (SparkLend, which refuses a flash loan opened as debt): open and swapDebt
/// take a mode 0 flash loan and borrow it for the caller in the callback. Same result, same delegation.
contract V2NoPremiumTest is V2Base {
    function setUp() public override {
        super.setUp();
        vm.prank(poolAdmin);
        contracts.poolConfiguratorProxy.updateFlashloanPremium(0);
        assertEq(pool.FLASHLOAN_PREMIUM_TOTAL(), 0);
    }

    /// @dev interest rate mode of the Pool's FlashLoan event in the recorded logs
    function _flashMode() internal returns (uint256 mode) {
        bytes32 sig = keccak256("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pool) && logs[i].topics[0] == sig) {
                (,, mode,) = abi.decode(logs[i].data, (address, uint256, uint256, uint256));
                found = true;
            }
        }
        assertTrue(found, "FlashLoan emitted");
    }

    function test_open_usesModeZeroAndBorrowsInCallback() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, debt);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);

        vm.recordLogs();
        vm.prank(alice);
        (uint256 supplied, uint256 borrowed, uint256 hf) = executor.open(p);

        assertEq(_flashMode(), 0, "mode 0 flash loan, not a flash loan into debt");
        assertEq(supplied, 3e18);
        assertEq(borrowed, debt);
        assertEq(_bal(vUSDX, alice), debt, "debt opened for alice, nothing more (no premium)");
        assertEq(hf, _hf(alice));
        assertEq(IDebtToken(vUSDX).borrowAllowance(alice, address(executor)), 0, "delegation used up");
        _assertClean();
    }

    function test_open_withoutDelegation_reverts() public {
        uint256 debt = _debtFor(1e18, 300);
        _approveOpen(alice, WETH, 1e18, 0);
        LeverageExecutorV2.OpenParams memory p = _openParams(1e18, debt);
        vm.prank(alice);
        vm.expectRevert();
        executor.open(p);
    }

    function test_openThenClose_roundTrip() public {
        uint256 debt = _open(alice, 1e18, 300);
        assertEq(_bal(vUSDX, alice), debt);
        LeverageExecutorV2.CloseParams memory c = _closeParams(MAX, MAX, _wethToCover(debt), address(pool));
        vm.prank(alice);
        IERC20Like(aWETH).approve(address(executor), MAX);
        vm.prank(alice);
        executor.close(c);
        assertEq(_bal(vUSDX, alice), 0, "debt repaid");
        assertEq(_bal(aWETH, alice), 0, "collateral withdrawn");
        _assertClean();
    }

    function test_swapDebt_usesModeZeroAndBorrowsInCallback() public {
        _open(alice, 1e18, 300);
        address vWBTC = pool.getReserveData(WBTC).variableDebtTokenAddress;
        uint256 debt = _bal(vUSDX, alice);
        uint256 newDebt = (debt * oracle.getAssetPrice(USDX) / 1e6) * 1e8 / oracle.getAssetPrice(WBTC) * 10_100 / 10_000;
        vm.prank(alice);
        IDebtToken(vWBTC).approveDelegation(address(executor), newDebt);
        LeverageExecutorV2.SwapDebtParams memory p = LeverageExecutorV2.SwapDebtParams({
            fromAsset: USDX,
            toAsset: WBTC,
            newDebtAmount: newDebt,
            minRepaid: MAX,
            steps: _one(_step(WBTC, USDX, newDebt, 50)),
            guard: _guard()
        });
        vm.recordLogs();
        vm.prank(alice);
        LeverageExecutorV2.SwapDebtResult memory r = executor.swapDebt(p);
        assertEq(_flashMode(), 0, "mode 0 flash loan");
        assertEq(r.repaid, debt);
        assertEq(_bal(vUSDX, alice), 0, "old debt repaid");
        assertEq(_bal(vWBTC, alice), newDebt, "new debt is exactly the loan");
        _assertClean();
    }
}

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
}
