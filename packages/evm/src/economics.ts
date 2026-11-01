export const UINT256_MAX = (1n << 256n) - 1n;
export const TOKEN_DECIMALS = 8;
export const TOKEN_SUPPLY_RAW = 100000000000000000n;
const BPS = 10000n;
export type FeeMode = 'creator' | 'liquidity_burn';

export function uint256(amount: bigint): bigint {
  if (amount < 0n || amount > UINT256_MAX) throw new RangeError('Amount is outside uint256');
  return amount;
}
function precision(decimals: number | null): number {
  if (decimals === null) throw new Error('Native asset precision is not verified');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new RangeError('Invalid asset precision');
  return decimals;
}
export function parseAssetAmount(value: string, decimals: number | null): bigint {
  const scale = precision(decimals);
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new RangeError('Use an unsigned decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new RangeError(`Amount supports at most ${scale} decimals`);
  return uint256(BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0'));
}
export function formatAssetAmount(value: bigint, decimals: number | null): string {
  uint256(value); const scale = precision(decimals);
  if (scale === 0) return value.toString();
  const raw = value.toString().padStart(scale + 1, '0');
  const fraction = raw.slice(-scale).replace(/0+$/, '');
  return `${raw.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`;
}
export function splitExecutionFee(gross: bigint, feeBps: number, mode: FeeMode) {
  uint256(gross);
  if (!Number.isInteger(feeBps) || feeBps < 100 || feeBps > 500) throw new RangeError('Execution fee must be 100–500 bps');
  if (mode !== 'creator' && mode !== 'liquidity_burn') throw new RangeError('Invalid fee mode');
  const fee = gross * BigInt(feeBps) / BPS;
  const platform = fee * 2000n / BPS;
  const destination = fee - platform;
  const liquidity = mode === 'liquidity_burn' ? destination * 7500n / BPS : 0n;
  return { gross, net: gross - fee, fee, platform, destination, creator: mode === 'creator' ? destination : 0n, liquidity, burn: mode === 'liquidity_burn' ? destination - liquidity : 0n };
}
export function splitNftSettlement(total: bigint, royaltyBps = 0) {
  uint256(total);
  if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 1000) throw new RangeError('Royalty must be 0–1000 bps');
  const platform = total * 200n / BPS;
  const royalty = total * BigInt(royaltyBps) / BPS;
  return { total, platform, royalty, seller: total - platform - royalty };
}
