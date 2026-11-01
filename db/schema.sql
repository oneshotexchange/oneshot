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
