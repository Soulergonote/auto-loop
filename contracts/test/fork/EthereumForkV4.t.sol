// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {IMorpho, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";
import {IAaveV4Spoke, IAaveV4Giver, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {MockAggregatorRouter, IPriceOracle} from "../mocks/MockAggregatorRouter.sol";
import {UsdPrices} from "../morpho/MorphoMocks.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";

interface ISpokeUser {
    function ORACLE() external view returns (address);
    function setUserPositionManager(address positionManager, bool approve) external;
    function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf) external;
    function multicall(bytes[] calldata data) external returns (bytes[] memory);
}

interface ISpokeOracle {
    function getReservePrice(uint256 reserveId) external view returns (uint256);
}

interface ISigned {
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IMorphoUser {
    function nonce(address authorizer) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function position(bytes32 id, address user) external view returns (uint256, uint128, uint128);
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
}

interface ITakerUser {
    function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount) external;
    function nonces(address owner, uint192 key) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice LeverageExecutorV4 against the real Aave v4 on Ethereum: the Main spoke (WETH / USDC), the Lido spoke
/// (wstETH / WETH, collateral factor 96 %) and a spoke of the Sentora hub, which has its own position managers
/// (kBTC / RLUSD). Real spokes, hubs, oracles, position managers and Morpho flash loans; swaps go through a router
/// that trades at each spoke's own oracle prices (the aggregator side is covered by the app's e2e runs).
///   ETH_RPC_URL=... forge test --match-contract EthereumForkV4Test -vv
/// Skipped when ETH_RPC_URL is not set.
contract EthereumForkV4Test is Test {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant GIVER = 0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e;
    address constant TAKER = 0x6c044c0D3801499bCAbfAd458B70880bc518e9F7;
    address constant GIVER_SENTORA = 0x4CF59b43ADC4A183d3f7ED5Ec9c0Aca1ce3f25A4;
    address constant TAKER_SENTORA = 0xa25963b913D69574290aFaC4A8202d43060b826f;

    address constant AAVE_CORE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    address constant MAIN = 0x94e7A5dCbE816e498b89aB752661904E2F56c485; // 0 WETH (collateral), 7 USDC
    address constant LIDO = 0xe1900480ac69f0B296841Cd01cC37546d92F35Cd; // 0 wstETH, 1 WETH
    address constant BLUECHIP_SENTORA = 0xA37e7cdC557f3C7f745FB3F337b6439979662c46; // 3 kBTC, 0 RLUSD

    bytes32 constant BORROW_PERMIT_TYPEHASH = keccak256(
        "BorrowPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant WITHDRAW_PERMIT_TYPEHASH = keccak256(
        "WithdrawPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    LeverageExecutorV4 ex;
    LeverageExecutorV4 exSentora;
    MockAggregatorRouter router;
    UsdPrices prices;
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
        // not the usual "user" key: on mainnet that address carries an EIP-7702 delegation, and the Taker then checks
        // signatures through ERC-1271 instead of ecrecover
        (user, userKey) = makeAddrAndKey("auto-loop v4 fork user");
        assertEq(user.code.length, 0);
        prices = new UsdPrices();
        router = new MockAggregatorRouter(IPriceOracle(address(prices)));
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory pools = new address[](1);
        pools[0] = AAVE_CORE;
        ex = new LeverageExecutorV4(IMorpho(MORPHO), IAaveV4Giver(GIVER), IAaveV4Taker(TAKER), routers, pools);
        exSentora = new LeverageExecutorV4(
            IMorpho(MORPHO), IAaveV4Giver(GIVER_SENTORA), IAaveV4Taker(TAKER_SENTORA), routers, pools
        );
    }

    // ---------------------------------------------------------------------------------------------

    function _token(address spoke, uint256 id) internal view returns (address) {
        return IAaveV4Spoke(spoke).getReserve(id).underlying;
    }

    /// @dev the router trades the pair at the spoke's oracle prices and holds plenty of both tokens
    function _market(address spoke, uint256 c, uint256 d) internal returns (address collateral, address debt) {
        collateral = _token(spoke, c);
        debt = _token(spoke, d);
        ISpokeOracle o = ISpokeOracle(ISpokeUser(spoke).ORACLE());
        prices.set(collateral, o.getReservePrice(c));
        prices.set(debt, o.getReservePrice(d));
        deal(collateral, address(router), 1e30);
        deal(debt, address(router), 1e30);
    }

    /// @dev the once-per-spoke setup the app proposes: both position managers and the collateral flag, one call
    function _setup(LeverageExecutorV4 e, address spoke, uint256 c) internal {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(ISpokeUser.setUserPositionManager, (address(e.GIVER()), true));
        calls[1] = abi.encodeCall(ISpokeUser.setUserPositionManager, (address(e.TAKER()), true));
        calls[2] = abi.encodeCall(ISpokeUser.setUsingAsCollateral, (c, true, user));
        vm.prank(user);
        ISpokeUser(spoke).multicall(calls);
    }

    function _one(LeverageExecutorV4 e, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (SwapExecutorBase.Step[] memory s)
    {
        s = new SwapExecutorBase.Step[](1);
        s[0] = SwapExecutorBase.Step(
            address(router),
            tokenOut,
            abi.encodeCall(router.swap, (tokenIn, tokenOut, amountIn, address(e))),
            router.quote(tokenIn, tokenOut, amountIn) * 999 / 1000
        );
    }

    function _noPermit() internal pure returns (LeverageExecutorV4.Permit memory p) {}

    function _guard(uint256 minHf) internal view returns (LeverageExecutorV4.Guard memory) {
        return LeverageExecutorV4.Guard(minHf, vm.getBlockTimestamp() + 20 minutes);
    }

    function _permit(LeverageExecutorV4 e, bytes32 typehash, address spoke, uint256 id, uint256 amount)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        ITakerUser taker = ITakerUser(address(e.TAKER()));
        p.amount = amount;
        p.nonce = taker.nonces(user, 0);
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                taker.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(typehash, spoke, id, user, address(e), amount, p.nonce, p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    function _openParams(LeverageExecutorV4 e, address spoke, uint256 c, uint256 d, uint256 capital, uint256 debtAmount)
        internal
        view
        returns (LeverageExecutorV4.OpenParams memory p)
    {
        p.spoke = spoke;
        p.collateralId = c;
        p.debtId = d;
        p.capitalToken = _token(spoke, c);
        p.capitalAmount = capital;
        p.capitalSteps = new SwapExecutorBase.Step[](0);
        p.debtAmount = debtAmount;
        p.steps = _one(e, _token(spoke, d), _token(spoke, c), debtAmount);
        p.guard = _guard(1.01e18);
    }

    function _closeAll(LeverageExecutorV4 e, address spoke, uint256 c, uint256 d)
        internal
        view
        returns (LeverageExecutorV4.CloseParams memory p)
    {
        address collateral = _token(spoke, c);
        address debt = _token(spoke, d);
        uint256 owed = IAaveV4Spoke(spoke).getUserTotalDebt(d, user);
        // sell enough collateral to cover the debt with 1 % to spare
        uint256 toSell = router.quote(debt, collateral, owed) * 101 / 100;
        p.spoke = spoke;
        p.collateralId = c;
        p.debtId = d;
        p.repayAmount = type(uint256).max;
        p.collateralToWithdraw = type(uint256).max;
        p.collateralToSell = toSell;
        p.steps = _one(e, collateral, debt, toSell);
        p.guard = _guard(0);
    }

    function _noDust(LeverageExecutorV4 e, address a, address b) internal view {
        assertEq(IERC20(a).balanceOf(address(e)), 0, "collateral left in the executor");
        assertEq(IERC20(b).balanceOf(address(e)), 0, "debt asset left in the executor");
        assertEq(IERC20(a).allowance(address(e), address(e.GIVER())), 0, "allowance left");
        assertEq(IERC20(b).allowance(address(e), address(e.GIVER())), 0, "allowance left");
    }

    // ---------------------------------------------------------------------------------------------

    /// 10 WETH at 3x against USDC on the Main spoke with signed permits, then everything closed.
    function test_fork_v4_main_openAndClose_withPermits() public {
        if (noFork) return;
        (address weth, address usdc) = _market(MAIN, 0, 7);
        _setup(ex, MAIN, 0);
        deal(weth, user, 10e18);
        uint256 debtAmount = router.quote(weth, usdc, 20e18);

        LeverageExecutorV4.OpenParams memory p = _openParams(ex, MAIN, 0, 7, 10e18, debtAmount);
        LeverageExecutorV4.Permit memory permit = _permit(ex, BORROW_PERMIT_TYPEHASH, MAIN, 7, debtAmount);
        vm.startPrank(user);
        IERC20(weth).approve(address(ex), 10e18);
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.open(p, permit);
        vm.stopPrank();

        assertApproxEqRel(supplied, 30e18, 0.002e18, "3x collateral");
        assertEq(borrowed, debtAmount);
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), supplied, 2, "supplied on the spoke");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), debtAmount, 2, "debt on the spoke");
        assertGt(hf, 1.2e18);
        assertLt(hf, 1.3e18); // 0.84 x 3 / 2
        assertEq(IAaveV4Taker(TAKER).borrowAllowance(MAIN, 7, user, address(ex)), 0, "borrow allowance renounced");
        _noDust(ex, weth, usdc);

        vm.warp(vm.getBlockTimestamp() + 30 days);
        LeverageExecutorV4.CloseParams memory c = _closeAll(ex, MAIN, 0, 7);
        LeverageExecutorV4.Permit memory wPermit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, MAIN, 0, type(uint256).max);
        vm.prank(user);
        LeverageExecutorV4.CloseResult memory r = ex.close(c, wPermit);

        assertEq(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), 0, "debt cleared");
        assertEq(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), 0, "collateral out");
        assertEq(r.healthFactor, type(uint256).max);
        assertGt(r.debtRepaid, debtAmount, "interest accrued");
        assertEq(IAaveV4Taker(TAKER).withdrawAllowance(MAIN, 0, user, address(ex)), 0, "withdraw allowance renounced");
        // 10 WETH came back minus a month of borrow cost and two swaps at 0 slippage
        assertApproxEqRel(
            IERC20(weth).balanceOf(user) + router.quote(usdc, weth, IERC20(usdc).balanceOf(user)), 10e18, 0.02e18
        );
        _noDust(ex, weth, usdc);
    }

    /// Allowances given by transactions instead of signatures; a partial close halves the position.
    function test_fork_v4_main_plainAllowances_partialClose() public {
        if (noFork) return;
        (address weth, address usdc) = _market(MAIN, 0, 7);
        _setup(ex, MAIN, 0);
        deal(weth, user, 10e18);
        uint256 debtAmount = router.quote(weth, usdc, 20e18);

        LeverageExecutorV4.OpenParams memory p = _openParams(ex, MAIN, 0, 7, 10e18, debtAmount);
        vm.startPrank(user);
        IERC20(weth).approve(address(ex), 10e18);
        ITakerUser(TAKER).approveBorrow(MAIN, 7, address(ex), debtAmount);
        ex.open(p, _noPermit());
        ITakerUser(TAKER).approveWithdraw(MAIN, 0, address(ex), 10e18);
        vm.stopPrank();

        LeverageExecutorV4.CloseParams memory c;
        c.spoke = MAIN;
        c.collateralId = 0;
        c.debtId = 7;
        c.repayAmount = debtAmount / 2;
        c.collateralToWithdraw = 10e18;
        c.collateralToSell = 10e18;
        c.steps = _one(ex, weth, usdc, 10e18);
        c.guard = _guard(1.2e18);
        vm.prank(user);
        LeverageExecutorV4.CloseResult memory r = ex.close(c, _noPermit());

        assertEq(r.debtRepaid, debtAmount / 2);
        assertEq(r.collateralWithdrawn, 10e18);
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), 20e18, 0.07e18);
        assertApproxEqAbs(r.debtAssetReturned, 0, 30e6, "sold what was repaid, give or take the 0.1 % rounding");
        assertGt(r.healthFactor, 1.6e18);
        _noDust(ex, weth, usdc);
    }

    /// Correlated pair at high leverage: 10 wstETH at 10x against WETH on the Lido spoke.
    function test_fork_v4_lido_highLeverage() public {
        if (noFork) return;
        (address wsteth, address weth) = _market(LIDO, 0, 1);
        _setup(ex, LIDO, 0);
        deal(wsteth, user, 10e18);
        uint256 debtAmount = router.quote(wsteth, weth, 90e18);

        LeverageExecutorV4.OpenParams memory p = _openParams(ex, LIDO, 0, 1, 10e18, debtAmount);
        LeverageExecutorV4.Permit memory permit = _permit(ex, BORROW_PERMIT_TYPEHASH, LIDO, 1, debtAmount);
        vm.startPrank(user);
        IERC20(wsteth).approve(address(ex), 10e18);
        (uint256 supplied,, uint256 hf) = ex.open(p, permit);
        vm.stopPrank();
        assertApproxEqRel(supplied, 100e18, 0.002e18);
        assertGt(hf, 1.05e18);
        assertLt(hf, 1.08e18); // 0.96 x 10 / 9

        LeverageExecutorV4.CloseParams memory c = _closeAll(ex, LIDO, 0, 1);
        LeverageExecutorV4.Permit memory wPermit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, LIDO, 0, type(uint256).max);
        vm.prank(user);
        ex.close(c, wPermit);
        assertEq(IAaveV4Spoke(LIDO).getUserTotalDebt(1, user), 0);
        _noDust(ex, wsteth, weth);
    }

    /// A spoke of the Sentora hub, served by its own position managers: a second executor. 1 kBTC at 2x against RLUSD
    /// (the USDe reserves of the hub's other spokes sit at their supply cap).
    function test_fork_v4_sentoraSpoke() public {
        if (noFork) return;
        (address kbtc, address rlusd) = _market(BLUECHIP_SENTORA, 3, 0);
        _setup(exSentora, BLUECHIP_SENTORA, 3);
        uint256 capital = 10 ** IERC20Metadata(kbtc).decimals();
        deal(kbtc, user, capital);
        uint256 debtAmount = router.quote(kbtc, rlusd, capital);

        LeverageExecutorV4.OpenParams memory p = _openParams(exSentora, BLUECHIP_SENTORA, 3, 0, capital, debtAmount);
        LeverageExecutorV4.Permit memory permit =
            _permit(exSentora, BORROW_PERMIT_TYPEHASH, BLUECHIP_SENTORA, 0, debtAmount);
        vm.startPrank(user);
        IERC20(kbtc).approve(address(exSentora), capital);
        (uint256 supplied,,) = exSentora.open(p, permit);
        vm.stopPrank();
        assertApproxEqRel(supplied, 2 * capital, 0.002e18);
        _noDust(exSentora, kbtc, rlusd);

        // the executor of the other position managers refuses this spoke
        p.guard = _guard(0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, BLUECHIP_SENTORA));
        ex.open(p, _noPermit());
    }

    /// Without the once-per-spoke setup nothing moves, with a readable error where the contract can give one.
    function test_fork_v4_missingSetup_reverts() public {
        if (noFork) return;
        (address weth, address usdc) = _market(MAIN, 0, 7);
        deal(weth, user, 10e18);
        uint256 debtAmount = router.quote(weth, usdc, 20e18);
        LeverageExecutorV4.OpenParams memory p = _openParams(ex, MAIN, 0, 7, 10e18, debtAmount);
        LeverageExecutorV4.Permit memory permit = _permit(ex, BORROW_PERMIT_TYPEHASH, MAIN, 7, debtAmount);

        vm.startPrank(user);
        IERC20(weth).approve(address(ex), 10e18);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, 0));
        ex.open(p, permit);

        // collateral enabled but no position manager: the spoke refuses the Giver
        ISpokeUser(MAIN).setUsingAsCollateral(0, true, user);
        vm.expectRevert();
        ex.open(p, permit);

        // managers set, no borrow allowance: the Taker refuses
        ISpokeUser(MAIN).setUserPositionManager(GIVER, true);
        ISpokeUser(MAIN).setUserPositionManager(TAKER, true);
        vm.expectRevert();
        ex.open(p, _noPermit());
        vm.stopPrank();
    }

    /// Nobody can use the allowances a user gave the executor: it only acts for its caller.
    function test_fork_v4_strangerCannotUseAllowances() public {
        if (noFork) return;
        (address weth, address usdc) = _market(MAIN, 0, 7);
        _setup(ex, MAIN, 0);
        deal(weth, user, 10e18);
        uint256 debtAmount = router.quote(weth, usdc, 20e18);
        LeverageExecutorV4.OpenParams memory p = _openParams(ex, MAIN, 0, 7, 10e18, debtAmount);
        vm.startPrank(user);
        IERC20(weth).approve(address(ex), 10e18);
        ITakerUser(TAKER).approveBorrow(MAIN, 7, address(ex), type(uint256).max);
        ITakerUser(TAKER).approveWithdraw(MAIN, 0, address(ex), type(uint256).max);
        ex.open(p, _noPermit());
        vm.stopPrank();

        address thief = makeAddr("thief");
        LeverageExecutorV4.CloseParams memory c;
        c.spoke = MAIN;
        c.collateralId = 0;
        c.debtId = 7;
        c.collateralToWithdraw = 1e18;
        c.steps = new SwapExecutorBase.Step[](0);
        c.guard = _guard(0);
        vm.prank(thief);
        vm.expectRevert(); // the Taker looks up the thief's own (empty) allowance and position
        ex.close(c, _noPermit());

        LeverageExecutorV4.OpenParams memory o = _openParams(ex, MAIN, 0, 7, 0, 1000e6);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, 0));
        ex.open(o, _noPermit());
    }

    // ---------------------------------------------------------------------------------------------
    // Collateral swap, debt swap and refinance (2026-11-16)
    // ---------------------------------------------------------------------------------------------

    /// @dev 10 WETH at 3x against USDC on the Main spoke, with plain allowances
    function _open3xMain() internal returns (address weth, address usdc) {
        (weth, usdc) = _market(MAIN, 0, 7);
        _setup(ex, MAIN, 0);
        deal(weth, user, 10e18);
        uint256 debtAmount = router.quote(weth, usdc, 20e18);
        LeverageExecutorV4.OpenParams memory p = _openParams(ex, MAIN, 0, 7, 10e18, debtAmount);
        vm.startPrank(user);
        IERC20(weth).approve(address(ex), 10e18);
        ITakerUser(TAKER).approveBorrow(MAIN, 7, address(ex), debtAmount);
        ex.open(p, _noPermit());
        vm.stopPrank();
    }

    function _mainPlace() internal pure returns (LeverageExecutorV4.Place memory pl) {
        pl.venue = LeverageExecutorV4.Venue.AaveV4;
        pl.target = MAIN;
        pl.collateralId = 0;
        pl.debtId = 7;
    }

    function _refi(LeverageExecutorV4.Place memory from, LeverageExecutorV4.Place memory to)
        internal
        view
        returns (LeverageExecutorV4.RefinanceParams memory p)
    {
        p.from = from;
        p.to = to;
        p.debtAmount = type(uint256).max;
        p.collateralAmount = type(uint256).max;
        p.guard = _guard(1.05e18);
    }

    function _eip2612(address token, uint256 value, bytes32 typehash)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        p.amount = value;
        // not block.timestamp: through the IR pipeline it may keep its value from before a vm.warp
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 structHash = typehash
            == keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)")
            ? keccak256(abi.encode(typehash, address(ex), value, ISigned(token).nonces(user), p.deadline))
            : keccak256(abi.encode(typehash, user, address(ex), value, ISigned(token).nonces(user), p.deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userKey, keccak256(abi.encodePacked("\x19\x01", ISigned(token).DOMAIN_SEPARATOR(), structHash)));
        p.signature = abi.encodePacked(r, s, v);
    }

    function _morphoSig(bool grant, uint256 nonce, uint256 deadline) internal view returns (MorphoSignature memory s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
                ),
                user,
                address(ex),
                grant,
                nonce,
                deadline
            )
        );
        (s.v, s.r, s.s) = vm.sign(
            userKey, keccak256(abi.encodePacked("\x19\x01", IMorphoUser(MORPHO).DOMAIN_SEPARATOR(), structHash))
        );
    }

    function _morphoAuth() internal view returns (LeverageExecutorV4.AuthSigs memory a) {
        a.nonce = IMorphoUser(MORPHO).nonce(user);
        a.deadline = vm.getBlockTimestamp() + 20 minutes;
        a.grant = _morphoSig(true, a.nonce, a.deadline);
        a.revoke = _morphoSig(false, a.nonce + 1, a.deadline);
    }

    /// The whole WETH collateral of a Main spoke loop becomes wstETH, the USDC debt untouched.
    function test_fork_v4_swapCollateral_wethToWstEth() public {
        if (noFork) return;
        (address weth, address usdc) = _open3xMain();
        (address wsteth,) = _market(MAIN, 1, 7);
        vm.prank(user);
        ISpokeUser(MAIN).setUsingAsCollateral(1, true, user);
        uint256 debtBefore = IAaveV4Spoke(MAIN).getUserTotalDebt(7, user);
        uint256 supplied = IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user);

        LeverageExecutorV4.SwapCollateralParams memory p;
        p.spoke = MAIN;
        p.fromId = 0;
        p.toId = 1;
        p.fromAmount = type(uint256).max;
        p.steps = _one(ex, weth, wsteth, supplied);
        p.toAmount = p.steps[0].minOut;
        p.guard = _guard(1.1e18);
        LeverageExecutorV4.Permit memory permit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, MAIN, 0, type(uint256).max);
        vm.prank(user);
        LeverageExecutorV4.SwapCollateralResult memory r = ex.swapCollateral(p, permit);

        assertEq(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), 0, "WETH left");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserSuppliedAssets(1, user), r.supplied, 2);
        assertGe(r.supplied, p.toAmount);
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), debtBefore, 2, "debt untouched");
        assertGt(r.healthFactor, 1.1e18);
        assertEq(IAaveV4Taker(TAKER).withdrawAllowance(MAIN, 0, user, address(ex)), 0, "allowance renounced");
        _noDust(ex, weth, wsteth);
        _noDust(ex, usdc, wsteth);
    }

    /// The USDC debt of a Main spoke loop becomes USDT (flash loan of USDT from Morpho), collateral untouched.
    function test_fork_v4_swapDebt_usdcToUsdt() public {
        if (noFork) return;
        (address weth, address usdc) = _open3xMain();
        (, address usdt) = _market(MAIN, 0, 8);
        prices.set(usdc, ISpokeOracle(ISpokeUser(MAIN).ORACLE()).getReservePrice(7));
        uint256 owed = IAaveV4Spoke(MAIN).getUserTotalDebt(7, user);
        // enough USDT that the router's minimum covers the whole USDC debt
        uint256 newDebt = router.quote(usdc, usdt, owed) * 1005 / 1000;

        LeverageExecutorV4.SwapDebtParams memory p;
        p.spoke = MAIN;
        p.fromId = 7;
        p.toId = 8;
        p.newDebtAmount = newDebt;
        p.minRepaid = type(uint256).max;
        p.steps = _one(ex, usdt, usdc, newDebt);
        p.guard = _guard(1.1e18);
        LeverageExecutorV4.Permit memory permit = _permit(ex, BORROW_PERMIT_TYPEHASH, MAIN, 8, newDebt);
        vm.prank(user);
        LeverageExecutorV4.SwapDebtResult memory r = ex.swapDebt(p, permit);

        assertEq(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), 0, "USDC debt left");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(8, user), newDebt, 2);
        assertEq(r.repaid, owed);
        assertEq(IERC20(usdc).balanceOf(user), r.returned, "leftover USDC back to the user");
        assertGt(r.healthFactor, 1.1e18);
        assertEq(IAaveV4Taker(TAKER).borrowAllowance(MAIN, 8, user, address(ex)), 0, "allowance renounced");
        _noDust(ex, weth, usdt);
        _noDust(ex, usdc, usdt);
    }

    /// Main spoke -> Aave v3 Core (Taker permit + credit delegation signature), then back (aToken permit + Taker
    /// permit).
    function test_fork_v4_refinance_mainToAaveCoreAndBack() public {
        if (noFork) return;
        (address weth, address usdc) = _open3xMain();
        IAaveV3Pool core = IAaveV3Pool(AAVE_CORE);
        address aWeth = core.getReserveData(weth).aTokenAddress;
        address vUsdc = core.getReserveData(usdc).variableDebtTokenAddress;
        uint256 debt = IAaveV4Spoke(MAIN).getUserTotalDebt(7, user);
        uint256 coll = IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user);
        LeverageExecutorV4.Place memory aave;
        aave.venue = LeverageExecutorV4.Venue.AaveV3;
        aave.target = AAVE_CORE;

        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, MAIN, 0, coll);
        a.enter = _eip2612(
            vUsdc, debt, keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)")
        );
        vm.prank(user);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_refi(_mainPlace(), aave), a);
        assertEq(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), 0);
        assertEq(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), 0);
        assertApproxEqAbs(IERC20(vUsdc).balanceOf(user), debt, 2);
        assertApproxEqAbs(IERC20(aWeth).balanceOf(user), coll, 2);
        assertEq(r.debtMoved, debt);
        assertGt(r.healthFactor, 1.1e18);
        _noDust(ex, weth, usdc);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        debt = IERC20(vUsdc).balanceOf(user);
        a.exit = _eip2612(
            aWeth,
            IERC20(aWeth).balanceOf(user) + 1e9,
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
        );
        a.enter = _permit(ex, BORROW_PERMIT_TYPEHASH, MAIN, 7, debt);
        vm.prank(user);
        r = ex.refinance(_refi(aave, _mainPlace()), a);
        assertEq(IERC20(vUsdc).balanceOf(user), 0, "Aave debt left");
        assertEq(IERC20(aWeth).balanceOf(user), 0, "Aave collateral left");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), debt, 2);
        assertGt(r.healthFactor, 1.1e18);
        assertEq(IAaveV4Taker(TAKER).borrowAllowance(MAIN, 7, user, address(ex)), 0);
        _noDust(ex, weth, usdc);
        assertEq(IERC20(aWeth).balanceOf(address(ex)), 0, "aTokens left");
    }

    /// Main spoke -> a Morpho Blue WETH / USDC market (LLTV 86 %) and back, with Morpho authorization signatures.
    function test_fork_v4_refinance_mainToMorphoAndBack() public {
        if (noFork) return;
        (address weth, address usdc) = _open3xMain();
        LeverageExecutorV4.Place memory morpho;
        morpho.venue = LeverageExecutorV4.Venue.Morpho;
        morpho.market = MarketParams(
            usdc, weth, 0x0F948CBa8231Db7898ef36A4212581Ad7b1B4580, 0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC, 0.86e18
        );
        bytes32 id = keccak256(abi.encode(morpho.market));
        assertEq(id, 0x94b823e6bd8ea533b4e33fbc307faea0b307301bc48763acc4d4aa4def7636cd);
        uint256 coll = IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user);

        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, MAIN, 0, coll);
        a.morpho = _morphoAuth();
        vm.prank(user);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_refi(_mainPlace(), morpho), a);
        (, uint128 shares, uint128 mColl) = IMorphoUser(MORPHO).position(id, user);
        assertEq(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), 0);
        assertEq(mColl, coll);
        assertGt(shares, 0);
        assertGt(r.healthFactor, 1.1e18);
        assertFalse(IMorphoUser(MORPHO).isAuthorized(user, address(ex)));
        _noDust(ex, weth, usdc);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        a.exit = _noPermit();
        a.enter = _permit(ex, BORROW_PERMIT_TYPEHASH, MAIN, 7, r.debtMoved * 101 / 100);
        a.morpho = _morphoAuth();
        vm.prank(user);
        r = ex.refinance(_refi(morpho, _mainPlace()), a);
        (, shares, mColl) = IMorphoUser(MORPHO).position(id, user);
        assertEq(shares, 0, "Morpho debt left");
        assertEq(mColl, 0, "Morpho collateral left");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), coll, 2);
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), r.debtMoved, 2);
        assertFalse(IMorphoUser(MORPHO).isAuthorized(user, address(ex)));
        assertEq(IAaveV4Taker(TAKER).borrowAllowance(MAIN, 7, user, address(ex)), 0);
        _noDust(ex, weth, usdc);
    }
}
