/** Prices are rational native base units per whole token, never a JavaScript financial float. */
export type NativeRawTokenPrice = { numerator: string; denominator: string };
export type TokenPriceDisplay = { text: string; approximate: boolean; belowPrecision: boolean };
const integer = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 256;

export function validNativeRawTokenPrice(value: unknown): value is NativeRawTokenPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const price = value as NativeRawTokenPrice;
  return integer(price.numerator) && price.numerator !== '0' && integer(price.denominator) && price.denominator !== '0';
}
export function nativeTokenPriceMatchesSqrt(price: unknown, sqrtPriceX96Raw: unknown) {
  if (!validNativeRawTokenPrice(price) || !integer(sqrtPriceX96Raw) || sqrtPriceX96Raw === '0') return false;
  const sqrt = BigInt(sqrtPriceX96Raw);
  return sqrt < 2n ** 160n && BigInt(price.numerator) * sqrt * sqrt === (2n ** 192n * 100000000n) * BigInt(price.denominator);
}

/** Display precision is explicit. Nonzero dust prices never become a fabricated zero. */
export function tokenPriceDisplay(price: NativeRawTokenPrice, precision = 18): TokenPriceDisplay {
  if (!validNativeRawTokenPrice(price) || !Number.isInteger(precision) || precision < 0 || precision > 36) throw new Error('This token price could not be verified.');
  const denominator = BigInt(price.denominator) * 10n ** 18n, scaled = BigInt(price.numerator) * 10n ** BigInt(precision);
  const quotient = scaled / denominator, remainder = scaled % denominator;
  if (!quotient) return { text: precision === 0 ? '<1' : `<0.${'0'.repeat(precision - 1)}1`, approximate: true, belowPrecision: true };
  const digits = quotient.toString().padStart(precision + 1, '0');
  const text = precision === 0 ? digits : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(/\.?0+$/, '');
  return { text, approximate: remainder !== 0n, belowPrecision: false };
}

/** The chart alone uses an approximate float; callers must retain exact prices for customer amounts. */
export function tokenPriceChartNumber(price: NativeRawTokenPrice): number | null {
  if (!validNativeRawTokenPrice(price)) return null;
  const result = Number(price.numerator) / Number(price.denominator) / 1e18;
  return Number.isFinite(result) && result > 0 ? result : null;
}
