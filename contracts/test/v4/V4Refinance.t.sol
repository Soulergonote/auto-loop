// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712SigUtils} from "aave-v3-origin/tests/utils/EIP712SigUtils.sol";

import {V2Base, IDebtToken} from "../v2/V2Base.sol";
import {LeverageExecutorV4} from "../../src/LeverageExecutorV4.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorpho, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {IAaveV4Giver, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {MORPHO_BLUE_BYTECODE} from "../morpho/MorphoBlueBytecode.sol";
import {MockMorphoOracle, FixedRateIrm, UsdPrices} from "../morpho/MorphoMocks.sol";
import {MockSpokeV4, MockGiver, MockTaker} from "./V4Mocks.sol";

interface IMorphoAdmin {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function createMarket(MarketParams memory marketParams) external;
    function supply(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
}

interface ISigned {
    function nonces(address who) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Refinance between an Aave v4 spoke (the local stand-ins of V4Mocks.sol, WETH $1800 with a collateral
/// factor of 84 % against USDX), a real local Aave v3.6 (V2Base) and the real Morpho Blue bytecode (a WETH / USDX
/// market, LLTV 86 %), Morpho also lending the flash loans. Signatures as the app produces them.
contract V4RefinanceTest is V2Base {
    bytes32 constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant C = 0; // WETH reserve of the spoke
    uint256 constant D = 1; // USDX reserve of the spoke

    IMorpho blue;
    MarketParams mkt;
    MockSpokeV4 spoke;
    MockGiver giver;
    MockTaker taker;
    LeverageExecutorV4 ex;
    address owner;
    uint256 key;

    function setUp() public override {
        super.setUp();
        (owner, key) = makeAddrAndKey("v4-refi-owner");

        bytes memory code = abi.encodePacked(MORPHO_BLUE_BYTECODE, abi.encode(address(this)));
        address m;
        assembly ("memory-safe") {
            m := create(0, add(code, 32), mload(code))
        }
        require(m != address(0), "morpho deploy");
        blue = IMorpho(m);
        FixedRateIrm irm = new FixedRateIrm(1_585_489_599);
        IMorphoAdmin(m).enableIrm(address(irm));
        IMorphoAdmin(m).enableLltv(0.86e18);
        mkt = MarketParams(USDX, WETH, address(new MockMorphoOracle(1800e24)), address(irm), 0.86e18);
        IMorphoAdmin(m).createMarket(mkt);
        deal(USDX, carol, 5_000_000e6);
        vm.startPrank(carol);
        IERC20(USDX).approve(m, type(uint256).max);
        IMorphoAdmin(m).supply(mkt, 5_000_000e6, 0, carol, "");
        vm.stopPrank();

        UsdPrices prices = new UsdPrices();
        prices.set(WETH, 1800e8);
        prices.set(USDX, 1e8);
        spoke = new MockSpokeV4(prices);
        spoke.addReserve(WETH, 8400);
        spoke.addReserve(USDX, 0);
        giver = new MockGiver();
        taker = new MockTaker();
        giver.registerSpoke(address(spoke), true);
        taker.registerSpoke(address(spoke), true);
        deal(USDX, address(spoke), 5_000_000e6);

        ex = _deployV4(address(router));
        vm.label(address(ex), "v4-executor");

        deal(WETH, owner, 10e18);
        vm.startPrank(owner);
        spoke.setUserPositionManager(address(giver), true);
        spoke.setUserPositionManager(address(taker), true);
        spoke.setUsingAsCollateral(C, true, owner);
        vm.stopPrank();
    }

    function _deployV4(address r) internal returns (LeverageExecutorV4) {
        address[] memory routers = new address[](1);
        routers[0] = r;
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        return new LeverageExecutorV4(blue, IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers, pools);
    }

    // ---------------------------------------------------------------------------------------------
    // Positions and signatures
    // ---------------------------------------------------------------------------------------------

    function _onV4(uint256 coll, uint256 debt) internal {
        vm.startPrank(owner);
        IERC20(WETH).approve(address(spoke), coll);
        spoke.supply(C, coll, owner);
        spoke.borrow(D, debt, owner);
        vm.stopPrank();
    }

    function _onAave(uint256 coll, uint256 debt) internal {
        vm.startPrank(owner);
        IERC20(WETH).approve(address(pool), coll);
        contracts.poolProxy.supply(WETH, coll, owner, 0);
        contracts.poolProxy.borrow(USDX, debt, 2, 0, owner);
        vm.stopPrank();
    }

    function _onMorpho(uint256 coll, uint256 debt) internal {
        vm.startPrank(owner);
        IERC20(WETH).approve(address(blue), coll);
        blue.supplyCollateral(mkt, coll, owner, "");
        blue.borrow(mkt, debt, 0, owner, owner);
        vm.stopPrank();
    }

    function _morpho() internal view returns (uint256 debt, uint256 coll) {
        bytes32 id = keccak256(abi.encode(mkt));
        (, uint128 b, uint128 c) = blue.position(id, owner);
        (,, uint128 tba, uint128 tbs,,) = blue.market(id);
        debt = (uint256(b) * (uint256(tba) + 1) + (uint256(tbs) + 1e6) - 1) / (uint256(tbs) + 1e6);
        coll = c;
    }

    function _v4() internal view returns (LeverageExecutorV4.Place memory pl) {
        pl.venue = LeverageExecutorV4.Venue.AaveV4;
        pl.target = address(spoke);
        pl.collateralId = C;
        pl.debtId = D;
    }

    function _aave() internal view returns (LeverageExecutorV4.Place memory pl) {
        pl.venue = LeverageExecutorV4.Venue.AaveV3;
        pl.target = address(pool);
    }

    function _morphoPlace() internal view returns (LeverageExecutorV4.Place memory pl) {
        pl.venue = LeverageExecutorV4.Venue.Morpho;
        pl.market = mkt;
    }

    function _params(
        LeverageExecutorV4.Place memory from,
        LeverageExecutorV4.Place memory to,
        uint256 debt,
        uint256 coll
    ) internal view returns (LeverageExecutorV4.RefinanceParams memory p) {
        p.from = from;
        p.to = to;
        p.debtAmount = debt;
        p.collateralAmount = coll;
        p.guard = LeverageExecutorV4.Guard(1.05e18, vm.getBlockTimestamp() + 20 minutes);
    }

    function _takerPermit(bytes32 typehash, uint256 id, uint256 amount, uint256 nonceOffset)
        internal
        view
        returns (LeverageExecutorV4.Permit memory p)
    {
        p.amount = amount;
        p.nonce = taker.nonces(owner, 0) + nonceOffset;
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                taker.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(typehash, address(spoke), id, owner, address(ex), amount, p.nonce, p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    function _aTokenPermit(uint256 value) internal view returns (LeverageExecutorV4.Permit memory p) {
        p.amount = value;
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(ex), value, ISigned(aWETH).nonces(owner), p.deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", ISigned(aWETH).DOMAIN_SEPARATOR(), structHash)));
        p.signature = abi.encodePacked(r, s, v);
    }

    function _delegation(uint256 value) internal view returns (LeverageExecutorV4.Permit memory p) {
        p.amount = value;
        p.deadline = vm.getBlockTimestamp() + 20 minutes;
        bytes32 digest = EIP712SigUtils.getCreditDelegationTypedDataHash(
            EIP712SigUtils.CreditDelegation({
                delegatee: address(ex), value: value, nonce: ISigned(vUSDX).nonces(owner), deadline: p.deadline
            }),
            bytes(IDebtToken(vUSDX).name()),
            bytes("1"),
            vUSDX
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    function _signAuth(Authorization memory a) internal view returns (MorphoSignature memory s) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IMorphoAdmin(address(blue)).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))
            )
        );
        (s.v, s.r, s.s) = vm.sign(key, digest);
    }

    function _morphoAuth() internal view returns (LeverageExecutorV4.AuthSigs memory a) {
        a.nonce = blue.nonce(owner);
        a.deadline = vm.getBlockTimestamp() + 20 minutes;
        a.grant = _signAuth(Authorization(owner, address(ex), true, a.nonce, a.deadline));
        a.revoke = _signAuth(Authorization(owner, address(ex), false, a.nonce + 1, a.deadline));
    }

    function _noAuth() internal pure returns (LeverageExecutorV4.RefinanceAuth memory a) {}

    function _assertRefiClean() internal view {
        address[3] memory t = [WETH, USDX, aWETH];
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(address(ex)), 0, "executor balance");
            assertEq(IERC20(t[i]).allowance(address(ex), address(blue)), 0, "allowance to Morpho");
            assertEq(IERC20(t[i]).allowance(address(ex), address(pool)), 0, "allowance to Aave");
            assertEq(IERC20(t[i]).allowance(address(ex), address(giver)), 0, "allowance to the Giver");
        }
        assertFalse(blue.isAuthorized(owner, address(ex)), "Morpho authorization left");
        assertEq(taker.withdrawAllowance(address(spoke), C, owner, address(ex)), 0, "withdraw allowance left");
        assertEq(taker.borrowAllowance(address(spoke), D, owner, address(ex)), 0, "borrow allowance left");
        assertEq(IDebtToken(vUSDX).borrowAllowance(owner, address(ex)), 0, "credit delegation left");
    }

    function _aaveHf() internal view returns (uint256 hf) {
        (,,,,, hf) = pool.getUserAccountData(owner);
    }

    // ---------------------------------------------------------------------------------------------
    // Aave v4 <-> Aave v3
    // ---------------------------------------------------------------------------------------------

    function test_v4ToAave_everything_withSignatures() public {
        _onV4(10e18, 12_000e6);
        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _takerPermit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, 10e18, 0);
        a.enter = _delegation(12_000e6);
        vm.prank(owner);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_params(_v4(), _aave(), MAX, MAX), a);

        assertEq(spoke.supplied(owner, C), 0, "v4 collateral left");
        assertEq(spoke.debt(owner, D), 0, "v4 debt left");
        assertApproxEqAbs(IERC20(aWETH).balanceOf(owner), 10e18, 1);
        assertApproxEqAbs(IERC20(vUSDX).balanceOf(owner), 12_000e6, 1);
        assertEq(r.debtMoved, 12_000e6);
        assertEq(r.collateralMoved, 10e18);
        assertEq(r.healthFactor, _aaveHf());
        _assertRefiClean();
    }

    function test_aaveToV4_everything_withSignatures() public {
        _onAave(10e18, 12_000e6);
        vm.warp(vm.getBlockTimestamp() + 30 days); // interest on the Aave side
        uint256 debt = IERC20(vUSDX).balanceOf(owner);
        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _aTokenPermit(IERC20(aWETH).balanceOf(owner));
        a.enter = _takerPermit(taker.BORROW_PERMIT_TYPEHASH(), D, debt, 0);
        vm.prank(owner);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_params(_aave(), _v4(), MAX, MAX), a);

        assertEq(IERC20(vUSDX).balanceOf(owner), 0, "Aave debt left");
        assertEq(IERC20(aWETH).balanceOf(owner), 0, "Aave collateral left");
        assertEq(spoke.debt(owner, D), debt);
        assertEq(spoke.supplied(owner, C), r.collateralMoved);
        assertGe(r.collateralMoved, 10e18);
        // 10 x 1800 x 0.84 / 12 000 (a little more collateral after 30 days of supply interest)
        assertApproxEqRel(r.healthFactor, 1.26e18, 0.01e18);
        _assertRefiClean();
    }

    function test_aaveToV4_part_plainAllowances() public {
        _onAave(10e18, 12_000e6);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), 5e18);
        taker.approveBorrow(address(spoke), D, address(ex), 6_000e6);
        ex.refinance(_params(_aave(), _v4(), 6_000e6, 5e18), _noAuth());
        vm.stopPrank();
        assertApproxEqAbs(IERC20(vUSDX).balanceOf(owner), 6_000e6, 1);
        assertApproxEqAbs(IERC20(aWETH).balanceOf(owner), 5e18, 1);
        assertEq(spoke.debt(owner, D), 6_000e6);
        assertApproxEqAbs(spoke.supplied(owner, C), 5e18, 1);
        _assertRefiClean();
    }

    // ---------------------------------------------------------------------------------------------
    // Aave v4 <-> Morpho
    // ---------------------------------------------------------------------------------------------

    function test_v4ToMorpho_everything_withSignatures() public {
        _onV4(10e18, 12_000e6);
        LeverageExecutorV4.RefinanceAuth memory a;
        a.exit = _takerPermit(taker.WITHDRAW_PERMIT_TYPEHASH(), C, 10e18, 0);
        a.morpho = _morphoAuth();
        vm.prank(owner);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_params(_v4(), _morphoPlace(), MAX, MAX), a);

        (uint256 debt, uint256 coll) = _morpho();
        assertEq(spoke.supplied(owner, C), 0);
        assertEq(spoke.debt(owner, D), 0);
        assertEq(coll, 10e18);
        assertApproxEqAbs(debt, 12_000e6, 1);
        // 10 x 1800 x 0.86 / 12 000
        assertApproxEqRel(r.healthFactor, 1.29e18, 0.001e18);
        _assertRefiClean();
    }

    function test_morphoToV4_everything_withSignatures() public {
        _onMorpho(10e18, 12_000e6);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        blue.accrueInterest(mkt);
        (uint256 debt,) = _morpho();
        LeverageExecutorV4.RefinanceAuth memory a;
        a.enter = _takerPermit(taker.BORROW_PERMIT_TYPEHASH(), D, debt, 0);
        a.morpho = _morphoAuth();
        vm.prank(owner);
        LeverageExecutorV4.RefinanceResult memory r = ex.refinance(_params(_morphoPlace(), _v4(), MAX, MAX), a);

        (uint256 debtLeft, uint256 collLeft) = _morpho();
        assertEq(debtLeft, 0, "Morpho debt left (repaid by shares)");
        assertEq(collLeft, 0);
        assertEq(spoke.supplied(owner, C), 10e18);
        assertEq(spoke.debt(owner, D), debt);
        assertEq(r.debtMoved, debt);
        _assertRefiClean();
    }

    function test_v4ToMorpho_part_plainAllowances() public {
        _onV4(10e18, 12_000e6);
        vm.startPrank(owner);
        taker.approveWithdraw(address(spoke), C, address(ex), 5e18);
        IMorphoAdmin(address(blue)).setAuthorization(address(ex), true);
        ex.refinance(_params(_v4(), _morphoPlace(), 6_000e6, 5e18), _noAuth());
        IMorphoAdmin(address(blue)).setAuthorization(address(ex), false);
        vm.stopPrank();
        (uint256 debt, uint256 coll) = _morpho();
        assertEq(spoke.supplied(owner, C), 5e18);
        assertEq(spoke.debt(owner, D), 6_000e6);
        assertEq(coll, 5e18);
        assertApproxEqAbs(debt, 6_000e6, 1);
        _assertRefiClean();
    }

    // ---------------------------------------------------------------------------------------------
    // Guards and security
    // ---------------------------------------------------------------------------------------------

    function test_morphoAuthorization_mustNotOutliveTheCall() public {
        _onV4(10e18, 12_000e6);
        vm.startPrank(owner);
        taker.approveWithdraw(address(spoke), C, address(ex), 10e18);
        IMorphoAdmin(address(blue)).setAuthorization(address(ex), true);
        // signatures that do not apply (wrong nonce): the authorization given by transaction would stay
        LeverageExecutorV4.RefinanceAuth memory a;
        a.morpho = _morphoAuth();
        a.morpho.nonce += 5;
        vm.expectRevert(LeverageExecutorV4.AuthorizationNotRevoked.selector);
        ex.refinance(_params(_v4(), _morphoPlace(), MAX, MAX), a);
        vm.stopPrank();
    }

    function test_guard_onTheTarget() public {
        _onV4(10e18, 12_000e6);
        vm.startPrank(owner);
        taker.approveWithdraw(address(spoke), C, address(ex), 10e18);
        IMorphoAdmin(address(blue)).setAuthorization(address(ex), true);
        LeverageExecutorV4.RefinanceParams memory p = _params(_v4(), _morphoPlace(), MAX, MAX);
        p.guard.minHealthFactor = 1.3e18;
        vm.expectRevert();
        ex.refinance(p, _noAuth());
        // Morpho itself refuses a position above its LLTV
        p = _params(_v4(), _morphoPlace(), MAX, 7e18);
        p.guard.minHealthFactor = 0;
        vm.expectRevert();
        ex.refinance(p, _noAuth());
        vm.stopPrank();
    }

    function test_security_strangerCannotUseAllowances() public {
        _onAave(10e18, 12_000e6);
        _onV4(0, 0);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        IDebtToken(vUSDX).approveDelegation(address(ex), type(uint256).max);
        taker.approveWithdraw(address(spoke), C, address(ex), type(uint256).max);
        taker.approveBorrow(address(spoke), D, address(ex), type(uint256).max);
        IMorphoAdmin(address(blue)).setAuthorization(address(ex), true);
        vm.stopPrank();

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        spoke.setUsingAsCollateral(C, true, stranger);
        LeverageExecutorV4.Place[3] memory places = [_aave(), _v4(), _morphoPlace()];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 3; ++j) {
                if (i == j || (i != 1 && j != 1)) continue;
                vm.expectRevert(LeverageExecutorV4.ZeroAmount.selector);
                ex.refinance(_params(places[i], places[j], MAX, MAX), _noAuth());
            }
        }
        vm.stopPrank();
        assertEq(IERC20(aWETH).balanceOf(owner), 10e18);
    }

    function test_constructor_refusesAaveSideRouters() public {
        address[4] memory bad = [address(pool), aWETH, vUSDX, USDX];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, bad[i]));
            _deployV4(bad[i]);
        }
        address[] memory routers = new address[](0);
        address[] memory pools = new address[](1);
        pools[0] = makeAddr("no code");
        vm.expectRevert(SwapExecutorBase.ZeroAddress.selector);
        new LeverageExecutorV4(blue, IAaveV4Giver(address(giver)), IAaveV4Taker(address(taker)), routers, pools);
        assertTrue(ex.isAavePool(address(pool)));
    }
}
