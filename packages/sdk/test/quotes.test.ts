import { describe, expect, it } from "vitest";
import { indexerDisabledReasons, parseEnvironmentConfig, validateFullFill, validateQuote, type TradeQuote } from "../src/index";

const network = { network: "testnet" as const, chainId: 2 };
const quote: TradeQuote = { ...network, id: "q1", tokenAddress: "0x1", poolAddress: "0x2", ledgerVersion: "9007199254740993", side: "buy", amountInRaw: "9007199254740993", amountOutRaw: "100000000000", minAmountOutRaw: "99000000000", creatorFeeAptRaw: "90071992547409", dexFeeRaw: "2500", creatorFeeBps: 100, dexFeeBps: 25, quotedAtMs: 1_000_000, expiresAtMs: 1_030_000, fullFillOnly: true };

describe("quote and startup policy", () => {
  it("expires at the exact deadline and never accepts a lower refreshed minimum", () => {
    expect(() => validateQuote(quote, network, 1_029_999)).not.toThrow();
    expect(() => validateQuote(quote, network, 1_030_000)).toThrow("expired");
    expect(() => validateFullFill(quote, { amountInUsedRaw: quote.amountInRaw, amountOutRaw: "98999999999" }, network, 1_001_000)).toThrow("minimum");
    expect(() => validateFullFill(quote, { amountInUsedRaw: "9007199254740992", amountOutRaw: quote.amountOutRaw }, network, 1_001_000)).toThrow("complete input");
  });

  it("rejects a chain mismatch before any submission", () => {
    expect(() => validateQuote(quote, { network: "localnet", chainId: 4 }, 1_001_000)).toThrow("different network");
  });

  it("does not enable the worker or Hyperion from partial configuration", () => {
    const defaults = parseEnvironmentConfig({});
    expect(defaults.B20_WORKER_ENABLED).toBe(false);
    expect(defaults.HYPERION_ENABLED).toBe(false);
    expect(indexerDisabledReasons(defaults)).toEqual(["B20_WORKER_ENABLED is false"]);
    const enabled = parseEnvironmentConfig({ B20_WORKER_ENABLED: "true" });
    expect(indexerDisabledReasons(enabled)).toContain("GEOMI_API_KEY is missing");
    expect(() => parseEnvironmentConfig({ B20_WORKER_ENABLED: "yes" })).toThrow();
    expect(() => parseEnvironmentConfig({ APTOS_CHAIN_ID: "1" })).toThrow();
  });
});
