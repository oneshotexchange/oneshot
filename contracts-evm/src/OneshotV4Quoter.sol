// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {OneshotV4Market, OneshotV4MarketFactory} from "./OneshotV4Market.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice Exact-input simulation for this immutable factory's markets. Run via
/// eth_call. The callback always reverts, rolling back the swap, oracle writes,
/// and protocol accounting; no settlement, approvals, or asset custody occurs.
/// Native buy input is the pool input after the separately disclosed oneshot fee.
contract OneshotV4Quoter is IUnlockCallback, ReentrancyGuard {
    OneshotV4MarketFactory public immutable factory;
    IPoolManager public immutable poolManager;
    bytes32 private _callbackHash;
    error InvalidFactory();
    error InvalidMarket();
    error InvalidAmount();
    error InvalidPriceLimit();
    error UnauthorizedCallback();
    error PartialFill();
    error NoOutput();
    error MalformedQuote();
    error QuoteResult(uint256 actualInput, uint256 output);

    constructor(OneshotV4MarketFactory factory_) {
        if (address(factory_).code.length == 0 || !OneshotChainPolicy.isSupportedChain(block.chainid)) revert InvalidFactory();
        factory = factory_; poolManager = factory_.poolManager();
        if (address(poolManager).code.length == 0 || (block.chainid == OneshotChainPolicy.BASE_SEPOLIA_CHAIN_ID && address(poolManager) != OneshotChainPolicy.BASE_SEPOLIA_POOL_MANAGER)) revert InvalidFactory();
    }

    function quoteSwap(OneshotV4Market market, bool buy, uint256 poolInput, uint160 priceLimit) external nonReentrant returns (uint256 output) {
        if (!factory.isMarket(address(market)) || market.deploymentChainId() != block.chainid || !market.initialized()) revert InvalidMarket();
        if (poolInput == 0 || poolInput > uint256(uint128(type(int128).max))) revert InvalidAmount();
        uint160 lower = market.sqrtLowerX96(); uint160 upper = market.sqrtUpperX96();
        if (priceLimit == 0) priceLimit = buy ? lower : upper;
        if (priceLimit < lower || priceLimit > upper) revert InvalidPriceLimit();
        bytes memory data = abi.encode(market, buy, poolInput, priceLimit);
        _callbackHash = keccak256(data);
        try poolManager.unlock(data) returns (bytes memory) { revert MalformedQuote(); }
        catch (bytes memory reason) {
            _callbackHash = bytes32(0);
            bytes4 selector;
            assembly ("memory-safe") { selector := mload(add(reason, 32)) }
            if (reason.length != 68 || selector != QuoteResult.selector) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            uint256 actualInput;
            assembly ("memory-safe") {
                actualInput := mload(add(reason, 36))
                output := mload(add(reason, 68))
            }
            if (actualInput != poolInput || output == 0) revert MalformedQuote();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _callbackHash == bytes32(0) || _callbackHash != keccak256(data)) revert UnauthorizedCallback();
        _callbackHash = bytes32(0);
        (OneshotV4Market market, bool buy, uint256 amount, uint160 limit) = abi.decode(data, (OneshotV4Market, bool, uint256, uint160));
        BalanceDelta delta = poolManager.swap(market.poolKey(), SwapParams(buy, -int256(amount), limit), "");
        int128 input = buy ? delta.amount0() : delta.amount1();
        int128 output = buy ? delta.amount1() : delta.amount0();
        if (input >= 0 || uint256(-int256(input)) != amount) revert PartialFill();
        if (output <= 0) revert NoOutput();
        revert QuoteResult(amount, uint256(int256(output)));
    }
}
