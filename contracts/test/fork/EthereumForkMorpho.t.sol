// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {IMorpho, IMorphoOracle, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {UsdPrices} from "../morpho/MorphoMocks.sol";
import {MORPHO_BLUE_BYTECODE} from "../morpho/MorphoBlueBytecode.sol";

interface IMorphoDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice LeverageExecutorMorpho against the real Morpho Blue on Ethereum and three of its largest Pendle PT markets
/// (real oracles, interest rate model and liquidity). Swaps go through a router that trades at the markets' own
/// oracle prices (the aggregator side is covered by the v2 fork tests and the app's e2e runs).
///   ETH_RPC_URL=... forge test --match-contract EthereumForkMorphoTest -vv
/// Skipped when ETH_RPC_URL is not set.
contract EthereumForkMorphoTest is Test {
    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    bytes32 constant AUTHORIZATION_TYPEHASH =
        keccak256("Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)");
    // PT-reUSD-10DEC2026 / USDC, LLTV 91.5 %
    bytes32 constant RE_USD = 0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64;
    // PT-USD3-17DEC2026 / USDC, LLTV 86 %, two markets with different oracles
    bytes32 constant USD3_A = 0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89;
    bytes32 constant USD3_B = 0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837;

    LeverageExecutorMorpho ex;
    MockAggregatorRouter router;
    UsdPrices prices;
    MarketParams reUsd;
    MarketParams usd3a;
    MarketParams usd3b;
    address user;
    uint256 userKey;
    bool noFork;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noFork = true;
            return;
        }
        vm.createSelectFork(rpc);
        (user, userKey) = makeAddrAndKey("user");
        reUsd = _params(RE_USD);
        usd3a = _params(USD3_A);
        usd3b = _params(USD3_B);

        prices = new UsdPrices();
        prices.set(reUsd.loanToken, 1e8);
        prices.set(reUsd.collateralToken, _usdPrice(reUsd));
        prices.set(usd3a.collateralToken, _usdPrice(usd3a));
        router = new MockAggregatorRouter(IPriceOracle(address(prices)));
        deal(reUsd.loanToken, address(router), 10_000_000e6);
        deal(reUsd.collateralToken, address(router), 10_000_000e18);
        deal(usd3a.collateralToken, address(router), 10_000_000e18);

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        ex = new LeverageExecutorMorpho(MORPHO, routers);
        deal(reUsd.loanToken, user, 10_000e6);
    }

    function _params(bytes32 id) internal view returns (MarketParams memory m) {
        (m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv) = MORPHO.idToMarketParams(id);
        assertEq(keccak256(abi.encode(m)), id, "market id");
    }

    /// @dev collateral price in USD (8 decimals) from the market's own oracle, the loan token being USDC = 1 $
    function _usdPrice(MarketParams memory m) internal view returns (uint256) {
        uint256 p = IMorphoOracle(m.oracle).price();
        return p * 10 ** IERC20Metadata(m.collateralToken).decimals() / 10 ** IERC20Metadata(m.loanToken).decimals()
            * 1e8 / 1e36;
    }

    function _sign(Authorization memory a) internal view returns (MorphoSignature memory s) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", IMorphoDomain(address(MORPHO)).DOMAIN_SEPARATOR(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))
            )
        );
        (s.v, s.r, s.s) = vm.sign(userKey, digest);
    }

    function _auth() internal view returns (LeverageExecutorMorpho.AuthSigs memory a) {
        a.nonce = MORPHO.nonce(user);
        a.deadline = block.timestamp + 20 minutes;
        a.grant = _sign(Authorization(user, address(ex), true, a.nonce, a.deadline));
        a.revoke = _sign(Authorization(user, address(ex), false, a.nonce + 1, a.deadline));
    }

    function _one(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (LeverageExecutorMorpho.Step[] memory s)
    {
        s = new LeverageExecutorMorpho.Step[](1);
        s[0] = LeverageExecutorMorpho.Step(
            address(router),
            tokenOut,
            abi.encodeCall(router.swap, (tokenIn, tokenOut, amountIn, address(ex))),
            router.quote(tokenIn, tokenOut, amountIn) * 999 / 1000
        );
    }

    function _guard(uint256 minHf) internal view returns (LeverageExecutorMorpho.Guard memory) {
        return LeverageExecutorMorpho.Guard(minHf, block.timestamp + 20 minutes);
    }

    /// @dev 10 000 USDC of capital at `lev` x: (lev - 1) x 10 000 USDC borrowed, everything sold for the PT
    function _open(MarketParams memory m, uint256 lev) internal {
        LeverageExecutorMorpho.OpenParams memory p;
        p.market = m;
        p.capitalToken = m.loanToken;
        p.capitalAmount = 10_000e6;
        p.capitalSteps = new LeverageExecutorMorpho.Step[](0);
        p.debtAmount = (lev - 1) * 10_000e6;
        p.steps = _one(m.loanToken, m.collateralToken, lev * 10_000e6);
        p.guard = _guard(1e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        vm.startPrank(user);
        IERC20(m.loanToken).approve(address(ex), p.capitalAmount);
        ex.openWithAuth(p, a);
        vm.stopPrank();
    }

    function _debt(MarketParams memory m) internal returns (uint256) {
        MORPHO.accrueInterest(m);
        bytes32 id = keccak256(abi.encode(m));
        (, uint128 b,) = MORPHO.position(id, user);
        (,, uint128 tba, uint128 tbs,,) = MORPHO.market(id);
        return (uint256(b) * (uint256(tba) + 1) + (uint256(tbs) + 1e6) - 1) / (uint256(tbs) + 1e6);
    }

    function _collateral(MarketParams memory m) internal view returns (uint256 c) {
        (,, c) = MORPHO.position(keccak256(abi.encode(m)), user);
    }

    function _assertClean() internal view {
        address[3] memory t = [reUsd.loanToken, reUsd.collateralToken, usd3a.collateralToken];
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(address(ex)), 0, "executor balance");
            assertEq(IERC20(t[i]).allowance(address(ex), address(MORPHO)), 0, "allowance");
        }
        assertFalse(MORPHO.isAuthorized(user, address(ex)), "authorization left");
    }

    function test_local_bytecode_is_the_deployed_morpho() public {
        if (noFork) return;
        bytes memory code = abi.encodePacked(MORPHO_BLUE_BYTECODE, abi.encode(address(this)));
        address local;
        assembly ("memory-safe") {
            local := create(0, add(code, 32), mload(code))
        }
        bytes memory a = local.code;
        bytes memory b = address(MORPHO).code;
        // the local build has no metadata hash: its CBOR tail is 12 bytes, the deployed one (IPFS hash) 53 bytes
        assertEq(a.length + 41, b.length, "runtime length");
        // the code before the tails may only differ in the two inlined copies of the DOMAIN_SEPARATOR immutable
        // (it hashes the chain id and the contract's own address)
        uint256 diff;
        for (uint256 i; i < a.length - 12; ++i) {
            if (a[i] != b[i]) ++diff;
        }
        assertLe(diff, 64, "runtime differs beyond the domain separator");
    }

    function test_open_and_close_reUSD_5x() public {
        if (noFork) return;
        _open(reUsd, 5);
        uint256 debt = _debt(reUsd);
        assertApproxEqAbs(debt, 40_000e6, 1, "debt (rounded up by Morpho)");
        // 50 000 $ of PT x 91.5 % / 40 000 $, minus the 0.1 % rounding of the price
        assertApproxEqRel(ex.healthFactor(reUsd, user), 1.14375e18, 2e15);
        _assertClean();

        vm.warp(block.timestamp + 7 days);
        debt = _debt(reUsd);
        assertGt(debt, 40_000e6, "interest accrued");
        uint256 coll = _collateral(reUsd);
        uint256 sell = router.quote(reUsd.loanToken, reUsd.collateralToken, debt) * 1005 / 1000;
        LeverageExecutorMorpho.CloseParams memory c;
        c.market = reUsd;
        c.repayAmount = type(uint256).max;
        c.collateralToWithdraw = type(uint256).max;
        c.collateralToSell = sell;
        c.steps = _one(reUsd.collateralToken, reUsd.loanToken, sell);
        c.guard = _guard(0);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        vm.prank(user);
        LeverageExecutorMorpho.CloseResult memory r = ex.closeWithAuth(c, a);
        assertEq(r.debtRepaid, debt);
        assertEq(r.collateralWithdrawn, coll);
        assertEq(r.collateralReturned, coll - sell);
        assertEq(_collateral(reUsd), 0);
        assertEq(_debt(reUsd), 0);
        assertEq(IERC20(reUsd.collateralToken).balanceOf(user), coll - sell);
        _assertClean();
    }

    function test_roll_reUSD_to_USD3() public {
        if (noFork) return;
        _open(reUsd, 4);
        uint256 debt = _debt(reUsd);
        uint256 coll = _collateral(reUsd);
        LeverageExecutorMorpho.RollParams memory p;
        p.from = reUsd;
        p.to = usd3a;
        p.repayAmount = type(uint256).max;
        p.collateralToMove = type(uint256).max;
        p.steps = _one(reUsd.collateralToken, usd3a.collateralToken, coll);
        p.guard = _guard(1.05e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        vm.prank(user);
        LeverageExecutorMorpho.RollResult memory r = ex.rollWithAuth(p, a);
        assertEq(_collateral(reUsd), 0);
        assertEq(_debt(reUsd), 0);
        assertEq(r.collateralWithdrawn, coll);
        assertEq(_collateral(usd3a), r.collateralSupplied);
        assertApproxEqAbs(_debt(usd3a), debt, 1);
        // 40 000 $ x 86 % / 30 000 $
        assertApproxEqRel(r.healthFactor, 1.14667e18, 3e15);
        _assertClean();
    }

    function test_roll_USD3_between_markets() public {
        if (noFork) return;
        _open(usd3a, 3);
        uint256 debt = _debt(usd3a);
        uint256 coll = _collateral(usd3a);
        LeverageExecutorMorpho.RollParams memory p;
        p.from = usd3a;
        p.to = usd3b;
        p.repayAmount = type(uint256).max;
        p.collateralToMove = type(uint256).max;
        p.steps = new LeverageExecutorMorpho.Step[](0);
        p.guard = _guard(1.05e18);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        vm.prank(user);
        ex.rollWithAuth(p, a);
        assertEq(_collateral(usd3a), 0);
        assertEq(_collateral(usd3b), coll);
        assertApproxEqAbs(_debt(usd3b), debt, 1);
        _assertClean();
    }
}
