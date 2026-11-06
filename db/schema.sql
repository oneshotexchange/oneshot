CREATE TABLE IF NOT EXISTS b20_app_records (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,id)
);
CREATE INDEX IF NOT EXISTS b20_app_records_updated ON b20_app_records(namespace,updated_at DESC);
CREATE INDEX IF NOT EXISTS b20_app_records_owner_updated
  ON b20_app_records(namespace,(value->>'ownerUserId'),updated_at DESC)
  WHERE COALESCE(value->>'status','') <> 'deleted';
-- NFT transaction recovery uses its own private namespace and account field.
-- Keep retention cleanup and stable history pages bounded to those records.
CREATE INDEX IF NOT EXISTS b20_nft_reviews_owner_created
  ON b20_app_records((value->>'owner'),((value->>'createdAt')::bigint) DESC,id DESC)
  WHERE namespace='oneshot_nft_reviews';
CREATE INDEX IF NOT EXISTS b20_nft_reviews_retention
  ON b20_app_records(((value->>'createdAt')::bigint),id)
  WHERE namespace='oneshot_nft_reviews';

-- Genesis is offchain and independent of chain/indexer availability.
CREATE TABLE IF NOT EXISTS oneshot_genesis_identities (
  x_id TEXT PRIMARY KEY CHECK (x_id ~ '^[0-9]{1,32}$'), value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oneshot_genesis_oauth (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, value JSONB NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS oneshot_genesis_oauth_expiry ON oneshot_genesis_oauth(expires_at);
CREATE TABLE IF NOT EXISTS oneshot_genesis_sessions (
  session_hash TEXT PRIMARY KEY, x_id TEXT NOT NULL REFERENCES oneshot_genesis_identities(x_id),
  value JSONB NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS oneshot_genesis_session_expiry ON oneshot_genesis_sessions(expires_at);
CREATE TABLE IF NOT EXISTS oneshot_genesis_campaign (
  id TEXT PRIMARY KEY CHECK (id='genesis'), value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS oneshot_genesis_applications (
  id UUID PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, x_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE, referrer_id UUID REFERENCES oneshot_genesis_applications(id),
  value JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referrer_id IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS oneshot_genesis_referrer ON oneshot_genesis_applications(referrer_id);
CREATE INDEX IF NOT EXISTS oneshot_genesis_created ON oneshot_genesis_applications(created_at DESC,id);
CREATE TABLE IF NOT EXISTS oneshot_genesis_jobs (
  id UUID PRIMARY KEY, application_id UUID NOT NULL REFERENCES oneshot_genesis_applications(id),
  task TEXT NOT NULL CHECK (task IN ('follow','post','share')),
  next_at BIGINT NOT NULL, lease_until BIGINT NOT NULL, value JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS oneshot_genesis_pending ON oneshot_genesis_jobs(next_at,lease_until)
  WHERE value->>'state'<>'done';
CREATE TABLE IF NOT EXISTS oneshot_genesis_budget (day DATE PRIMARY KEY, reads INTEGER NOT NULL CHECK (reads>=0));
CREATE TABLE IF NOT EXISTS oneshot_genesis_audit (id UUID PRIMARY KEY, value JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
