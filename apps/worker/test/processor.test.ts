import { describe, expect, it, vi } from "vitest";
import { decodeBatch, processResponse } from "../src/processor";
import { decodeChainEvent } from "../src/decoder";
import type { TransactionsResponse } from "../src/vendor/aptos/indexer/v1/raw_data";

const source = { b20PackageAddress: "0xbeef" };
const limits = { maxEventsPerTransaction: 10, maxEventDataBytes: 4096, maxTransactionsPerBatch: 10 };
const collectionData = { collection: "0x1", creator: "0x2", name: "Example", max_supply: "10", royalty_bps: "500" };
function response(): TransactionsResponse {
  return { chainId: 2n, processedRange: { firstVersion: 9007199254740993n, lastVersion: 9007199254741000n }, transactions: [{ version: 9007199254740993n, timestamp: { seconds: 1n, nanos: 123_000 }, info: { success: true, hash: new Uint8Array(32).fill(1) }, user: { events: [
    { typeStr: "0x1::other::Generic<0x1::other::T>", data: "{}" },
    { typeStr: "0xbeef::nft_launch::CollectionCreated", data: JSON.stringify(collectionData) },
  ] } }] };
}

describe("filtered stream processing", () => {
  it("preserves original event indices and bigint cursor values", () => {
    const batch = decodeBatch(response(), 2, source, limits);
    expect(batch.nextVersion).toBe("9007199254741001");
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.eventIndex).toBe(1);
    expect(batch.events[0]?.transactionVersion).toBe("9007199254740993");
    expect(batch.events[0]?.timestampMicros).toBe("1000123");
  });

  it("advances empty filtered ranges only when the server declares coverage", async () => {
    const store = { getNextVersion: vi.fn(), commitBatch: vi.fn().mockResolvedValue(undefined) };
    await processResponse({ chainId: 2n, transactions: [], processedRange: { firstVersion: 100n, lastVersion: 999n } }, store, 2, source, limits);
    expect(store.commitBatch).toHaveBeenLastCalledWith({ chainId: 2, events: [], nextVersion: "1000" });
    store.commitBatch.mockClear();
    await processResponse({ chainId: 2n, transactions: [] }, store, 2, source, limits);
    expect(store.commitBatch).not.toHaveBeenCalled();
  });

  it("rejects wrong chains, unreviewed B20 events, inverted ranges and oversized JSON before storage", async () => {
    const store = { getNextVersion: vi.fn(), commitBatch: vi.fn() };
    await expect(processResponse({ ...response(), chainId: 1n }, store, 2, source, limits)).rejects.toThrow("chain ID");
    expect(store.commitBatch).not.toHaveBeenCalled();
    const unknown = response();
    unknown.transactions![0]!.user!.events![1]!.typeStr = "0xbeef::nft_launch::Unknown";
    expect(() => decodeBatch(unknown, 2, source, limits)).toThrow("no reviewed decoder");
    expect(() => decodeBatch({ chainId: 2n, processedRange: { firstVersion: 10n, lastVersion: 9n } }, 2, source, limits)).toThrow("inverted");
    expect(() => decodeBatch(response(), 2, source, { ...limits, maxEventDataBytes: 2 })).toThrow("size bound");
  });

  it("rejects accounting events that would invent or lose APT", () => {
    expect(() => decodeChainEvent({ chainId: 2, transactionVersion: "10", eventIndex: 0, transactionHash: "0x01", timestampMicros: "100", type: "0xbeef::nft_launch::Minted", data: { collection: "0x1", token: "0x2", minter: "0x3", serial: "1", price_octas: "100", platform_fee_octas: "2", creator_proceeds_octas: "99" } }, source)).toThrow("conserve");
  });
});
