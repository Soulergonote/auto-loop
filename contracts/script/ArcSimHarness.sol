// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IMorphoAuth {
    function setAuthorization(address, bool) external;
    function isAuthorized(address, address) external view returns (bool);
}

/// @notice Run as an eth_call creation (nothing is sent) on a chain whose RPC has no eth_simulateV1 and whose native
/// token cannot be forked (Arc: USDC is native). This contract is the user: it deploys LeverageExecutorMorpho, approves
/// the capital, authorizes the executor on Morpho, runs `openCall` then `closeCall` on it, revokes, and returns
/// abi.encode(executor, okOpen, retOpen, okClose, retClose, loanBalanceBefore, loanBalanceAfter, stillAuthorized).
/// The executor's address (needed by the swap quotes) is create(this, nonce 1).
contract ArcSimHarness {
    constructor(
        bytes memory executorInit,
        address morpho,
        address loanToken,
        uint256 capital,
        bytes memory openCall,
        bytes memory closeCall
    ) {
        address x;
        assembly {
            x := create(0, add(executorInit, 32), mload(executorInit))
        }
        require(x != address(0), "deploy failed");
        bytes memory out = _run(x, morpho, loanToken, capital, openCall, closeCall);
        assembly {
            return(add(out, 32), mload(out))
        }
    }

    bool private okOpen;
    bool private okClose;
    bytes private retOpen;
    bytes private retClose;

    function _run(address x, address morpho, address loanToken, uint256 capital, bytes memory openCall, bytes memory closeCall)
        internal
        returns (bytes memory)
    {
        uint256 before = _bal(loanToken);
        IERC20Min(loanToken).approve(x, capital);
        IMorphoAuth(morpho).setAuthorization(x, true);
        (okOpen, retOpen) = x.call(openCall);
        if (okOpen) (okClose, retClose) = x.call(closeCall);
        IMorphoAuth(morpho).setAuthorization(x, false);
        bool still = IMorphoAuth(morpho).isAuthorized(address(this), x);
        return abi.encode(x, okOpen, retOpen, okClose, retClose, before, _bal(loanToken), still);
    }

    function _bal(address t) internal view returns (uint256) {
        return IERC20Min(t).balanceOf(address(this));
    }
}
