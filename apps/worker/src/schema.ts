/** Owned worker schema, shared with the read-only web/API projections. No existing data is dropped. */
export const INDEXING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS b20_indexer_checkpoint (
  chain_id smallint NOT NULL, stream_name text NOT NULL, next_version numeric(20,0) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chain_id,stream_name)
);
CREATE TABLE IF NOT EXISTS b20_chain_events (
  chain_id smallint NOT NULL, transaction_version numeric(20,0) NOT NULL, event_index integer NOT NULL,
  transaction_hash text NOT NULL, timestamp_micros numeric(20,0) NOT NULL, event_type text NOT NULL,
  event_kind text NOT NULL, payload jsonb NOT NULL, inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,transaction_version,event_index)
);
CREATE INDEX IF NOT EXISTS b20_events_kind_version ON b20_chain_events(event_kind,transaction_version DESC);
CREATE TABLE IF NOT EXISTS b20_collections (
  chain_id smallint NOT NULL, collection_address text NOT NULL, creator_address text NOT NULL, name text NOT NULL,
  max_supply numeric(20,0) NOT NULL, royalty_bps integer NOT NULL, minted_supply numeric(20,0) NOT NULL DEFAULT 0,
  metadata_base_uri text, mint_config jsonb NOT NULL DEFAULT '{}', last_transaction_version numeric(20,0) NOT NULL,
  PRIMARY KEY(chain_id,collection_address)
);
CREATE TABLE IF NOT EXISTS b20_nfts (
  chain_id smallint NOT NULL, token_address text NOT NULL, collection_address text NOT NULL, owner_address text NOT NULL,
  serial numeric(20,0) NOT NULL, last_transaction_version numeric(20,0) NOT NULL,
  PRIMARY KEY(chain_id,token_address)
);
CREATE INDEX IF NOT EXISTS b20_nfts_collection ON b20_nfts(chain_id,collection_address);
CREATE TABLE IF NOT EXISTS b20_listings (
  chain_id smallint NOT NULL, listing_address text NOT NULL, token_address text NOT NULL, collection_address text NOT NULL,
  seller_address text NOT NULL, buyer_address text, price_octas numeric(20,0) NOT NULL,
  status text NOT NULL CHECK(status IN ('active','cancelled','sold')), last_transaction_version numeric(20,0) NOT NULL,
  PRIMARY KEY(chain_id,listing_address)
);
CREATE INDEX IF NOT EXISTS b20_listings_collection ON b20_listings(chain_id,collection_address,status);
CREATE TABLE IF NOT EXISTS b20_registered_pools (
  chain_id smallint NOT NULL, pool_address text NOT NULL, token_address text NOT NULL,
  registration_transaction_version numeric(20,0) NOT NULL, PRIMARY KEY(chain_id,pool_address)
);
CREATE TABLE IF NOT EXISTS b20_pool_trades (
  chain_id smallint NOT NULL, transaction_version numeric(20,0) NOT NULL, event_index integer NOT NULL,
  pool_address text NOT NULL, transaction_hash text NOT NULL, timestamp_micros numeric(20,0) NOT NULL,
  payload jsonb NOT NULL, PRIMARY KEY(chain_id,transaction_version,event_index)
);
CREATE INDEX IF NOT EXISTS b20_pool_trades_pool ON b20_pool_trades(chain_id,pool_address,transaction_version DESC);
`;
