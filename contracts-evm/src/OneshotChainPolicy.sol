// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Shared deployment chain guard. Blocks zero, Ethereum mainnet, Base mainnet, and Zerion's ZER0 Network (543210).
library OneshotChainPolicy {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 internal constant ZERION_ZERO_CHAIN_ID = 543210;
    address internal constant BASE_SEPOLIA_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;

    function isSupportedChain(uint256 chainId) internal pure returns (bool) {
        return chainId != 0 && chainId != 1 && chainId != 8453 && chainId != ZERION_ZERO_CHAIN_ID;
    }
}
