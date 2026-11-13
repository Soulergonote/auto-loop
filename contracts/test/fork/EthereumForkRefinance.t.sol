// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LeverageExecutorMorpho} from "../../src/LeverageExecutorMorpho.sol";
import {IMorpho, MarketParams, Authorization, MorphoSignature} from "../../src/interfaces/IMorpho.sol";
import {IAaveV3Pool} from "../../src/interfaces/IAaveV3.sol";

interface IMorphoDomainR {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
}

interface IAaveTokenR {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
    function approveDelegation(address delegatee, uint256 amount) external;
}

/// @notice LeverageExecutorMorpho.refinance against the real Aave v3 Core pool and the real Morpho Blue on Ethereum:
/// a wstETH / USDC position moved from Aave to Morpho (market wstETH / USDC, LLTV 86 %) and back, with approvals and
/// with the signatures the app sends (aToken permit or delegationWithSig, Morpho authorization grant and revoke).
///   ETH_RPC_URL=... forge test --match-contract EthereumForkRefinanceTest -vv
/// Skipped when ETH_RPC_URL is not set.
contract EthereumForkRefinanceTest is Test {
    IMorpho constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IAaveV3Pool constant POOL = IAaveV3Pool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);
    bytes32 constant WSTETH_USDC = 0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc;
    bytes32 constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant DELEGATION_TYPEHASH =
        keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)");

    LeverageExecutorMorpho ex;
    MarketParams m;
    address aToken;
    address vDebt;
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
        (m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv) = MORPHO.idToMarketParams(WSTETH_USDC);
        aToken = POOL.getReserveData(m.collateralToken).aTokenAddress;
        vDebt = POOL.getReserveData(m.loanToken).variableDebtTokenAddress;
        address[] memory pools = new address[](1);
        pools[0] = address(POOL);
        ex = new LeverageExecutorMorpho(MORPHO, new address[](0), pools);

        // 10 wstETH on Aave, 10 000 USDC borrowed
        deal(m.collateralToken, user, 10e18);
        vm.startPrank(user);
        IERC20(m.collateralToken).approve(address(POOL), 10e18);
        POOL.supply(m.collateralToken, 10e18, user, 0);
        POOL.borrow(m.loanToken, 10_000e6, 2, 0, user);
        vm.stopPrank();
    }

    function _params(bool toMorpho) internal view returns (LeverageExecutorMorpho.RefinanceParams memory p) {
        p.pool = address(POOL);
        p.market = m;
        p.toMorpho = toMorpho;
        p.debtAmount = type(uint256).max;
        p.collateralAmount = type(uint256).max;
        p.guard = LeverageExecutorMorpho.Guard(1.5e18, block.timestamp + 20 minutes);
    }

    function _signMorpho(bool on, uint256 nonce, uint256 deadline) internal view returns (MorphoSignature memory s) {
        Authorization memory a = Authorization(user, address(ex), on, nonce, deadline);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IMorphoDomainR(address(MORPHO)).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a))
            )
        );
        (s.v, s.r, s.s) = vm.sign(userKey, digest);
    }

    function _auth() internal view returns (LeverageExecutorMorpho.AuthSigs memory a) {
        a.nonce = MORPHO.nonce(user);
        a.deadline = block.timestamp + 20 minutes;
        a.grant = _signMorpho(true, a.nonce, a.deadline);
        a.revoke = _signMorpho(false, a.nonce + 1, a.deadline);
    }

    function _aaveSig(address token, bytes32 structHash)
        internal
        view
        returns (LeverageExecutorMorpho.AaveSig memory s)
    {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IAaveTokenR(token).DOMAIN_SEPARATOR(), structHash));
        (s.v, s.r, s.s) = vm.sign(userKey, digest);
    }

    function _morphoPosition() internal view returns (uint256 borrowShares, uint256 collateral) {
        (, uint128 b, uint128 c) = MORPHO.position(WSTETH_USDC, user);
        return (b, c);
    }

    function _assertOnMorpho(uint256 collateral) internal view {
        assertEq(IERC20(vDebt).balanceOf(user), 0, "Aave debt left");
        assertLe(IERC20(aToken).balanceOf(user), 1, "aTokens left");
        (uint256 shares, uint256 c) = _morphoPosition();
        assertGt(shares, 0, "no Morpho debt");
        assertEq(c, collateral, "Morpho collateral");
        assertFalse(MORPHO.isAuthorized(user, address(ex)), "authorization left");
        assertEq(IERC20(m.loanToken).balanceOf(address(ex)), 0, "USDC left in the executor");
        assertEq(IERC20(m.collateralToken).balanceOf(address(ex)), 0, "wstETH left in the executor");
    }

    function test_aaveToMorphoAndBack_withApprovals() public {
        if (noFork) return;
        uint256 supplied = IERC20(aToken).balanceOf(user);
        vm.startPrank(user);
        IERC20(aToken).approve(address(ex), supplied + supplied / 1000);
        IMorphoDomainR(address(MORPHO)).setAuthorization(address(ex), true);
        LeverageExecutorMorpho.RefinanceResult memory r = ex.refinance(_params(true));
        vm.stopPrank();
        assertGe(r.debtMoved, 10_000e6, "debt moved");
        assertEq(r.collateralMoved, supplied, "collateral moved");
        assertGt(r.healthFactor, 1.5e18, "health factor");
        (uint256 shares, uint256 c) = _morphoPosition();
        assertGt(shares, 0);
        assertEq(c, supplied);

        vm.warp(block.timestamp + 1 days);
        vm.startPrank(user);
        IAaveTokenR(vDebt).approveDelegation(address(ex), 10_100e6);
        r = ex.refinance(_params(false));
        IMorphoDomainR(address(MORPHO)).setAuthorization(address(ex), false);
        vm.stopPrank();
        (shares, c) = _morphoPosition();
        assertEq(shares, 0, "Morpho debt left");
        assertEq(c, 0, "Morpho collateral left");
        assertGe(IERC20(vDebt).balanceOf(user), r.debtMoved, "Aave debt");
        assertGe(IERC20(aToken).balanceOf(user), supplied - 1, "Aave collateral");
        (,,,,, uint256 hf) = POOL.getUserAccountData(user);
        assertEq(r.healthFactor, hf, "reported health factor");
    }

    function test_aaveToMorpho_withSignatures() public {
        if (noFork) return;
        uint256 supplied = IERC20(aToken).balanceOf(user);
        uint256 value = supplied + supplied / 1000 + 1;
        uint256 deadline = block.timestamp + 20 minutes;
        LeverageExecutorMorpho.AaveSig memory s = _aaveSig(
            aToken,
            keccak256(abi.encode(PERMIT_TYPEHASH, user, address(ex), value, IAaveTokenR(aToken).nonces(user), deadline))
        );
        s.value = value;
        s.deadline = deadline;
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        LeverageExecutorMorpho.RefinanceParams memory p = _params(true);
        vm.prank(user);
        ex.refinanceWithAuth(p, a, s);
        _assertOnMorpho(supplied);
    }

    function test_morphoToAave_withSignatures() public {
        if (noFork) return;
        uint256 supplied = IERC20(aToken).balanceOf(user);
        vm.startPrank(user);
        IERC20(aToken).approve(address(ex), type(uint256).max);
        IMorphoDomainR(address(MORPHO)).setAuthorization(address(ex), true);
        ex.refinance(_params(true));
        IMorphoDomainR(address(MORPHO)).setAuthorization(address(ex), false);
        vm.stopPrank();

        uint256 value = 10_100e6;
        uint256 deadline = block.timestamp + 20 minutes;
        LeverageExecutorMorpho.AaveSig memory s = _aaveSig(
            vDebt,
            keccak256(abi.encode(DELEGATION_TYPEHASH, address(ex), value, IAaveTokenR(vDebt).nonces(user), deadline))
        );
        s.value = value;
        s.deadline = deadline;
        LeverageExecutorMorpho.AuthSigs memory a = _auth();
        LeverageExecutorMorpho.RefinanceParams memory p = _params(false);
        vm.prank(user);
        LeverageExecutorMorpho.RefinanceResult memory r = ex.refinanceWithAuth(p, a, s);
        (uint256 shares, uint256 c) = _morphoPosition();
        assertEq(shares, 0, "Morpho debt left");
        assertEq(c, 0, "Morpho collateral left");
        assertEq(r.collateralMoved, supplied, "collateral moved");
        assertGe(IERC20(aToken).balanceOf(user), supplied - 1, "Aave collateral");
        assertFalse(MORPHO.isAuthorized(user, address(ex)), "authorization left");
        assertEq(IERC20(m.loanToken).balanceOf(address(ex)), 0, "USDC left in the executor");
    }

    function test_minHealthFactorOnTarget() public {
        if (noFork) return;
        vm.startPrank(user);
        IERC20(aToken).approve(address(ex), type(uint256).max);
        IMorphoDomainR(address(MORPHO)).setAuthorization(address(ex), true);
        LeverageExecutorMorpho.RefinanceParams memory p = _params(true);
        p.guard.minHealthFactor = 100e18;
        vm.expectRevert();
        ex.refinance(p);
        vm.stopPrank();
    }
}
