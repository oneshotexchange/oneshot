import { ECONOMICS, assertBps, assertCreatorFeeBps, assertU64Amount } from "./economics";
import { normalizeAddress } from "./config";
import type { AptosAddress, NetworkIdentity, RawAmount, TradeSide, TransactionVersion } from "./types";

export interface TradeQuote extends NetworkIdentity {
  id: string;
  tokenAddress: AptosAddress;
  poolAddress: AptosAddress;
  ledgerVersion: TransactionVersion;
  side: TradeSide;
  amountInRaw: RawAmount;
  amountOutRaw: RawAmount;
  minAmountOutRaw: RawAmount;
  creatorFeeAptRaw: RawAmount;
  dexFeeRaw: RawAmount;
  creatorFeeBps: number;
  dexFeeBps: number;
  quotedAtMs: number;
  expiresAtMs: number;
  fullFillOnly: true;
}

export class QuotePolicyError extends Error {
  constructor(readonly code: "expired_quote" | "partial_fill" | "chain_mismatch" | "invalid_quote" | "slippage", message: string) {
    super(message);
    this.name = "QuotePolicyError";
  }
}

export function minimumOutput(outputRaw: bigint, slippageBps: number): bigint {
  assertU64Amount(outputRaw);
  assertBps(slippageBps, 5000);
  return outputRaw * BigInt(10_000 - slippageBps) / 10_000n;
}

export function validateQuote(quote: TradeQuote, expected: NetworkIdentity, nowMs = Date.now()): void {
  if (quote.network !== expected.network || quote.chainId !== expected.chainId) throw new QuotePolicyError("chain_mismatch", "Quote belongs to a different network");
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(quote.quotedAtMs) || !Number.isSafeInteger(quote.expiresAtMs)
    || quote.expiresAtMs <= quote.quotedAtMs || quote.expiresAtMs - quote.quotedAtMs > ECONOMICS.quoteTtlMs || nowMs < quote.quotedAtMs) {
    throw new QuotePolicyError("invalid_quote", "Invalid quote validity window");
  }
  if (nowMs >= quote.expiresAtMs) throw new QuotePolicyError("expired_quote", "Quote expired; request a new quote");
  try {
    normalizeAddress(quote.tokenAddress);
    normalizeAddress(quote.poolAddress);
    assertCreatorFeeBps(quote.creatorFeeBps);
    assertBps(quote.dexFeeBps, 1000);
    if (quote.dexFeeBps < 1 || (quote.side !== "buy" && quote.side !== "sell")) throw new Error("invalid trading policy");
    for (const value of [quote.amountInRaw, quote.amountOutRaw, quote.minAmountOutRaw, quote.creatorFeeAptRaw, quote.dexFeeRaw, quote.ledgerVersion]) {
      if (!/^\d+$/.test(value)) throw new Error("invalid integer");
      assertU64Amount(BigInt(value));
    }
    if (BigInt(quote.amountInRaw) === 0n || BigInt(quote.amountOutRaw) === 0n || BigInt(quote.minAmountOutRaw) === 0n || BigInt(quote.minAmountOutRaw) > BigInt(quote.amountOutRaw) || quote.fullFillOnly !== true) throw new Error("invalid amounts");
  } catch {
    throw new QuotePolicyError("invalid_quote", "Quote amounts or fill policy are invalid");
  }
}

/** A fresh simulation may improve output, but cannot lower the floor already displayed. */
export function validateFullFill(quote: TradeQuote, simulation: { amountInUsedRaw: RawAmount; amountOutRaw: RawAmount }, expected: NetworkIdentity, nowMs = Date.now()): void {
  validateQuote(quote, expected, nowMs);
  if (!/^\d+$/.test(simulation.amountInUsedRaw) || !/^\d+$/.test(simulation.amountOutRaw)) throw new QuotePolicyError("invalid_quote", "Simulation amounts are invalid");
  if (BigInt(simulation.amountInUsedRaw) !== BigInt(quote.amountInRaw)) throw new QuotePolicyError("partial_fill", "The complete input could not be filled");
  if (BigInt(simulation.amountOutRaw) < BigInt(quote.minAmountOutRaw)) throw new QuotePolicyError("slippage", "Simulation output is below your displayed minimum");
}
