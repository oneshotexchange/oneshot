import { describe, expect, it } from 'vitest';
import { UINT256_MAX } from '../src/economics';
import { applyProtectedFloor } from '../src/protected-floor';

describe('protected-floor native pricing', () => {
  it('adds the floor only when the entered amount is below it', () => {
    expect(applyProtectedFloor(4n, 5n)).toEqual({ enteredRaw: 4n, floorRaw: 5n, listingRaw: 9n, adjusted: true });
    expect(applyProtectedFloor(5n, 5n)).toEqual({ enteredRaw: 5n, floorRaw: 5n, listingRaw: 5n, adjusted: false });
    expect(applyProtectedFloor(6n, 5n)).toEqual({ enteredRaw: 6n, floorRaw: 5n, listingRaw: 6n, adjusted: false });
  });

  it('preserves exact native base units far above Number precision', () => {
    const floor = 5_123_456_789_123_456_789_123_456_789n;
    const entered = 4_123_456_789_123_456_789_123_456_789n;
    expect(applyProtectedFloor(entered, floor).listingRaw).toBe(9_246_913_578_246_913_578_246_913_578n);
    expect(applyProtectedFloor(floor + 1n, floor).listingRaw).toBe(floor + 1n);
  });

  it('handles zero without inventing a minimum listing amount', () => {
    expect(applyProtectedFloor(0n, 5n)).toEqual({ enteredRaw: 0n, floorRaw: 5n, listingRaw: 5n, adjusted: true });
    expect(applyProtectedFloor(5n, 0n)).toEqual({ enteredRaw: 5n, floorRaw: 0n, listingRaw: 5n, adjusted: false });
    expect(applyProtectedFloor(0n, 0n)).toEqual({ enteredRaw: 0n, floorRaw: 0n, listingRaw: 0n, adjusted: false });
  });

  it('accepts exact uint256 boundaries when no addition overflows', () => {
    expect(applyProtectedFloor(UINT256_MAX, UINT256_MAX).listingRaw).toBe(UINT256_MAX);
    expect(applyProtectedFloor(UINT256_MAX, 0n).listingRaw).toBe(UINT256_MAX);
    expect(applyProtectedFloor(0n, UINT256_MAX).listingRaw).toBe(UINT256_MAX);
    const entered = UINT256_MAX / 2n;
    const floor = entered + 1n;
    expect(applyProtectedFloor(entered, floor)).toMatchObject({ listingRaw: UINT256_MAX, adjusted: true });
  });

  it('rejects addition overflow instead of wrapping or clipping the result', () => {
    expect(() => applyProtectedFloor(1n, UINT256_MAX)).toThrow('exceeds uint256');
    expect(() => applyProtectedFloor(UINT256_MAX - 1n, UINT256_MAX)).toThrow('exceeds uint256');
    expect(() => applyProtectedFloor(UINT256_MAX / 2n + 1n, UINT256_MAX / 2n + 2n)).toThrow('exceeds uint256');
  });

  it.each([-1n, UINT256_MAX + 1n])('rejects out-of-range entered and floor amounts: %s', invalid => {
    expect(() => applyProtectedFloor(invalid, 5n)).toThrow(RangeError);
    expect(() => applyProtectedFloor(5n, invalid)).toThrow(RangeError);
  });

  it.each([0, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, {}, true])('rejects non-bigint runtime values: %s', invalid => {
    expect(() => applyProtectedFloor(invalid as bigint, 5n)).toThrow(TypeError);
    expect(() => applyProtectedFloor(5n, invalid as bigint)).toThrow(TypeError);
  });
});
