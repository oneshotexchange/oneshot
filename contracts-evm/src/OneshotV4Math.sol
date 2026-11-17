// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

library OneshotV4Math {
    uint256 internal constant SUPPLY = 100_000_000_000_000_000;
    int24 internal constant TICK_SPACING = 10;
    error InvalidValuation();

    function ticks(uint256 openingValuation) internal pure returns (int24 lower, int24 upper) {
        if (openingValuation == 0 || openingValuation > type(uint256).max / 1000) revert InvalidValuation();
        uint160 start = sqrtForValuation(openingValuation);
        uint160 end = sqrtForValuation(openingValuation * 1000);
        upper = floorTick(TickMath.getTickAtSqrtPrice(start));
        lower = floorTick(TickMath.getTickAtSqrtPrice(end));
        if (lower < TickMath.minUsableTick(TICK_SPACING) || upper > TickMath.maxUsableTick(TICK_SPACING) || lower >= upper) revert InvalidValuation();
    }

    function sqrtForValuation(uint256 valuation) internal pure returns (uint160 result) {
        // SUPPLY fits 57 bits, so SUPPLY * Q192 fits uint256 exactly.
        result = uint160(Math.sqrt((SUPPLY << 192) / valuation));
        if (result <= TickMath.MIN_SQRT_PRICE || result >= TickMath.MAX_SQRT_PRICE) revert InvalidValuation();
    }

    function floorTick(int24 tick) internal pure returns (int24 result) {
        result = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) result--;
        result *= TICK_SPACING;
    }

    /// @notice Exact raw-asset quote at a tick: token1 has 8 decimals, native token0 has 18.
    function quote(uint160 sqrtPrice, uint256 amount, bool nativeToToken) internal pure returns (uint256) {
        if (sqrtPrice <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPrice) * sqrtPrice;
            return nativeToToken ? FullMath.mulDiv(amount, ratioX192, 1 << 192) : FullMath.mulDiv(amount, 1 << 192, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 64);
        return nativeToToken ? FullMath.mulDiv(amount, ratioX128, 1 << 128) : FullMath.mulDiv(amount, 1 << 128, ratioX128);
    }
}
