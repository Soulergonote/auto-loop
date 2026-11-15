// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAaveV4Spoke, IAaveV4Taker} from "../../src/interfaces/IAaveV4.sol";
import {UsdPrices} from "../morpho/MorphoMocks.sol";

/// @notice The rules of an Aave v4 Spoke that matter to LeverageExecutorV4, without hubs, shares or interest: only a
/// user or one of their position managers acts on a position, a supply counts as collateral only once the user
/// enabled the reserve, and a borrow or a withdrawal must leave the health factor at 1 or above. The fork tests run
/// the same scenarios against the real spokes.
contract MockSpokeV4 {
    using SafeERC20 for IERC20;

    struct R {
        address underlying;
        uint256 collateralFactorBps;
    }

    UsdPrices public immutable prices;
    R[] public reserves;
    mapping(address => mapping(address => bool)) public isPositionManager;
    mapping(address => mapping(uint256 => uint256)) public supplied;
    mapping(address => mapping(uint256 => uint256)) public debt;
    mapping(address => mapping(uint256 => bool)) public usingAsCollateral;

    error Unauthorized();
    error HealthFactorBelowThreshold();

    constructor(UsdPrices prices_) {
        prices = prices_;
    }

    modifier onlyPositionManager(address user) {
        if (msg.sender != user && !isPositionManager[user][msg.sender]) revert Unauthorized();
        _;
    }

    function addReserve(address underlying, uint256 collateralFactorBps) external returns (uint256) {
        reserves.push(R(underlying, collateralFactorBps));
        return reserves.length - 1;
    }

    /// @dev interest: the test grows a debt by hand
    function accrue(address user, uint256 reserveId, uint256 amount) external {
        debt[user][reserveId] += amount;
    }

    function setUserPositionManager(address positionManager, bool approve) external {
        isPositionManager[msg.sender][positionManager] = approve;
    }

    function setUsingAsCollateral(uint256 reserveId, bool use, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
    {
        usingAsCollateral[onBehalfOf][reserveId] = use;
        if (!use) _check(onBehalfOf);
    }

    function supply(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        IERC20(reserves[reserveId].underlying).safeTransferFrom(msg.sender, address(this), amount);
        supplied[onBehalfOf][reserveId] += amount;
        return (amount, amount);
    }

    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        uint256 has = supplied[onBehalfOf][reserveId];
        if (amount > has) amount = has;
        supplied[onBehalfOf][reserveId] = has - amount;
        IERC20(reserves[reserveId].underlying).safeTransfer(msg.sender, amount);
        _check(onBehalfOf);
        return (amount, amount);
    }

    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        debt[onBehalfOf][reserveId] += amount;
        IERC20(reserves[reserveId].underlying).safeTransfer(msg.sender, amount);
        _check(onBehalfOf);
        return (amount, amount);
    }

    function repay(uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyPositionManager(onBehalfOf)
        returns (uint256, uint256)
    {
        uint256 owed = debt[onBehalfOf][reserveId];
        if (amount > owed) amount = owed;
        IERC20(reserves[reserveId].underlying).safeTransferFrom(msg.sender, address(this), amount);
        debt[onBehalfOf][reserveId] = owed - amount;
        return (amount, amount);
    }

    function getReserve(uint256 reserveId) external view returns (IAaveV4Spoke.Reserve memory r) {
        r.underlying = reserves[reserveId].underlying;
        r.decimals = IERC20Metadata(r.underlying).decimals();
    }

    function getUserReserveStatus(uint256 reserveId, address user) external view returns (bool, bool) {
        return (usingAsCollateral[user][reserveId], debt[user][reserveId] != 0);
    }

    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256) {
        return supplied[user][reserveId];
    }

    function getUserTotalDebt(uint256 reserveId, address user) external view returns (uint256) {
        return debt[user][reserveId];
    }

    function getUserAccountData(address user) public view returns (IAaveV4Spoke.UserAccountData memory d) {
        uint256 backed;
        uint256 owed;
        for (uint256 i; i < reserves.length; ++i) {
            R memory r = reserves[i];
            uint256 unit = 10 ** IERC20Metadata(r.underlying).decimals();
            uint256 price = prices.getAssetPrice(r.underlying);
            if (usingAsCollateral[user][i]) {
                uint256 value = supplied[user][i] * price / unit;
                d.totalCollateralValue += value;
                backed += value * r.collateralFactorBps / 10_000;
            }
            owed += debt[user][i] * price / unit;
        }
        d.totalDebtValueRay = owed * 1e27;
        d.healthFactor = owed == 0 ? type(uint256).max : backed * 1e18 / owed;
    }

    function _check(address user) internal view {
        if (getUserAccountData(user).healthFactor < 1e18) revert HealthFactorBelowThreshold();
    }
}

interface ISpokeActions {
    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
    function repay(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);
}

abstract contract MockPositionManager {
    mapping(address => bool) public isSpokeRegistered;

    error SpokeNotRegistered();

    modifier onlyRegisteredSpoke(address spoke) {
        if (!isSpokeRegistered[spoke]) revert SpokeNotRegistered();
        _;
    }

    function registerSpoke(address spoke, bool registered) external {
        isSpokeRegistered[spoke] = registered;
    }

    function _underlying(address spoke, uint256 reserveId) internal view returns (IERC20) {
        return IERC20(IAaveV4Spoke(spoke).getReserve(reserveId).underlying);
    }
}

/// @notice Same flows as Aave's GiverPositionManager (aave-v4 src/position-manager/GiverPositionManager.sol).
contract MockGiver is MockPositionManager {
    using SafeERC20 for IERC20;

    error RepayOnBehalfMaxUintNotAllowed();

    function supplyOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        IERC20 underlying = _underlying(spoke, reserveId);
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        underlying.forceApprove(spoke, amount);
        return ISpokeActions(spoke).supply(reserveId, amount, onBehalfOf);
    }

    function repayOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256, uint256)
    {
        if (amount == type(uint256).max) revert RepayOnBehalfMaxUintNotAllowed();
        IERC20 underlying = _underlying(spoke, reserveId);
        uint256 owed = IAaveV4Spoke(spoke).getUserTotalDebt(reserveId, onBehalfOf);
        uint256 repayAmount = amount > owed ? owed : amount;
        underlying.safeTransferFrom(msg.sender, address(this), repayAmount);
        underlying.forceApprove(spoke, repayAmount);
        return ISpokeActions(spoke).repay(reserveId, repayAmount, onBehalfOf);
    }
}

/// @notice Same flows as Aave's TakerPositionManager: allowances per (spoke, reserve, owner, spender), given by a
/// transaction or an EIP-712 permit with a sequential nonce, consumed by what was actually taken (never when
/// unlimited), and renounceable by the spender.
contract MockTaker is MockPositionManager {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAW_PERMIT_TYPEHASH = keccak256(
        "WithdrawPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant BORROW_PERMIT_TYPEHASH = keccak256(
        "BorrowPermit(address spoke,uint256 reserveId,address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    mapping(address => mapping(uint256 => mapping(address => mapping(address => uint256)))) public withdrawAllowance;
    mapping(address => mapping(uint256 => mapping(address => mapping(address => uint256)))) public borrowAllowance;
    mapping(address => uint256) private _nonces;

    error InsufficientWithdrawAllowance(uint256 allowance, uint256 amount);
    error InsufficientBorrowAllowance(uint256 allowance, uint256 amount);
    error InvalidSignature();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("TakerPositionManager"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function nonces(address owner, uint192) external view returns (uint256) {
        return _nonces[owner];
    }

    function approveWithdraw(address spoke, uint256 reserveId, address spender, uint256 amount)
        external
        onlyRegisteredSpoke(spoke)
    {
        withdrawAllowance[spoke][reserveId][msg.sender][spender] = amount;
    }

    function approveBorrow(address spoke, uint256 reserveId, address spender, uint256 amount)
        external
        onlyRegisteredSpoke(spoke)
    {
        borrowAllowance[spoke][reserveId][msg.sender][spender] = amount;
    }

    function approveWithdrawWithSig(IAaveV4Taker.WithdrawPermit calldata p, bytes calldata signature)
        external
        onlyRegisteredSpoke(p.spoke)
    {
        _consume(
            p.owner,
            keccak256(
                abi.encode(
                    WITHDRAW_PERMIT_TYPEHASH, p.spoke, p.reserveId, p.owner, p.spender, p.amount, p.nonce, p.deadline
                )
            ),
            p.nonce,
            p.deadline,
            signature
        );
        withdrawAllowance[p.spoke][p.reserveId][p.owner][p.spender] = p.amount;
    }

    function approveBorrowWithSig(IAaveV4Taker.BorrowPermit calldata p, bytes calldata signature)
        external
        onlyRegisteredSpoke(p.spoke)
    {
        _consume(
            p.owner,
            keccak256(
                abi.encode(
                    BORROW_PERMIT_TYPEHASH, p.spoke, p.reserveId, p.owner, p.spender, p.amount, p.nonce, p.deadline
                )
            ),
            p.nonce,
            p.deadline,
            signature
        );
        borrowAllowance[p.spoke][p.reserveId][p.owner][p.spender] = p.amount;
    }

    function _consume(address signer, bytes32 structHash, uint256 nonce, uint256 deadline, bytes calldata signature)
        internal
    {
        if (block.timestamp > deadline) revert InvalidSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (ECDSA.recover(digest, signature) != signer || nonce != _nonces[signer]++) revert InvalidSignature();
    }

    function renounceWithdrawAllowance(address spoke, uint256 reserveId, address owner)
        external
        onlyRegisteredSpoke(spoke)
    {
        withdrawAllowance[spoke][reserveId][owner][msg.sender] = 0;
    }

    function renounceBorrowAllowance(address spoke, uint256 reserveId, address owner)
        external
        onlyRegisteredSpoke(spoke)
    {
        borrowAllowance[spoke][reserveId][owner][msg.sender] = 0;
    }

    function withdrawOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256 shares, uint256 withdrawn)
    {
        uint256 allowance = withdrawAllowance[spoke][reserveId][onBehalfOf][msg.sender];
        if (allowance < amount) revert InsufficientWithdrawAllowance(allowance, amount);
        (shares, withdrawn) = ISpokeActions(spoke).withdraw(reserveId, amount, onBehalfOf);
        if (allowance != type(uint256).max) {
            withdrawAllowance[spoke][reserveId][onBehalfOf][msg.sender] = allowance - withdrawn;
        }
        _underlying(spoke, reserveId).safeTransfer(msg.sender, withdrawn);
    }

    function borrowOnBehalfOf(address spoke, uint256 reserveId, uint256 amount, address onBehalfOf)
        external
        onlyRegisteredSpoke(spoke)
        returns (uint256 shares, uint256 borrowed)
    {
        uint256 allowance = borrowAllowance[spoke][reserveId][onBehalfOf][msg.sender];
        if (allowance < amount) revert InsufficientBorrowAllowance(allowance, amount);
        (shares, borrowed) = ISpokeActions(spoke).borrow(reserveId, amount, onBehalfOf);
        if (allowance != type(uint256).max) {
            borrowAllowance[spoke][reserveId][onBehalfOf][msg.sender] = allowance - borrowed;
        }
        _underlying(spoke, reserveId).safeTransfer(msg.sender, borrowed);
    }
}
