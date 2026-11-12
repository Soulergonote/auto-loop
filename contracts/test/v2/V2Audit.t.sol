// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {LeverageExecutorV2} from "../../src/LeverageExecutorV2.sol";
import {V2Base} from "./V2Base.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

/// @notice Proof tests for the findings of the internal v2 audit of 2026-11-06 (see README, "Audit interne").
contract V2AuditTest is V2Base {
    address internal donor = makeAddr("donor");
    address internal whale = makeAddr("whale");

    /// @dev `amount` aWETH sent to the executor by a third party (a gift or a griefing attempt)
    function _donateAWeth(uint256 amount) internal {
        deal(WETH, donor, amount);
        vm.startPrank(donor);
        IERC20(WETH).approve(address(pool), amount);
        pool.supply(WETH, amount, donor, 0);
        IERC20(aWETH).transfer(address(executor), amount);
        vm.stopPrank();
    }

    /// @dev borrows WETH until only `left` WETH can still be withdrawn from the reserve
    function _drainWethLiquidityTo(uint256 left) internal {
        uint256 available = _bal(WETH, aWETH);
        uint256 toBorrow = available - left;
        uint256 collateral = toBorrow * oracle.getAssetPrice(WETH) / 1e18 * 1e6 / oracle.getAssetPrice(USDX) * 2;
        deal(USDX, whale, collateral);
        vm.startPrank(whale);
        IERC20(USDX).approve(address(pool), collateral);
        pool.supply(USDX, collateral, whale, 0);
        contracts.poolProxy.borrow(WETH, toBorrow, 2, 0, whale);
        vm.stopPrank();
        assertEq(_bal(WETH, aWETH), left);
    }

    // ---------------------------------------------------------------------------------------------
    // L-01: aTokens sent to the executor are withdrawn with the caller's own
    // ---------------------------------------------------------------------------------------------

    /// A donation larger than what the reserve can pay out must not block other users' closes.
    function test_L01_aTokenDonation_cannotBlockClose() public {
        _open(alice, 1e18, 300);
        uint256 aBal = _bal(aWETH, alice);
        _donateAWeth(5_000e18);
        // the reserve can pay alice, not alice + the donation
        _drainWethLiquidityTo(aBal + 10e18);

        uint256 debt = _bal(vUSDX, alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, _wethToCover(debt), address(morpho));
        vm.prank(alice);
        LeverageExecutorV2.CloseResult memory r = executor.close(p);

        assertEq(r.collateralWithdrawn, aBal, "only alice's collateral");
        assertEq(_bal(vUSDX, alice), 0);
        assertEq(_bal(aWETH, alice), 0);
        assertApproxEqAbs(_bal(aWETH, address(executor)), 5_000e18, 1, "donation untouched");
    }

    /// Same for swapCollateral, the other caller of _pullAndWithdraw.
    function test_L01_aTokenDonation_cannotBlockSwapCollateral() public {
        _open(alice, 1e18, 300);
        uint256 aBal = _bal(aWETH, alice);
        _donateAWeth(5_000e18);
        _drainWethLiquidityTo(aBal + 10e18);

        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.SwapCollateralParams memory p = LeverageExecutorV2.SwapCollateralParams({
            fromAsset: WETH,
            toAsset: WBTC,
            fromAmount: MAX,
            toAmount: router.quote(WETH, WBTC, aBal) * 99 / 100,
            steps: _one(_step(WETH, WBTC, aBal, 50)),
            flashLender: address(morpho),
            guard: _guard()
        });
        vm.prank(alice);
        LeverageExecutorV2.SwapCollateralResult memory r = executor.swapCollateral(p);

        assertEq(r.withdrawn, aBal, "only alice's collateral");
        assertEq(_bal(aWETH, alice), 0);
        assertApproxEqAbs(_bal(aWETH, address(executor)), 5_000e18, 1, "donation untouched");
    }

    /// A donation is never handed to the next caller: the swept amounts are the caller's own.
    function test_L01_aTokenDonation_notPaidToTheNextCaller() public {
        _open(alice, 1e18, 300);
        uint256 aBal = _bal(aWETH, alice);
        _donateAWeth(2e18);

        uint256 debt = _bal(vUSDX, alice);
        uint256 toSell = _wethToCover(debt);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, toSell, address(morpho));
        uint256 wethBefore = _bal(WETH, alice);
        vm.prank(alice);
        LeverageExecutorV2.CloseResult memory r = executor.close(p);

        assertEq(r.collateralWithdrawn, aBal);
        assertEq(r.collateralReturned, aBal - toSell);
        assertEq(_bal(WETH, alice) - wethBefore, aBal - toSell);
        assertApproxEqAbs(_bal(aWETH, address(executor)), 2e18, 1, "donation untouched");
    }

    /// The usual path (no donation) still leaves no aToken dust at all.
    function test_L01_noDonation_noDust() public {
        _open(alice, 1e18, 300);
        vm.warp(block.timestamp + 7 days);
        uint256 debt = _bal(vUSDX, alice);
        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), MAX);
        LeverageExecutorV2.CloseParams memory p = _closeParams(MAX, MAX, _wethToCover(debt), address(morpho));
        vm.prank(alice);
        executor.close(p);
        _assertClean();
    }

    /// Partial withdrawals while a donation sits in the executor take exactly the caller's amount.
    function testFuzz_L01_partialWithdraw_withDonation(uint256 donation, uint256 part) public {
        donation = bound(donation, 1, 1_000e18);
        _open(alice, 1e18, 200);
        vm.warp(block.timestamp + 3 days);
        _donateAWeth(donation);
        uint256 aBal = _bal(aWETH, alice);
        uint256 debtPart = _bal(vUSDX, alice) / 4;
        uint256 toSell = _wethToCover(debtPart);
        part = bound(part, toSell, aBal / 3);

        vm.prank(alice);
        IERC20(aWETH).approve(address(executor), part);
        LeverageExecutorV2.CloseParams memory p = _closeParams(debtPart, part, toSell, address(morpho));
        vm.prank(alice);
        LeverageExecutorV2.CloseResult memory r = executor.close(p);

        assertApproxEqAbs(r.collateralWithdrawn, part, 1, "caller's amount, rounding aside");
        assertApproxEqAbs(_bal(aWETH, address(executor)), donation, 2, "donation untouched");
    }

    // ---------------------------------------------------------------------------------------------
    // revert paths no other test reaches
    // ---------------------------------------------------------------------------------------------

    /// A step whose input balance drops by more than its approval (a token that moves balances without allowance)
    /// is refused, even though the output minimum is met.
    function test_revert_excessiveInput() public {
        LeakyToken leaky = new LeakyToken();
        LeakRouter lr = new LeakRouter();
        deal(WETH, address(lr), 10e18);
        LeverageExecutorV2 ex = _deploy(address(lr));
        leaky.mint(alice, 100e18);
        leaky.mint(address(ex), 1e18); // a donation, so that the router can take more than approved

        LeverageExecutorV2.OpenParams memory p = _openParams(0, 0);
        p.capitalToken = address(leaky);
        p.capitalAmount = 10e18;
        p.capitalSteps = new SwapExecutorBase.Step[](1);
        p.capitalSteps[0] = SwapExecutorBase.Step({
            router: address(lr),
            tokenOut: WETH,
            data: abi.encodeCall(LeakRouter.swap, (leaky, address(ex), 10e18 + 1, WETH, 1e18)),
            minOut: 1e18
        });
        p.steps = _none();
        vm.startPrank(alice);
        leaky.approve(address(ex), 10e18);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.ExcessiveInput.selector, 10e18 + 1, 10e18));
        ex.open(p);
        vm.stopPrank();
    }

    function test_revert_executeOperation_multipleAssets() public {
        address[] memory a = new address[](2);
        uint256[] memory n = new uint256[](2);
        vm.expectRevert(LeverageExecutorV2.InvalidFlashLoan.selector);
        vm.prank(address(pool));
        executor.executeOperation(a, n, n, address(executor), "");
    }
}

/// @dev an ERC20 whose balances anybody can move (stands for a rebasing or otherwise misbehaving token)
contract LeakyToken is ERC20("Leaky", "LEAK") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function leak(address from, address to, uint256 amount) external {
        _transfer(from, to, amount);
    }
}

contract LeakRouter {
    function swap(LeakyToken tokenIn, address from, uint256 take, address tokenOut, uint256 out) external {
        tokenIn.leak(from, address(this), take);
        IERC20(tokenOut).transfer(msg.sender, out);
    }
}
