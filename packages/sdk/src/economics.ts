import type { FeeMode, TokenLaunchPolicy, TradeSide } from "./types";

export const ECONOMICS = Object.freeze({
  tokenDecimals: 8 as const,
  tokenSupplyRaw: "100000000000000000" as const,
  tokenSupply: 1_000_000_000,
  platformShareBps: 2000 as const,
  creatorFeeMinBps: 100,
  creatorFeeMaxBps: 500,
  defaultDexFeeBps: 25,
  nftPlatformFeeBps: 200 as const,
  liquidityShareOfDestinationBps: 7500,
  quoteTtlMs: 30_000,
});
export const BPS = 10_000n;
export const MAX_U64 = (1n << 64n) - 1n;

export function assertNonNegative(value: bigint, name = "amount"): void {
  if (value < 0n) throw new RangeError(`${name} must be non-negative`);
}

export function assertBps(value: number, maximum = 10_000): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Basis points must be an integer from 0 to ${maximum}`);
  }
}

export function assertCreatorFeeBps(value: number): void {
  assertBps(value, ECONOMICS.creatorFeeMaxBps);
  if (value < ECONOMICS.creatorFeeMinBps) throw new RangeError("Creator execution fee must be 100–500 basis points");
}

/** Exact decimal parsing: scientific notation, signs and excess precision are rejected. */
export function parseUnits(value: string, decimals: number = ECONOMICS.tokenDecimals): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new RangeError("Invalid decimal precision");
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new RangeError("Enter a positive decimal amount");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new RangeError(`Amount supports at most ${decimals} decimals`);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatUnits(amount: bigint, decimals: number = ECONOMICS.tokenDecimals): string {
  assertNonNegative(amount);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new RangeError("Invalid decimal precision");
  if (decimals === 0) return amount.toString();
  const padded = amount.toString().padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

export function assertU64Amount(amount: bigint): bigint {
  if (amount < 0n || amount > MAX_U64) throw new RangeError("Amount is outside the Move u64 range");
  return amount;
}

/** Collection floors to the base unit, matching Move. Sub-octa fees are zero. */
export function feeFromGross(gross: bigint, feeBps: number): bigint {
  assertNonNegative(gross);
  assertBps(feeBps);
  return gross * BigInt(feeBps) / BPS;
}

/** Smallest fee giving exactly this net under floor-rounded collection; normal trades are exact input. */
export function feeAddedToNet(net: bigint, feeBps: number): bigint {
  assertNonNegative(net);
  assertBps(feeBps, 9999);
  const denominator = BPS - BigInt(feeBps);
  return net === 0n ? 0n : (net - 1n) * BigInt(feeBps) / denominator;
}

export interface FeeSplit {
  total: bigint;
  platform: bigint;
  destination: bigint;
  creator: bigint;
  liquidity: bigint;
  burn: bigint;
}

/** Platform floors to 20%; destination gets the remainder. No referral carve-out. */
export function splitCollectedFee(total: bigint, mode: FeeMode): FeeSplit {
  assertNonNegative(total);
  if (mode !== "creator" && mode !== "liquidity_burn") throw new RangeError("Unsupported fee mode");
  const platform = total * 2000n / BPS;
  const destination = total - platform;
  const liquidity = mode === "liquidity_burn" ? destination * 7500n / BPS : 0n;
  return {
    total,
    platform,
    destination,
    creator: mode === "creator" ? destination : 0n,
    liquidity,
    burn: mode === "liquidity_burn" ? destination - liquidity : 0n,
  };
}

/** Input MUST be actual net APT after all non-APT LP earnings have been converted. */
export function splitNetAptEarnings(netApt: bigint, mode: FeeMode): FeeSplit {
  return splitCollectedFee(netApt, mode);
}

/** Buy input is total APT paid. Sell input here is gross APT returned by the DEX. */
export function calculateTradeAmounts(side: TradeSide, grossApt: bigint, creatorFeeBps: number) {
  assertCreatorFeeBps(creatorFeeBps);
  assertU64Amount(grossApt);
  if (side !== "buy" && side !== "sell") throw new RangeError("Unsupported trade side");
  const fee = feeFromGross(grossApt, creatorFeeBps);
  return {
    side,
    grossApt,
    fee,
    poolApt: side === "buy" ? grossApt - fee : grossApt,
    userApt: side === "buy" ? grossApt : grossApt - fee,
  };
}

/** NFT listed/mint price includes the 2% B20 fee. Royalties are deducted separately. */
export function splitNftSale(grossApt: bigint, royaltyBps = 0) {
  assertU64Amount(grossApt);
  assertBps(royaltyBps, 9800);
  const platform = feeFromGross(grossApt, ECONOMICS.nftPlatformFeeBps);
  const royalty = grossApt * BigInt(royaltyBps) / BPS;
  if (platform + royalty > grossApt) throw new RangeError("Price is too small to cover fees");
  return { gross: grossApt, platform, royalty, seller: grossApt - platform - royalty };
}

/** Primary mint charges 2% on the entire batch; per-token events conserve that amount. */
export function splitNftMintBatch(unitPrice: bigint, quantity: number) {
  assertU64Amount(unitPrice);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new RangeError("Invalid mint batch size");
  const total = assertU64Amount(unitPrice * BigInt(quantity));
  const platform = feeFromGross(total, ECONOMICS.nftPlatformFeeBps);
  const feePerToken = platform / BigInt(quantity);
  const extraTokens = platform % BigInt(quantity);
  return {
    total,
    platform,
    creator: total - platform,
    allocations: Array.from({ length: quantity }, (_, index) => {
      const fee = feePerToken + (BigInt(index) < extraTokens ? 1n : 0n);
      return { price: unitPrice, platform: fee, creator: unitPrice - fee };
    }),
  };
}

/** Allowed rates are a reviewed deployment setting, NOT proof of DEX availability. */
export function createLaunchPolicy(input: { creatorFeeBps: number; feeMode: FeeMode; dexFeeBps?: number }, supportedDexFeeBps: readonly number[] = [25]): TokenLaunchPolicy {
  assertCreatorFeeBps(input.creatorFeeBps);
  const dexFeeBps = input.dexFeeBps ?? ECONOMICS.defaultDexFeeBps;
  assertBps(dexFeeBps, 1000);
  if (!supportedDexFeeBps.includes(dexFeeBps)) throw new RangeError("DEX fee tier is not configured for new launches");
  if (input.feeMode !== "creator" && input.feeMode !== "liquidity_burn") throw new RangeError("Unsupported fee mode");
  return Object.freeze({ ...input, dexFeeBps, platformShareBps: 2000, decimals: 8, supplyRaw: ECONOMICS.tokenSupplyRaw, mutable: false });
}
