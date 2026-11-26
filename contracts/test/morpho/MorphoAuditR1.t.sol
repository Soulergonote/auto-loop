// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorpho} from "../../src/interfaces/IMorpho.sol";
import {LazyLender} from "../mocks/MockFlashLenders.sol";
import {LeakyToken, LeakRouter} from "../v2/V2Audit.t.sol";
import {MorphoBase} from "./MorphoBase.sol";

/// @notice Internal audit R1 (2026-11-25): revert paths of LeverageExecutorMorpho that no other test reached. The
/// rounding finding L-01 is proven against real SparkLend in test/fork/EthereumForkAuditR1.t.sol.
contract MorphoAuditR1Test is MorphoBase {
    /// A step whose input balance drops by more than its approval (a token that moves balances without allowance) is
    /// refused, even though the output minimum is met.
    function test_revert_excessiveInput() public {
        LeakyToken leaky = new LeakyToken();
        LeakRouter lr = new LeakRouter();
        pt1.mint(address(lr), 1000e18);
        address[] memory routers = new address[](1);
        routers[0] = address(lr);
        LeverageExecutorMorpho lex = new LeverageExecutorMorpho(morpho, routers, new address[](0));
        leaky.mint(user, 100e18);
        leaky.mint(address(lex), 1e18); // a donation, so that the router can take more than approved

        LeverageExecutorMorpho.OpenParams memory p;
        p.market = m1;
        p.capitalToken = address(leaky);
        p.capitalAmount = 10e18;
        p.capitalSteps = new SwapExecutorBase.Step[](1);
        p.capitalSteps[0] = SwapExecutorBase.Step({
            router: address(lr),
            tokenOut: address(pt1),
            data: abi.encodeCall(LeakRouter.swap, (leaky, address(lex), 10e18 + 1, address(pt1), 1e18)),
            minOut: 1e18
        });
        p.steps = _none();
        p.guard = _guard(0);
        vm.startPrank(user);
        leaky.approve(address(lex), 10e18);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.ExcessiveInput.selector, 10e18 + 1, 10e18));
        lex.open(p);
        vm.stopPrank();
    }

    /// A lender that takes the request and never calls back makes the call revert instead of silently doing nothing.
    function test_revert_flashLoanNotExecuted() public {
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        LeverageExecutorMorpho lazy =
            new LeverageExecutorMorpho(IMorpho(address(new LazyLender())), routers, new address[](0));
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        vm.startPrank(user);
        IERC20(address(pt1)).approve(address(lazy), p.capitalAmount);
        vm.expectRevert(LeverageExecutorMorpho.FlashLoanNotExecuted.selector);
        lazy.open(p);
        vm.stopPrank();
    }
}
