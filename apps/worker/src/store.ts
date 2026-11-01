import { normalizeAddress, type DecodedChainEvent } from "@b20/sdk";
import { INDEXING_SCHEMA_SQL } from "./schema";

export interface QueryResult { rows: Record<string, unknown>[]; rowCount: number | null; }
export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
export interface SqlPool { connect(): Promise<SqlClient>; }
export interface EventBatch { chainId: number; events: DecodedChainEvent[]; nextVersion?: string; }
export interface BatchStore {
  getNextVersion(): Promise<string>;
  commitBatch(batch: EventBatch): Promise<void>;
}

export class PostgresEventStore implements BatchStore {
  private lockClient?: SqlClient;
  constructor(private readonly pool: SqlPool, readonly chainId: number, readonly streamName: string, private readonly deploymentVersion: string) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1), $2::integer) AS acquired", [this.streamName, this.chainId]);
      if (result.rows[0]?.acquired !== true) throw new Error("Another indexer owns this deployment's advisory lock");
      this.lockClient = client;
      await client.query(INDEXING_SCHEMA_SQL);
      await client.query("INSERT INTO b20_indexer_checkpoint(chain_id,stream_name,next_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [this.chainId, this.streamName, this.deploymentVersion]);
    } catch (error) {
      if (this.lockClient) await this.close(); else client.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.lockClient) return;
    const client = this.lockClient;
    this.lockClient = undefined;
    try { await client.query("SELECT pg_advisory_unlock(hashtext($1), $2::integer)", [this.streamName, this.chainId]); }
    finally { client.release(); }
  }

  async getNextVersion(): Promise<string> {
    const client = this.activeClient();
    const result = await client.query("SELECT next_version::text AS next_version FROM b20_indexer_checkpoint WHERE chain_id=$1 AND stream_name=$2", [this.chainId, this.streamName]);
    const next = result.rows[0]?.next_version;
    if (typeof next !== "string") throw new Error("Indexer checkpoint is missing");
    return next;
  }

  async commitBatch(batch: EventBatch): Promise<void> {
    if (batch.chainId !== this.chainId) throw new Error("Chain ID mismatch; batch rejected");
    // The transaction uses the SAME session that owns the advisory lock. A lost
    // session cannot silently continue writing through another pooled connection.
    const client = this.activeClient();
    try {
      await client.query("BEGIN");
      for (const event of batch.events) {
        if (event.chainId !== this.chainId) throw new Error("Event chain ID mismatch");
        if ((event.kind === "hyperion::SwapEventV3" || event.kind === "hyperion::PoolEvent") && !await isRegisteredPoolEvent(client, event)) continue;
        const inserted = await client.query(`INSERT INTO b20_chain_events(chain_id,transaction_version,event_index,transaction_hash,timestamp_micros,event_type,event_kind,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING event_index`, [event.chainId, event.transactionVersion, event.eventIndex, event.transactionHash, event.timestampMicros, event.type, event.kind, JSON.stringify(event.data)]);
        if (inserted.rowCount === 1) await projectEvent(client, event);
      }
      if (batch.nextVersion !== undefined) await client.query("UPDATE b20_indexer_checkpoint SET next_version=GREATEST(next_version,$3::numeric),updated_at=now() WHERE chain_id=$1 AND stream_name=$2", [this.chainId, this.streamName, batch.nextVersion]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  private activeClient(): SqlClient {
    if (!this.lockClient) throw new Error("Indexer advisory lock is not held");
    return this.lockClient;
  }
}

async function isRegisteredPoolEvent(client: SqlClient, event: DecodedChainEvent): Promise<boolean> {
  const data = event.data as Record<string, unknown>;
  const raw = data.pool_id ?? data.pool;
  const candidate = typeof raw === "string" ? raw : raw && typeof raw === "object" && "inner" in raw ? raw.inner : undefined;
  if (typeof candidate !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(candidate)) return false;
  const result = await client.query("SELECT 1 AS registered FROM b20_registered_pools WHERE chain_id=$1 AND pool_address=$2", [event.chainId, normalizeAddress(candidate)]);
  return result.rowCount === 1;
}

async function projectEvent(client: SqlClient, event: DecodedChainEvent): Promise<void> {
  const chain = event.chainId;
  const version = event.transactionVersion;
  switch (event.kind) {
    case "nft_launch::CollectionCreated": {
      const data = event.data;
      await client.query(`INSERT INTO b20_collections(chain_id,collection_address,creator_address,name,max_supply,royalty_bps,last_transaction_version)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chain_id,collection_address) DO NOTHING`, [chain, data.collection, data.creator, data.name, data.max_supply, Number(data.royalty_bps), version]);
      break;
    }
    case "nft_launch::CollectionOpened": {
      const data = event.data;
      const result = await client.query("UPDATE b20_collections SET metadata_base_uri=$3,mint_config=$4::jsonb,last_transaction_version=$5 WHERE chain_id=$1 AND collection_address=$2", [chain, data.collection, data.metadata_base_uri, JSON.stringify(data), version]);
      requireProjection(result, "CollectionOpened references an unknown collection");
      break;
    }
    case "nft_launch::Minted": {
      const data = event.data;
      const collection = await client.query("UPDATE b20_collections SET minted_supply=minted_supply+1,last_transaction_version=$3 WHERE chain_id=$1 AND collection_address=$2 AND minted_supply<max_supply", [chain, data.collection, version]);
      requireProjection(collection, "Minted collection is missing or already exhausted");
      await client.query("INSERT INTO b20_nfts(chain_id,token_address,collection_address,owner_address,serial,last_transaction_version) VALUES($1,$2,$3,$4,$5,$6)", [chain, data.token, data.collection, data.minter, data.serial, version]);
      break;
    }
    case "marketplace::Listed": {
      const data = event.data;
      await client.query(`INSERT INTO b20_listings(chain_id,listing_address,token_address,collection_address,seller_address,price_octas,status,last_transaction_version)
        VALUES($1,$2,$3,$4,$5,$6,'active',$7)`, [chain, data.listing, data.token, data.collection, data.seller, data.price_octas, version]);
      break;
    }
    case "marketplace::Cancelled": {
      const result = await client.query("UPDATE b20_listings SET status='cancelled',last_transaction_version=$3 WHERE chain_id=$1 AND listing_address=$2 AND status='active'", [chain, event.data.listing, version]);
      requireProjection(result, "Cancelled references an unknown or inactive listing");
      break;
    }
    case "marketplace::Sold": {
      const data = event.data;
      const result = await client.query("UPDATE b20_listings SET status='sold',buyer_address=$3,last_transaction_version=$4 WHERE chain_id=$1 AND listing_address=$2 AND status='active'", [chain, data.listing, data.buyer, version]);
      requireProjection(result, "Sold references an unknown or inactive listing");
      await client.query("UPDATE b20_nfts SET owner_address=$3,last_transaction_version=$4 WHERE chain_id=$1 AND token_address=$2", [chain, data.token, data.buyer, version]);
      break;
    }
    case "hyperion::SwapEventV3": {
      const data = event.data;
      // A Hyperion event is useful only after B20 on-chain pool registration. No API-discovered pools.
      await client.query(`INSERT INTO b20_pool_trades(chain_id,transaction_version,event_index,pool_address,transaction_hash,timestamp_micros,payload)
        SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE EXISTS(SELECT 1 FROM b20_registered_pools WHERE chain_id=$1 AND pool_address=$4) ON CONFLICT DO NOTHING`, [chain, version, event.eventIndex, normalizeAddress(data.pool_id), event.transactionHash, event.timestampMicros, JSON.stringify(data)]);
      break;
    }
    case "hyperion::PoolEvent": break; // Retained raw for reconciliation; does not invent B20 accounting.
  }
}

function requireProjection(result: QueryResult, message: string): void {
  if (result.rowCount !== 1) throw new Error(message);
}
