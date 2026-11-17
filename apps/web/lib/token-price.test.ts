import { describe, expect, it } from 'vitest';
import { nativeTokenPriceMatchesSqrt, tokenPriceChartNumber, tokenPriceDisplay, validNativeRawTokenPrice } from './token-price';

describe('exact native token price display', () => {
  it('applies ETH18 once to a raw ratio and retains digits above JavaScript precision', () => {
    expect(tokenPriceDisplay({ numerator: '1000000000000000001', denominator: '1' })).toEqual({ text: '1.000000000000000001', approximate: false, belowPrecision: false });
    expect(tokenPriceDisplay({ numerator: '9007199254740993123456789000000001', denominator: '1' }).text).toBe('9007199254740993.123456789000000001');
    expect(tokenPriceDisplay({ numerator: '10000000000000000000', denominator: '1' }).text).toBe('10');
  });
  it('marks recurring/truncated fractions and preserves nonzero prices below the chosen precision', () => {
    expect(tokenPriceDisplay({ numerator: '1000000000000000000', denominator: '3' })).toEqual({ text: '0.333333333333333333', approximate: true, belowPrecision: false });
    expect(tokenPriceDisplay({ numerator: '1', denominator: '2' })).toEqual({ text: '<0.000000000000000001', approximate: true, belowPrecision: true });
    expect(tokenPriceDisplay({ numerator: '1000000000000000000', denominator: '2' })).toEqual({ text: '0.5', approximate: false, belowPrecision: false });
  });
  it('checks a square-root price relationship without rounding or rejecting an equivalent reduced fraction', () => {
    const sqrt = 2n ** 96n, numerator = 2n ** 192n * 100000000n, denominator = sqrt * sqrt;
    expect(nativeTokenPriceMatchesSqrt({ numerator: numerator.toString(), denominator: denominator.toString() }, sqrt.toString())).toBe(true);
    expect(nativeTokenPriceMatchesSqrt({ numerator: '100000000', denominator: '1' }, sqrt.toString())).toBe(true);
    expect(nativeTokenPriceMatchesSqrt({ numerator: '100000001', denominator: '1' }, sqrt.toString())).toBe(false);
    expect(tokenPriceDisplay({ numerator: numerator.toString(), denominator: denominator.toString() }).text).toBe('0.0000000001');
  });
  it('rejects malformed, zero and unbounded ratios instead of producing zero or infinity', () => {
    for (const value of [null, {}, { numerator: '0', denominator: '1' }, { numerator: '1', denominator: '0' }, { numerator: '01', denominator: '1' }, { numerator: '-1', denominator: '1' }, { numerator: '1e18', denominator: '1' }, { numerator: '1'.repeat(257), denominator: '1' }]) {
      expect(validNativeRawTokenPrice(value)).toBe(false); expect(tokenPriceChartNumber(value as never)).toBeNull();
    }
    expect(nativeTokenPriceMatchesSqrt({ numerator: '1', denominator: '1' }, (2n ** 160n).toString())).toBe(false);
    expect(() => tokenPriceDisplay({ numerator: '1', denominator: '1' }, 1000)).toThrow('could not be verified');
  });
});
