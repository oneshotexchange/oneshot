import type { TokenPoolSwap } from '@oneshot/evm';
import { tokenPriceChartNumber, type NativeRawTokenPrice } from './token-price';

export type TokenPricePoint = { time: number; value: number; price: NativeRawTokenPrice; transactionHash: string; blockNumber: string; logIndex: number };

/** Last observed swap per second, ordered by block/log rather than rounded financial values. */
export function tokenPoolChartPoints(swaps: readonly TokenPoolSwap[]): TokenPricePoint[] {
  const bySecond = new Map<number, TokenPricePoint>();
  const chronological = [...swaps].sort((left, right) => BigInt(left.blockNumber) === BigInt(right.blockNumber) ? left.logIndex - right.logIndex : BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1);
  for (const swap of chronological) {
    const seconds = BigInt(swap.timestamp); if (seconds > 8640000000000n) continue;
    const sqrt = BigInt(swap.sqrtPriceX96Raw), price = { numerator: (2n ** 192n * 100000000n).toString(), denominator: (sqrt * sqrt).toString() };
    const value = tokenPriceChartNumber(price); if (value === null) continue;
    const time = Number(seconds); bySecond.set(time, { time, value, price, transactionHash: swap.transactionHash, blockNumber: swap.blockNumber, logIndex: swap.logIndex });
  }
  return [...bySecond.values()].sort((left, right) => left.time - right.time);
}
