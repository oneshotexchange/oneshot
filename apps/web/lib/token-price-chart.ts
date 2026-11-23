import type { TokenPoolSwap } from '@oneshot/evm';
import { tokenPriceChartNumber, type NativeRawTokenPrice } from './token-price';

export type TokenPricePoint = {
  time: number;
  value: number;
  price: NativeRawTokenPrice;
  transactionHash: string;
  blockNumber: string;
  logIndex: number;
};

export type TokenCandleInterval = '5m' | '15m' | '1h' | '1d';

export const TOKEN_CANDLE_INTERVAL_SECONDS: Record<TokenCandleInterval, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

export type TokenOhlcCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  nativeVolumeRaw: string;
  swapCount: number;
};

function compareChronological(left: TokenPoolSwap, right: TokenPoolSwap): number {
  const leftBlock = BigInt(left.blockNumber);
  const rightBlock = BigInt(right.blockNumber);
  if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
  return left.logIndex - right.logIndex;
}

function swapPrice(sqrtPriceX96Raw: string): { value: number; price: NativeRawTokenPrice } | null {
  const sqrt = BigInt(sqrtPriceX96Raw);
  if (sqrt <= 0n) return null;
  const price: NativeRawTokenPrice = {
    numerator: (2n ** 192n * 100000000n).toString(),
    denominator: (sqrt * sqrt).toString(),
  };
  const value = tokenPriceChartNumber(price);
  if (value === null || !Number.isFinite(value)) return null;
  return { value, price };
}

/** Last observed swap per second, ordered by block/log rather than rounded financial values. */
export function tokenPoolChartPoints(swaps: readonly TokenPoolSwap[]): TokenPricePoint[] {
  const bySecond = new Map<number, TokenPricePoint>();
  const chronological = [...swaps].sort(compareChronological);
  for (const swap of chronological) {
    const seconds = BigInt(swap.timestamp);
    if (seconds > 8640000000000n) continue;
    const computed = swapPrice(swap.sqrtPriceX96Raw);
    if (!computed) continue;
    const time = Number(seconds);
    bySecond.set(time, {
      time,
      value: computed.value,
      price: computed.price,
      transactionHash: swap.transactionHash,
      blockNumber: swap.blockNumber,
      logIndex: swap.logIndex,
    });
  }
  return [...bySecond.values()].sort((left, right) => left.time - right.time);
}

/**
 * Aggregate observed pool swaps into OHLCV buckets without synthesizing empty gap candles.
 * Preserves exact native raw sums as strings for financial readouts.
 */
export function tokenPoolOhlcCandles(
  swaps: readonly TokenPoolSwap[],
  interval: TokenCandleInterval = '15m',
  nativeDecimals = 18,
): TokenOhlcCandle[] {
  const step = TOKEN_CANDLE_INTERVAL_SECONDS[interval];
  const scale = 10 ** nativeDecimals;
  const buckets = new Map<
    number,
    { open: number; high: number; low: number; close: number; nativeVolume: bigint; swapCount: number }
  >();
  const chronological = [...swaps].sort(compareChronological);

  for (const swap of chronological) {
    const seconds = BigInt(swap.timestamp);
    if (seconds < 0n || seconds > 8640000000000n) continue;
    const computed = swapPrice(swap.sqrtPriceX96Raw);
    if (!computed) continue;

    const bucketTime = Math.floor(Number(seconds) / step) * step;
    const amount0 = BigInt(swap.amount0Raw);
    const absNative = amount0 < 0n ? -amount0 : amount0;

    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, {
        open: computed.value,
        high: computed.value,
        low: computed.value,
        close: computed.value,
        nativeVolume: absNative,
        swapCount: 1,
      });
    } else {
      existing.high = Math.max(existing.high, computed.value);
      existing.low = Math.min(existing.low, computed.value);
      existing.close = computed.value;
      existing.nativeVolume += absNative;
      existing.swapCount += 1;
    }
  }

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([time, bucket]) => {
      const volume = Number(bucket.nativeVolume) / scale;
      return {
        time,
        open: bucket.open,
        high: bucket.high,
        low: bucket.low,
        close: bucket.close,
        volume: Number.isFinite(volume) ? volume : 0,
        nativeVolumeRaw: bucket.nativeVolume.toString(),
        swapCount: bucket.swapCount,
      };
    });
}
