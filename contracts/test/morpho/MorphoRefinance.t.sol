// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {V2Base, IDebtToken} from "../v2/V2Base.sol";
import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {SwapExecutorBase} from "../../src/base/SwapExecutorBase.sol";
import {IMorpho, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {MORPHO_BLUE_BYTECODE} from "./MorphoBlueBytecode.sol";
import {MockMorphoOracle, FixedRateIrm} from "./MorphoMocks.sol";

interface IMorphoSetup {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function createMarket(MarketParams memory marketParams) external;
    function supply(MarketParams memory m, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
}

/// @notice Refinance between a real local Aave v3.6 (WETH $1800, USDX $1) and the real Morpho Blue bytecode with a
/// WETH / USDX market (LLTV 86 %, oracle at the same price, 5 % a year).
contract MorphoRefinanceTest is V2Base {
    bytes32 constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    IMorpho blue;
    LeverageExecutorMorpho ex;
    MarketParams mkt;
    address owner;
    uint256 userKey;

    function setUp() public override {
        super.setUp();
        (owner, userKey) = makeAddrAndKey("refi-owner");
        bytes memory code = abi.encodePacked(MORPHO_BLUE_BYTECODE, abi.encode(address(this)));
        address m;
        assembly ("memory-safe") {
            m := create(0, add(code, 32), mload(code))
        }
        require(m != address(0), "morpho deploy");
        blue = IMorpho(m);
        FixedRateIrm irm = new FixedRateIrm(1_585_489_599);
        IMorphoSetup(m).enableIrm(address(irm));
        IMorphoSetup(m).enableLltv(0.86e18);
        // USDX units per WETH unit x 1e36: 1800 x 1e6 / 1e18
        mkt = MarketParams(USDX, WETH, address(new MockMorphoOracle(1800e24)), address(irm), 0.86e18);
        IMorphoSetup(m).createMarket(mkt);
        deal(USDX, carol, 5_000_000e6);
        vm.startPrank(carol);
        IERC20(USDX).approve(m, type(uint256).max);
        IMorphoSetup(m).supply(mkt, 5_000_000e6, 0, carol, "");
        vm.stopPrank();

        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        ex = new LeverageExecutorMorpho(blue, routers, pools);
        vm.label(address(ex), "morpho-executor");
        deal(WETH, owner, 10e18);
    }

    // ---------------------------------------------------------------- helpers

    function _id() internal view returns (bytes32) {
        return keccak256(abi.encode(mkt));
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

    function _morphoDebt() internal view returns (uint256) {
        (, uint128 b,) = blue.position(_id(), owner);
        (,, uint128 tba, uint128 tbs,,) = blue.market(_id());
        return (uint256(b) * (uint256(tba) + 1) + (uint256(tbs) + 1e6) - 1) / (uint256(tbs) + 1e6);
    }

    function _morphoCollateral() internal view returns (uint256 c) {
        (,, c) = blue.position(_id(), owner);
    }

    function _params(bool toMorpho, uint256 debt, uint256 coll, uint256 minHf)
        internal
        view
        returns (LeverageExecutorMorpho.RefinanceParams memory p)
    {
        p.pool = address(pool);
        p.market = mkt;
        p.toMorpho = toMorpho;
        p.debtAmount = debt;
        p.collateralAmount = coll;
        p.guard = LeverageExecutorMorpho.Guard(minHf, block.timestamp + 20 minutes);
    }

    function _sign(Authorization memory a) internal view returns (MorphoSignature memory s) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IMorphoSetup(address(blue)).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))
            )
        );
        (s.v, s.r, s.s) = vm.sign(userKey, digest);
    }

    function _auth() internal view returns (LeverageExecutorMorpho.AuthSigs memory a) {
        a.nonce = blue.nonce(owner);
        a.deadline = block.timestamp + 20 minutes;
        a.grant = _sign(Authorization(owner, address(ex), true, a.nonce, a.deadline));
        a.revoke = _sign(Authorization(owner, address(ex), false, a.nonce + 1, a.deadline));
    }

    function _noSig() internal pure returns (LeverageExecutorMorpho.AaveSig memory s) {}

    function _assertRefiClean() internal view {
        address[3] memory t = [WETH, USDX, aWETH];
        for (uint256 i; i < t.length; ++i) {
            assertEq(IERC20(t[i]).balanceOf(address(ex)), 0, "executor balance");
            assertEq(IERC20(t[i]).allowance(address(ex), address(blue)), 0, "allowance to Morpho");
            assertEq(IERC20(t[i]).allowance(address(ex), address(pool)), 0, "allowance to Aave");
        }
        assertFalse(blue.isAuthorized(owner, address(ex)), "authorization left");
    }

    // ---------------------------------------------------------------- Aave -> Morpho

    function test_toMorpho_whole() public {
        _onAave(10e18, 12_000e6);
        uint256 debt = IERC20(vUSDX).balanceOf(owner);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        LeverageExecutorMorpho.RefinanceResult memory r =
            ex.refinanceWithAuth(_params(true, MAX, MAX, 1.1e18), _auth(), _noSig());
        vm.stopPrank();

        assertEq(IERC20(vUSDX).balanceOf(owner), 0, "Aave debt left");
        assertEq(IERC20(aWETH).balanceOf(owner), 0, "Aave collateral left");
        assertEq(_morphoCollateral(), 10e18, "Morpho collateral");
        assertApproxEqAbs(_morphoDebt(), debt, 1, "Morpho debt = Aave debt");
        assertEq(r.debtMoved, debt);
        assertEq(r.collateralMoved, 10e18);
        // 10 x 1800 x 0.86 / 12000
        assertApproxEqRel(r.healthFactor, 1.29e18, 0.001e18);
        _assertRefiClean();
    }

    function test_toMorpho_part_keepsAaveHealthy() public {
        _onAave(10e18, 12_000e6);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), 5e18);
        IMorphoSetup(address(blue)).setAuthorization(address(ex), true);
        ex.refinance(_params(true, 6_000e6, 5e18, 1.1e18));
        IMorphoSetup(address(blue)).setAuthorization(address(ex), false);
        vm.stopPrank();
        assertApproxEqAbs(IERC20(vUSDX).balanceOf(owner), 6_000e6, 1);
        assertApproxEqAbs(IERC20(aWETH).balanceOf(owner), 5e18, 1);
        assertEq(_morphoCollateral(), 5e18);
        assertApproxEqAbs(_morphoDebt(), 6_000e6, 1);
        _assertRefiClean();
    }

    function test_toMorpho_permitSignature() public {
        _onAave(10e18, 12_000e6);
        LeverageExecutorMorpho.AaveSig memory s;
        s.value = type(uint256).max;
        s.deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(ex),
                s.value,
                IPermit(aWETH).nonces(owner),
                s.deadline
            )
        );
        (s.v, s.r, s.s) =
            vm.sign(userKey, keccak256(abi.encodePacked("\x19\x01", IPermit(aWETH).DOMAIN_SEPARATOR(), structHash)));
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        vm.prank(owner);
        ex.refinanceWithAuth(_params(true, MAX, MAX, 0), a, s);
        assertEq(IERC20(aWETH).balanceOf(owner), 0);
        assertEq(_morphoCollateral(), 10e18);
    }

    function test_revert_toMorpho_belowMinHealth() public {
        _onAave(10e18, 12_000e6);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        LeverageExecutorMorpho.RefinanceParams memory p = _params(true, MAX, MAX, 1.3e18);
        vm.expectPartialRevert(LeverageExecutorMorpho.HealthFactorTooLow.selector);
        ex.refinanceWithAuth(p, a, _noSig());
        vm.stopPrank();
    }

    function test_revert_toMorpho_withoutMorphoAuthorization() public {
        _onAave(10e18, 12_000e6);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        LeverageExecutorMorpho.RefinanceParams memory p = _params(true, MAX, MAX, 0);
        vm.expectRevert();
        ex.refinance(p);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- Morpho -> Aave

    function test_fromMorpho_whole() public {
        _onMorpho(10e18, 12_000e6);
        skip(30 days);
        vm.startPrank(owner);
        IDebtToken(vUSDX).approveDelegation(address(ex), 13_000e6);
        LeverageExecutorMorpho.RefinanceParams memory p = _params(false, MAX, MAX, 1.1e18);
        LeverageExecutorMorpho.RefinanceResult memory r = ex.refinanceWithAuth(p, _auth(), _noSig());
        vm.stopPrank();

        (, uint128 shares, uint128 coll) = blue.position(_id(), owner);
        assertEq(shares, 0, "Morpho debt left (by shares, no dust)");
        assertEq(coll, 0, "Morpho collateral left");
        assertApproxEqAbs(IERC20(aWETH).balanceOf(owner), 10e18, 1);
        assertGt(r.debtMoved, 12_000e6, "interest moved too");
        assertApproxEqAbs(IERC20(vUSDX).balanceOf(owner), r.debtMoved, 1);
        (,,,,, uint256 hf) = pool.getUserAccountData(owner);
        assertEq(r.healthFactor, hf);
        _assertRefiClean();
    }

    function test_revert_fromMorpho_withoutDelegation() public {
        _onMorpho(10e18, 12_000e6);
        vm.startPrank(owner);
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        LeverageExecutorMorpho.RefinanceParams memory p = _params(false, MAX, MAX, 0);
        vm.expectRevert();
        ex.refinanceWithAuth(p, a, _noSig());
        vm.stopPrank();
    }

    function test_roundTrip_aaveMorphoAave() public {
        _onAave(10e18, 12_000e6);
        vm.startPrank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        ex.refinanceWithAuth(_params(true, MAX, MAX, 1.1e18), _auth(), _noSig());
        IDebtToken(vUSDX).approveDelegation(address(ex), 12_001e6);
        ex.refinanceWithAuth(_params(false, MAX, MAX, 1.1e18), _auth(), _noSig());
        vm.stopPrank();
        assertApproxEqAbs(IERC20(aWETH).balanceOf(owner), 10e18, 2);
        assertApproxEqAbs(IERC20(vUSDX).balanceOf(owner), 12_000e6, 2);
        assertEq(_morphoCollateral(), 0);
        _assertRefiClean();
    }

    // ---------------------------------------------------------------- safety

    function test_revert_poolNotWhitelisted() public {
        LeverageExecutorMorpho.RefinanceParams memory p = _params(true, 1e6, 1, 0);
        p.pool = address(router);
        vm.expectRevert(abi.encodeWithSelector(LeverageExecutorMorpho.PoolNotAllowed.selector, address(router)));
        vm.prank(owner);
        ex.refinance(p);
    }

    function test_onlyMovesTheCallersPosition() public {
        _onAave(10e18, 12_000e6);
        vm.prank(owner);
        IERC20(aWETH).approve(address(ex), type(uint256).max);
        // the attacker has no Aave debt: nothing to move, and nothing of the owner's is touched
        vm.expectRevert(LeverageExecutorMorpho.ZeroAmount.selector);
        vm.prank(attacker);
        ex.refinance(_params(true, MAX, MAX, 0));
        assertEq(IERC20(aWETH).balanceOf(owner), 10e18);
    }

    function test_constructor_rejectsAaveTokensAndPoolsAsRouters() public {
        address[] memory pools = new address[](1);
        pools[0] = address(pool);
        address[3] memory bad = [address(pool), aWETH, USDX];
        for (uint256 i; i < bad.length; ++i) {
            address[] memory routers = new address[](1);
            routers[0] = bad[i];
            vm.expectRevert(abi.encodeWithSelector(SwapExecutorBase.InvalidRouter.selector, bad[i]));
            new LeverageExecutorMorpho(blue, routers, pools);
        }
    }
}

interface IPermit {
    function nonces(address who) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
