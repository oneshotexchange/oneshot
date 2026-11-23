import { describe, expect, it } from 'vitest';
import type { TokenPoolSwap } from '@oneshot/evm';
import { tokenPoolChartPoints, tokenPoolOhlcCandles } from './token-price-chart';

const Q96 = 1n << 96n;

function makeSwap(overrides: {
  blockNumber: string;
  logIndex: number;
  timestamp: string;
  sqrtMultiplierNumerator: bigint;
  sqrtMultiplierDenominator?: bigint;
  amount0Raw: string;
}): TokenPoolSwap {
  const denom = overrides.sqrtMultiplierDenominator ?? 1n;
  const sqrt = (Q96 * overrides.sqrtMultiplierNumerator) / denom;
  return {
    id: `swap-${overrides.blockNumber}-${overrides.logIndex}`,
    kind: 'pool-swap',
    market: `0x${'11'.repeat(20)}`,
    poolId: `0x${'22'.repeat(32)}`,
    poolSender: `0x${'33'.repeat(20)}`,
    trader: null,
    recipient: null,
    blockNumber: overrides.blockNumber,
    blockHash: `0x${'44'.repeat(32)}`,
    timestamp: overrides.timestamp,
    transactionHash: `0x${'55'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: overrides.logIndex,
    amount0Raw: overrides.amount0Raw,
    amount1Raw: '1000',
    sqrtPriceX96Raw: sqrt.toString(),
    liquidityRaw: '1000000',
    tick: 0,
    feePips: 2500,
  };
}

describe('token-price-chart OHLCV aggregation', () => {
  it('groups chronological swaps into exact OHLCV buckets without synthesizing empty candles', () => {
    // Out-of-order input within same 15m bucket (1800..2699) and a later bucket (3600) after a gap
    const swaps: TokenPoolSwap[] = [
      // Swap 2 (middle price)
      makeSwap({
        blockNumber: '12',
        logIndex: 1,
        timestamp: '1850',
        sqrtMultiplierNumerator: 1n,
        amount0Raw: '500000000000000000',
      }),
      // Swap 1 (highest sqrt => lowest token price in this orientation: denominator = sqrt^2)
      makeSwap({
        blockNumber: '12',
        logIndex: 0,
        timestamp: '1810',
        sqrtMultiplierNumerator: 2n,
        amount0Raw: '-250000000000000000',
      }),
      // Swap 3 (lowest sqrt => highest token price in bucket 1)
      makeSwap({
        blockNumber: '13',
        logIndex: 0,
        timestamp: '1900',
        sqrtMultiplierNumerator: 1n,
        sqrtMultiplierDenominator: 2n,
        amount0Raw: '100000000000000000',
      }),
      // Swap 4 in second bucket after a 15-minute gap (time = 3600)
      makeSwap({
        blockNumber: '20',
        logIndex: 0,
        timestamp: '3660',
        sqrtMultiplierNumerator: 1n,
        amount0Raw: '-300000000000000000',
      }),
    ];

    const candles = tokenPoolOhlcCandles(swaps, '15m');
    expect(candles).toHaveLength(2);

    const first = candles[0]!;
    expect(first.time).toBe(1800);
    expect(first.swapCount).toBe(3);
    expect(first.nativeVolumeRaw).toBe('850000000000000000');
    expect(first.open).toBeLessThan(first.close);
    expect(first.low).toBe(first.open);
    expect(first.high).toBe(first.close);

    const second = candles[1]!;
    expect(second.time).toBe(3600);
    expect(second.swapCount).toBe(1);
    expect(second.nativeVolumeRaw).toBe('300000000000000000');
    expect(second.open).toBe(second.high);
    expect(second.open).toBe(second.low);
    expect(second.open).toBe(second.close);
  });

  it('re-buckets swaps cleanly across 5m and 1h intervals and preserves line point compatibility', () => {
    const swaps = [
      makeSwap({
        blockNumber: '1',
        logIndex: 0,
        timestamp: '300',
        sqrtMultiplierNumerator: 1n,
        amount0Raw: '100',
      }),
      makeSwap({
        blockNumber: '2',
        logIndex: 0,
        timestamp: '610',
        sqrtMultiplierNumerator: 1n,
        amount0Raw: '-200',
      }),
    ];
    expect(tokenPoolChartPoints(swaps)).toHaveLength(2);
    expect(tokenPoolOhlcCandles(swaps, '5m')).toHaveLength(2);
    expect(tokenPoolOhlcCandles(swaps, '1h')).toEqual([
      expect.objectContaining({
        time: 0,
        nativeVolumeRaw: '300',
        swapCount: 2,
      }),
    ]);
  });
});
