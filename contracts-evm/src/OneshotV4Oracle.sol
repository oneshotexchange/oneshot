// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

interface IOneshotOracleMarketToken {
    function market() external view returns (address);
}

/// @notice Observation-only hook. No fee override, delta, swap restriction, or asset-moving entrypoint.
/// Missing/overwritten history makes maintenance unavailable; it never falls back to spot pricing.
contract OneshotV4Oracle {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint160 public constant FLAGS = (1 << 12) | (1 << 6);
    // At most one record per second. Retain enough history for a 300s window
    // even when every second contains swaps on Base's 200ms blocks.
    uint16 public constant CARDINALITY = 1024;
    uint32 public constant MIN_WINDOW = 300;
    IPoolManager public immutable poolManager;
    struct Observation { uint64 timestamp; int192 cumulative; }
    struct State { uint64 timestamp; int192 cumulative; int24 tick; uint16 index; uint16 count; }
    mapping(PoolId => State) public states;
    mapping(PoolId => mapping(uint16 => Observation)) public observations;
    error InvalidHookDeployment();
    error OnlyPoolManager();
    error OracleNotReady();
    error UnsupportedHook();

    constructor(IPoolManager manager) {
        if ((block.chainid != 31337 && block.chainid != 84532) || address(manager).code.length == 0
            || uint160(address(this)) & ((1 << 14) - 1) != FLAGS) revert InvalidHookDeployment();
        poolManager = manager;
    }

    function afterInitialize(address sender, PoolKey calldata key, uint160, int24 tick) external returns (bytes4) {
        _check(key);
        // A predictable not-yet-created token address must not be initialized
        // ahead of the atomic factory launch and permanently block its pool.
        address selectedToken = Currency.unwrap(key.currency1);
        if (Currency.unwrap(key.currency0) != address(0) || selectedToken.code.length == 0 || sender.code.length == 0
            || IOneshotOracleMarketToken(selectedToken).market() != sender) revert InvalidHookDeployment();
        PoolId id = key.toId();
        if (states[id].count != 0) revert InvalidHookDeployment();
        uint64 now_ = uint64(block.timestamp);
        states[id] = State(now_, 0, tick, 0, 1);
        observations[id][0] = Observation(now_, 0);
        return IHooks.afterInitialize.selector;
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata) external returns (bytes4, int128) {
        _check(key);
        PoolId id = key.toId();
        State storage state = states[id];
        if (state.count == 0) revert OracleNotReady();
        uint64 now_ = uint64(block.timestamp);
        if (now_ > state.timestamp) {
            state.cumulative += int192(state.tick) * int192(uint192(now_ - state.timestamp));
            state.timestamp = now_;
            state.index = uint16((uint256(state.index) + 1) % CARDINALITY);
            if (state.count < CARDINALITY) state.count++;
            observations[id][state.index] = Observation(now_, state.cumulative);
        }
        (, state.tick,,) = poolManager.getSlot0(id);
        return (IHooks.afterSwap.selector, 0);
    }

    function consult(PoolId id, uint32 window) external view returns (int24 meanTick) {
        State memory state = states[id];
        if (window < MIN_WINDOW || state.count == 0 || block.timestamp < window) revert OracleNotReady();
        uint64 target = uint64(block.timestamp - window);
        uint16 oldest = state.count == CARDINALITY ? uint16((uint256(state.index) + 1) % CARDINALITY) : 0;
        if (observations[id][oldest].timestamp > target) revert OracleNotReady();
        int192 before_ = _cumulativeAt(id, state, oldest, target);
        int192 current = state.cumulative + int192(state.tick) * int192(uint192(block.timestamp - state.timestamp));
        int192 elapsed = int192(uint192(window));
        int192 difference = current - before_;
        int192 mean = difference / elapsed;
        if (difference < 0 && difference % elapsed != 0) mean--;
        meanTick = int24(mean);
    }

    function _cumulativeAt(PoolId id, State memory state, uint16 oldest, uint64 target) private view returns (int192) {
        if (target >= state.timestamp) return state.cumulative + int192(state.tick) * int192(uint192(target - state.timestamp));
        uint256 low; uint256 high = state.count - 1;
        while (low < high) {
            uint256 middle = (low + high + 1) / 2;
            if (observations[id][uint16((oldest + middle) % CARDINALITY)].timestamp <= target) low = middle;
            else high = middle - 1;
        }
        Observation memory left = observations[id][uint16((oldest + low) % CARDINALITY)];
        if (left.timestamp == target) return left.cumulative;
        Observation memory right = observations[id][uint16((oldest + low + 1) % CARDINALITY)];
        return left.cumulative + (right.cumulative - left.cumulative) * int192(uint192(target - left.timestamp)) / int192(uint192(right.timestamp - left.timestamp));
    }

    function _check(PoolKey calldata key) private view {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        if (address(key.hooks) != address(this)) revert InvalidHookDeployment();
    }

    fallback() external { revert UnsupportedHook(); }
}

/// @notice Salt is mined offchain for the required immutable hook flags; deployment moves no user funds.
contract OneshotV4OracleDeployer {
    function predict(IPoolManager manager, bytes32 salt) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt,
            keccak256(abi.encodePacked(type(OneshotV4Oracle).creationCode, abi.encode(manager))))))));
    }
    function deploy(IPoolManager manager, bytes32 salt) external returns (OneshotV4Oracle) {
        return new OneshotV4Oracle{salt: salt}(manager);
    }
}
