import { describe, expect, it } from 'vitest';
import { formatIndexedAmount } from '../src/indexed-nfts';

describe('indexed NFT native-amount display', () => {
  it('preserves every base unit above Number precision', () => {
    expect(formatIndexedAmount('123456789012345678901234567890123456789'))
      .toBe('123456789012345678901.234567890123456789');
    expect(formatIndexedAmount('9007199254740993', 0)).toBe('9007199254740993');
  });

  it('renders the smallest base unit without scientific notation', () => {
    expect(formatIndexedAmount('1')).toBe('0.000000000000000001');
    expect(formatIndexedAmount('1', 38)).toBe(`0.${'0'.repeat(37)}1`);
  });

  it('removes only insignificant trailing fractional zeros', () => {
    expect(formatIndexedAmount('1000000000000000000')).toBe('1');
    expect(formatIndexedAmount('1050000000000000000')).toBe('1.05');
    expect(formatIndexedAmount('1000000000000000001')).toBe('1.000000000000000001');
    expect(formatIndexedAmount('0')).toBe('0');
    expect(formatIndexedAmount('1000', 0)).toBe('1000');
  });

  it('keeps cumulative payouts beyond a single uint256 exact', () => {
    const cumulative = `1${'0'.repeat(99)}`;
    expect(formatIndexedAmount(cumulative, 0)).toBe(cumulative);
  });

  it.each(['', '-1', '+1', '01', '0.1', '1e18', ' 1', '1 ', 'NaN', 'Infinity', '1'.repeat(257)])(
    'leaves an invalid raw amount unavailable: %j', value => {
      expect(formatIndexedAmount(value)).toBe('—');
    },
  );

  it.each([-1, 39, 1.5, NaN, Infinity])('rejects unknown or invalid decimal precision %s', decimals => {
    expect(formatIndexedAmount('1', decimals)).toBe('—');
  });
});
