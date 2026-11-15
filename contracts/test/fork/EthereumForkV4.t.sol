// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {IMorphoFlashLender} from "../../src/interfaces/IFlashLenders.sol";
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
        ex = new LeverageExecutorV4(IMorphoFlashLender(MORPHO), IAaveV4Giver(GIVER), IAaveV4Taker(TAKER), routers);
        exSentora = new LeverageExecutorV4(
            IMorphoFlashLender(MORPHO), IAaveV4Giver(GIVER_SENTORA), IAaveV4Taker(TAKER_SENTORA), routers
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

    function _guard(uint256 minHf) internal view returns (LeverageExecutorV4.Guard memory) {
        return LeverageExecutorV4.Guard(minHf, block.timestamp + 20 minutes);
    }

    function _permit(LeverageExecutorV4 e, bytes32 typehash, address spoke, uint256 id, uint256 amount)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        ITakerUser taker = ITakerUser(address(e.TAKER()));
        p.amount = amount;
        p.nonce = taker.nonces(user, 0);
        p.deadline = block.timestamp + 20 minutes;
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
        (uint256 supplied, uint256 borrowed, uint256 hf) = ex.openWithPermit(p, permit);
        vm.stopPrank();

        assertApproxEqRel(supplied, 30e18, 0.002e18, "3x collateral");
        assertEq(borrowed, debtAmount);
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserSuppliedAssets(0, user), supplied, 2, "supplied on the spoke");
        assertApproxEqAbs(IAaveV4Spoke(MAIN).getUserTotalDebt(7, user), debtAmount, 2, "debt on the spoke");
        assertGt(hf, 1.2e18);
        assertLt(hf, 1.3e18); // 0.84 x 3 / 2
        assertEq(IAaveV4Taker(TAKER).borrowAllowance(MAIN, 7, user, address(ex)), 0, "borrow allowance renounced");
        _noDust(ex, weth, usdc);

        vm.warp(block.timestamp + 30 days);
        LeverageExecutorV4.CloseParams memory c = _closeAll(ex, MAIN, 0, 7);
        LeverageExecutorV4.Permit memory wPermit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, MAIN, 0, type(uint256).max);
        vm.prank(user);
        LeverageExecutorV4.CloseResult memory r = ex.closeWithPermit(c, wPermit);

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
        ex.open(p);
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
        LeverageExecutorV4.CloseResult memory r = ex.close(c);

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
        (uint256 supplied,, uint256 hf) = ex.openWithPermit(p, permit);
        vm.stopPrank();
        assertApproxEqRel(supplied, 100e18, 0.002e18);
        assertGt(hf, 1.05e18);
        assertLt(hf, 1.08e18); // 0.96 x 10 / 9

        LeverageExecutorV4.CloseParams memory c = _closeAll(ex, LIDO, 0, 1);
        LeverageExecutorV4.Permit memory wPermit = _permit(ex, WITHDRAW_PERMIT_TYPEHASH, LIDO, 0, type(uint256).max);
        vm.prank(user);
        ex.closeWithPermit(c, wPermit);
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
        (uint256 supplied,,) = exSentora.openWithPermit(p, permit);
        vm.stopPrank();
        assertApproxEqRel(supplied, 2 * capital, 0.002e18);
        _noDust(exSentora, kbtc, rlusd);

        // the executor of the other position managers refuses this spoke
        p.guard = _guard(0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.SpokeNotRegistered.selector, BLUECHIP_SENTORA));
        ex.open(p);
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
        ex.openWithPermit(p, permit);

        // collateral enabled but no position manager: the spoke refuses the Giver
        ISpokeUser(MAIN).setUsingAsCollateral(0, true, user);
        vm.expectRevert();
        ex.openWithPermit(p, permit);

        // managers set, no borrow allowance: the Taker refuses
        ISpokeUser(MAIN).setUserPositionManager(GIVER, true);
        ISpokeUser(MAIN).setUserPositionManager(TAKER, true);
        vm.expectRevert();
        ex.open(p);
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
        ex.open(p);
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
        ex.close(c);

        LeverageExecutorV4.OpenParams memory o = _openParams(ex, MAIN, 0, 7, 0, 1000e6);
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorV4.CollateralNotEnabled.selector, 0));
        ex.open(o);
    }
}
