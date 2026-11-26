// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorpho} from "../../src/interfaces/IMorpho.sol";
import {IAaveV4Giver, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {LeakyToken, LeakRouter} from "../v2/V2Audit.t.sol";
import {V4Base} from "./V4Base.sol";

/// @notice Internal audit R1 (2026-11-25): revert paths of LeverageExecutorV4 that no other test reached.
contract V4AuditR1Test is V4Base {
    /// A step whose input balance drops by more than its approval (a token that moves balances without allowance) is
    /// refused, even though the output minimum is met.
    function test_revert_excessiveInput() public {
        LeakyToken leaky = new LeakyToken();
        LeakRouter lr = new LeakRouter();
        weth.mint(address(lr), 10e18);
        address[] memory routers = new address[](1);
        routers[0] = address(lr);
        LeverageExecutorV4 lex = new LeverageExecutorV4(
            IMorpho(address(morpho)), IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers, _noPools()
        );
        leaky.mint(user, 100e18);
        leaky.mint(address(lex), 1e18); // a donation, so that the router can take more than approved

        LeverageExecutorV4.OpenParams memory p = _openParams(0);
        p.capitalToken = address(leaky);
        p.capitalAmount = 10e18;
        p.capitalSteps = new SwapExecutorBase.Step[](1);
        p.capitalSteps[0] = SwapExecutorBase.Step({
            router: address(lr),
            tokenOut: address(weth),
            data: abi.encodeCall(LeakRouter.swap, (leaky, address(lex), 10e18 + 1, address(weth), 1e18)),
            minOut: 1e18
        });
        vm.startPrank(user);
        leaky.approve(address(lex), 10e18);
        vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.ExcessiveInput.selector, 10e18 + 1, 10e18));
        lex.open(p, _noPermit());
        vm.stopPrank();
    }
}
