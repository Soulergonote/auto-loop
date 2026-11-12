// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {IMorpho, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {MORPHO_BLUE_BYTECODE} from "./MorphoBlueBytecode.sol";
import {TestToken, UsdPrices, MockMorphoOracle, FixedRateIrm} from "./MorphoMocks.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

interface IMorphoAdmin {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function createMarket(MarketParams memory marketParams) external;
    function supply(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
}

/// @notice Local setup with the real Morpho Blue v1.0.0 bytecode: USDC (6 decimals) lent against two Pendle-like
/// PTs (18 decimals), a fixed 5 %/year borrow rate, and a router that swaps at USD prices.
abstract contract MorphoBase is Test {
    bytes32 constant AUTHORIZATION_TYPEHASH =
        keccak256("Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)");
    uint256 constant LLTV = 0.915e18;
    uint256 constant LLTV_LOW = 0.86e18;
    uint256 constant RATE_5PCT = 1_585_489_599; // per second, WAD

    IMorpho morpho;
    LeverageExecutorMorpho ex;
    MockAggregatorRouter router;
    UsdPrices prices;
    TestToken usdc;
    TestToken pt1;
    TestToken pt2;
    TestToken weth;
    MarketParams m1; // PT1 / USDC, LLTV 91.5 %
    MarketParams m2; // PT2 / USDC, LLTV 91.5 %
    MarketParams m3; // PT1 / USDC, LLTV 86 % (same collateral, another market)

    address user;
    uint256 userKey;
    address lender = makeAddr("lender");

    function setUp() public virtual {
        (user, userKey) = makeAddrAndKey("user");
        bytes memory code = abi.encodePacked(MORPHO_BLUE_BYTECODE, abi.encode(address(this)));
        address m;
        assembly ("memory-safe") {
            m := create(0, add(code, 32), mload(code))
        }
        require(m != address(0), "morpho deploy");
        morpho = IMorpho(m);
        vm.label(m, "Morpho");

        usdc = new TestToken("USDC", 6);
        pt1 = new TestToken("PT1", 18);
        pt2 = new TestToken("PT2", 18);
        weth = new TestToken("WETH", 18);
        prices = new UsdPrices();
        prices.set(address(usdc), 1e8);
        prices.set(address(pt1), 0.95e8);
        prices.set(address(pt2), 0.93e8);
        prices.set(address(weth), 3000e8);

        FixedRateIrm irm = new FixedRateIrm(RATE_5PCT);
        IMorphoAdmin(m).enableIrm(address(irm));
        IMorphoAdmin(m).enableLltv(LLTV);
        IMorphoAdmin(m).enableLltv(LLTV_LOW);
        m1 = MarketParams(address(usdc), address(pt1), address(new MockMorphoOracle(0.95e24)), address(irm), LLTV);
        m2 = MarketParams(address(usdc), address(pt2), address(new MockMorphoOracle(0.93e24)), address(irm), LLTV);
        m3 = MarketParams(address(usdc), address(pt1), m1.oracle, address(irm), LLTV_LOW);
        IMorphoAdmin(m).createMarket(m1);
        IMorphoAdmin(m).createMarket(m2);
        IMorphoAdmin(m).createMarket(m3);

        usdc.mint(lender, 30_000_000e6);
        vm.startPrank(lender);
        usdc.approve(m, type(uint256).max);
        IMorphoAdmin(m).supply(m1, 10_000_000e6, 0, lender, "");
        IMorphoAdmin(m).supply(m2, 10_000_000e6, 0, lender, "");
        IMorphoAdmin(m).supply(m3, 10_000_000e6, 0, lender, "");
        vm.stopPrank();

        router = new MockAggregatorRouter(IPriceOracle(address(prices)));
        usdc.mint(address(router), 100_000_000e6);
        pt1.mint(address(router), 100_000_000e18);
        pt2.mint(address(router), 100_000_000e18);
        weth.mint(address(router), 100_000e18);

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        ex = new LeverageExecutorMorpho(morpho, routers);

        pt1.mint(user, 10_000e18);
        usdc.mint(user, 10_000e6);
        weth.mint(user, 10e18);
    }

    // ---------------------------------------------------------------- helpers

    function _id(MarketParams memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    function _step(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (SwapExecutorBase.Step memory)
    {
        return SwapExecutorBase.Step(
            address(router), tokenOut, abi.encodeCall(router.swap, (tokenIn, tokenOut, amountIn, address(ex))), minOut
        );
    }

    function _one(SwapExecutorBase.Step memory s) internal pure returns (SwapExecutorBase.Step[] memory a) {
        a = new SwapExecutorBase.Step[](1);
        a[0] = s;
    }

    function _none() internal pure returns (SwapExecutorBase.Step[] memory) {
        return new SwapExecutorBase.Step[](0);
    }

    function _guard(uint256 minHf) internal view returns (LeverageExecutorMorpho.Guard memory) {
        return LeverageExecutorMorpho.Guard(minHf, block.timestamp + 20 minutes);
    }

    function _sign(uint256 key, Authorization memory a) internal view returns (MorphoSignature memory s) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", IMorphoAdmin(address(morpho)).DOMAIN_SEPARATOR(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))
            )
        );
        (s.v, s.r, s.s) = vm.sign(key, digest);
    }

    function _auth(uint256 key, address who) internal view returns (LeverageExecutorMorpho.AuthSigs memory a) {
        a.nonce = morpho.nonce(who);
        a.deadline = block.timestamp + 20 minutes;
        a.grant = _sign(key, Authorization(who, address(ex), true, a.nonce, a.deadline));
        a.revoke = _sign(key, Authorization(who, address(ex), false, a.nonce + 1, a.deadline));
    }

    /// @dev 5x on m1 with 1000 PT1: 3800 USDC borrowed and sold for 4000 PT1, 5000 PT1 supplied
    function _openParams() internal view returns (LeverageExecutorMorpho.OpenParams memory p) {
        p.market = m1;
        p.capitalToken = address(pt1);
        p.capitalAmount = 1000e18;
        p.capitalSteps = _none();
        p.debtAmount = 3800e6;
        p.steps = _one(_step(address(usdc), address(pt1), 3800e6, 3990e18));
        p.guard = _guard(1.1e18);
    }

    function _openAsUser() internal {
        LeverageExecutorMorpho.OpenParams memory p = _openParams();
        LeverageExecutorMorpho.AuthSigs memory a = _auth(userKey, user);
        vm.startPrank(user);
        pt1.approve(address(ex), p.capitalAmount);
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function _position(MarketParams memory m, address who) internal view returns (uint256 borrowShares, uint256 coll) {
        (, uint128 b, uint128 c) = morpho.position(_id(m), who);
        return (b, c);
    }

    function _debt(MarketParams memory m, address who) internal view returns (uint256) {
        (, uint128 b,) = morpho.position(_id(m), who);
        (,, uint128 tba, uint128 tbs,,) = morpho.market(_id(m));
        return (uint256(b) * (uint256(tba) + 1) + (uint256(tbs) + 1e6) - 1) / (uint256(tbs) + 1e6);
    }

    /// @dev the executor ends every call with no balance, no allowance and no Morpho authorization
    function _assertClean() internal view {
        address[4] memory t = [address(usdc), address(pt1), address(pt2), address(weth)];
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(address(ex)), 0, "executor balance");
            assertEq(IERC20(t[i]).allowance(address(ex), address(morpho)), 0, "allowance to Morpho");
            assertEq(IERC20(t[i]).allowance(address(ex), address(router)), 0, "allowance to router");
        }
        assertFalse(morpho.isAuthorized(user, address(ex)), "authorization left");
    }
}
