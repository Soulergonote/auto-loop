// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorpho} from "../../src/interfaces/IMorpho.sol";
import {IAaveV4Giver, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {AttackRouter} from "../mocks/AttackRouter.sol";
import {MockMorpho, LazyLender} from "../mocks/MockFlashLenders.sol";
import {TestToken, UsdPrices} from "../morpho/MorphoMocks.sol";
import {MockSpokeV4, MockGiver, MockTaker} from "./V4Mocks.sol";

/// @notice Shared setup of the LeverageExecutorV4 tests: local stand-ins of an Aave v4 spoke and its position managers (V4Mocks.sol):
/// WETH (collateral factor 84 %, 3 000 $) against USDC, a router trading at those prices, Morpho-like flash loans.
/// The same flows run against the real protocol in test/fork/EthereumForkV4.t.sol.
abstract contract V4Base is Test {
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

    function setUp() public virtual {
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
            IMorpho(address(morpho)), IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers, _noPools()
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

    function _noPools() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _none() internal pure returns (SwapExecutorBase.Step[] memory) {
        return new SwapExecutorBase.Step[](0);
    }

    function _noPermit() internal pure returns (LeverageExecutorV4.Permit memory p) {}

    function _guard(uint256 minHf) internal view returns (LeverageExecutorV4.Guard memory) {
        return LeverageExecutorV4.Guard(minHf, vm.getBlockTimestamp() + 20 minutes);
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
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
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
        ex.open(p, permit);
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
}
