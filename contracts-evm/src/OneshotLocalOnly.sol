// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev A hard deployment gate for allocation experiments that are not market launches.
abstract contract OneshotLocalOnly {
    error LocalDevelopmentOnly(uint256 actualChainId);

    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    constructor() {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalDevelopmentOnly(block.chainid);
    }
}
