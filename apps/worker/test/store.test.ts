import { describe, expect, it } from "vitest";
import type { DecodedChainEvent } from "@b20/sdk";
import { PostgresEventStore, type QueryResult, type SqlClient } from "../src/store";

/** Injectable transaction adapter models durable commit/rollback, not business projections. */
class TransactionAdapter implements SqlClient {
  durable = { keys: new Set<string>(), projections: 0, next: "100" };
  pending?: typeof this.durable;
  statements: string[] = [];
  failAtProjection?: number;
  releaseCount = 0;
  async query(sql: string, values: unknown[] = []): Promise<QueryResult> {
    this.statements.push(sql);
    const result = (rowCount = 1, rows: Record<string, unknown>[] = []): QueryResult => ({ rowCount, rows });
    if (sql.startsWith("SELECT pg_try_advisory_lock")) return result(1, [{ acquired: true }]);
    if (sql.startsWith("SELECT pg_advisory_unlock") || sql.includes("CREATE TABLE") || sql.startsWith("INSERT INTO b20_indexer_checkpoint")) return result();
    if (sql.startsWith("SELECT next_version")) return result(1, [{ next_version: this.durable.next }]);
    if (sql.startsWith("SELECT 1 AS registered")) return result(0);
    if (sql === "BEGIN") { this.pending = { ...this.durable, keys: new Set(this.durable.keys) }; return result(); }
    if (sql === "COMMIT") { if (!this.pending) throw new Error("No transaction"); this.durable = this.pending; this.pending = undefined; return result(); }
    if (sql === "ROLLBACK") { this.pending = undefined; return result(); }
    if (!this.pending) throw new Error("Projection write outside a transaction");
    if (sql.startsWith("INSERT INTO b20_chain_events")) {
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      if (this.pending.keys.has(key)) return result(0);
      this.pending.keys.add(key);
      return result();
    }
    if (sql.startsWith("INSERT INTO b20_collections")) {
      if (this.pending.projections + 1 === this.failAtProjection) throw new Error("Injected projection failure");
      this.pending.projections++;
      return result();
    }
    if (sql.startsWith("UPDATE b20_indexer_checkpoint")) {
      if (BigInt(String(values[2])) > BigInt(this.pending.next)) this.pending.next = String(values[2]);
      return result();
    }
    throw new Error(`Unexpected SQL in adapter: ${sql}`);
  }
  release() { this.releaseCount++; }
}

function created(version: string, address = "0x01"): DecodedChainEvent {
  return { chainId: 2, transactionVersion: version, eventIndex: 0, transactionHash: "0x01", timestampMicros: "10", type: "0xbeef::nft_launch::CollectionCreated", kind: "nft_launch::CollectionCreated", data: { collection: address as `0x${string}`, creator: "0x02", name: "Example", max_supply: "10", royalty_bps: "500" } };
}

describe("transactional event store", () => {
  it("replays a committed batch without applying projections twice", async () => {
    const adapter = new TransactionAdapter();
    const store = new PostgresEventStore({ connect: async () => adapter }, 2, "test", "100");
    await store.initialize();
    const batch = { chainId: 2, events: [created("100")], nextVersion: "101" };
    await store.commitBatch(batch);
    await store.commitBatch(batch);
    expect(adapter.durable.projections).toBe(1);
    expect(adapter.durable.keys.size).toBe(1);
    expect(await store.getNextVersion()).toBe("101");
    await store.close();
    expect(adapter.releaseCount).toBe(1);
  });

  it("rolls back raw events, projections and checkpoint together after partial failure", async () => {
    const adapter = new TransactionAdapter();
    adapter.failAtProjection = 2;
    const store = new PostgresEventStore({ connect: async () => adapter }, 2, "test", "100");
    await store.initialize();
    await expect(store.commitBatch({ chainId: 2, events: [created("100"), created("101", "0x03")], nextVersion: "102" })).rejects.toThrow("Injected");
    expect(adapter.durable.keys.size).toBe(0);
    expect(adapter.durable.projections).toBe(0);
    expect(adapter.durable.next).toBe("100");
    expect(adapter.statements.at(-1)).toBe("ROLLBACK");
    await store.close();
  });

  it("advances covered empty ranges, never moves a cursor backwards, and rejects cross-chain data", async () => {
    const adapter = new TransactionAdapter();
    const store = new PostgresEventStore({ connect: async () => adapter }, 2, "test", "100");
    await store.initialize();
    await store.commitBatch({ chainId: 2, events: [], nextVersion: "9007199254740994" });
    await store.commitBatch({ chainId: 2, events: [], nextVersion: "100" });
    expect(adapter.durable.next).toBe("9007199254740994");
    await expect(store.commitBatch({ chainId: 1, events: [], nextVersion: "9007199254740995" })).rejects.toThrow("Chain ID");
    await store.close();
  });

  it("does not persist unrelated Hyperion events for unregistered pools", async () => {
    const adapter = new TransactionAdapter();
    const store = new PostgresEventStore({ connect: async () => adapter }, 2, "test", "100");
    await store.initialize();
    const event: DecodedChainEvent = { ...created("100"), type: "0xcafe::pool_v3::PoolSnapshot", kind: "hyperion::PoolEvent", data: { pool_id: "0x123" } };
    await store.commitBatch({ chainId: 2, events: [event], nextVersion: "101" });
    expect(adapter.durable.keys.size).toBe(0);
    expect(adapter.durable.next).toBe("101");
    await store.close();
  });
});
