import { describe, expect, it } from 'vitest';
import { formatAssetAmount, parseAssetAmount, splitExecutionFee, splitNftSettlement, UINT256_MAX } from '../src/economics';

describe('asset-aware oneshot amounts', () => {
  it('refuses to turn draft ZRO text into a guessed base-unit amount', () => {
    expect(() => parseAssetAmount('1', null)).toThrow('not verified');
    expect(() => formatAssetAmount(1n, null)).toThrow('not verified');
    expect(parseAssetAmount('1.00000001', 8)).toBe(100000001n);
    expect(parseAssetAmount('1.00000001', 18)).toBe(1000000010000000000n);
    expect(() => parseAssetAmount('1.00000001', 6)).toThrow();
  });
  it('round-trips supported precision and uint256 boundaries without floating point', () => {
    for (const decimals of [0, 6, 8, 18, 38]) for (const amount of [0n, 1n, 99n, 100000000000000001n, UINT256_MAX]) expect(parseAssetAmount(formatAssetAmount(amount, decimals), decimals)).toBe(amount);
    for (const bad of ['-1', '+1', '1e18', '.1', '1.', 'NaN']) expect(() => parseAssetAmount(bad, 18)).toThrow();
    expect(() => parseAssetAmount((UINT256_MAX + 1n).toString(), 0)).toThrow();
  });
});
describe('inclusive native settlement', () => {
  it('agrees with independent golden vectors for tiny remainders and full shares', () => {
    expect(splitExecutionFee(100000n, 100, 'liquidity_burn')).toMatchObject({ fee: 1000n, net: 99000n, platform: 200n, liquidity: 600n, burn: 200n });
    expect(splitExecutionFee(100n, 100, 'liquidity_burn')).toMatchObject({ fee: 1n, platform: 0n, destination: 1n, liquidity: 0n, burn: 1n });
    expect(splitNftSettlement(10000n, 1000)).toEqual({ total: 10000n, platform: 200n, royalty: 1000n, seller: 8800n });
  });
  it('conserves every unit across both modes, all allowed rates and large amounts', () => {
    for (let rate = 100; rate <= 500; rate++) for (const mode of ['creator', 'liquidity_burn'] as const) for (const gross of [0n, 1n, 99n, 101n, 99999n, UINT256_MAX]) {
      const value = splitExecutionFee(gross, rate, mode);
      expect(value.net + value.platform + value.creator + value.liquidity + value.burn).toBe(gross);
      expect(value.creator + value.liquidity + value.burn).toBe(value.destination);
    }
    for (const amount of [0n, 1n, 49n, 50n, UINT256_MAX]) { const split = splitNftSettlement(amount, 1000); expect(split.platform + split.royalty + split.seller).toBe(amount); }
  });
  it('rejects altered product terms and non-EVM amounts', () => {
    for (const fee of [99, 501, 100.5, NaN]) expect(() => splitExecutionFee(1n, fee, 'creator')).toThrow();
    expect(() => splitNftSettlement(1n, 1001)).toThrow(); expect(() => splitNftSettlement(-1n)).toThrow();
  });
});
