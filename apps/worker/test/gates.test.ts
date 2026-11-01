import { describe, expect, it, vi } from "vitest";
import { parseEnvironmentConfig } from "@b20/sdk";
import { abiFingerprint } from "../src/verification";
import { runKeeper } from "../src/keeper";
import { transactionFilter } from "../src/stream";

describe("deployment and execution gates", () => {
  it("creates one success/event-source filter without entry-function assumptions", () => {
    const filter = transactionFilter("0xbeef", "0xcafe");
    expect(filter.logicalAnd?.filters).toHaveLength(2);
    const sources = filter.logicalAnd?.filters?.[1]?.logicalOr?.filters;
    expect(sources).toHaveLength(2);
    expect(sources?.[1]?.apiFilter?.eventFilter?.structType?.module).toBe("pool_v3");
    expect(JSON.stringify(filter)).not.toContain("entryFunction");
  });

  it("canonicalizes ABI module order while detecting a changed function", () => {
    const first = { address: "0xbeef", name: "nft_launch", exposed_functions: [{ name: "mint_nft" }] };
    const second = { address: "0xbeef", name: "marketplace", exposed_functions: [{ name: "buy" }] };
    expect(abiFingerprint([first, second])).toBe(abiFingerprint([second, first]));
    expect(abiFingerprint([first, second])).not.toBe(abiFingerprint([first, { ...second, exposed_functions: [{ name: "withdraw" }] }]));
  });

  it("never initializes a signer or runs jobs with missing configuration", async () => {
    const adapter = { signerAddress: vi.fn(), readRegisteredJobs: vi.fn(), simulate: vi.fn(), execute: vi.fn() };
    const status = vi.fn();
    await runKeeper(parseEnvironmentConfig({ B20_KEEPER_ENABLED: "true" }), undefined, adapter, new AbortController().signal, status);
    expect(adapter.signerAddress).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ state: "disabled", message: expect.stringContaining("Keeper signer is missing") }));
  });
});
