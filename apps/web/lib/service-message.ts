const unavailable = new Set([
  'AUTH_NOT_CONFIGURED', 'AUTH_CONFIG_INVALID', 'AUTH_SERVICE_UNAVAILABLE', 'AUTH_PROVIDER_UNAVAILABLE',
  'DATABASE_REQUIRED', 'INVALID_STORAGE_QUOTA', 'STORAGE_REQUIRED',
  'APP_ORIGIN_REQUIRED', 'API_ORIGIN_REQUIRED', 'INVALID_APP_ORIGIN', 'INVALID_API_ORIGIN',
  'PUBLIC_ORIGIN_REQUIRED', 'PUBLIC_API_ORIGIN_REQUIRED', 'HTTPS_METADATA_REQUIRED', 'RPC_CONFIG_INVALID', 'RPC_DATA_INVALID',
  'INDEXER_CONFIG_INVALID', 'INDEXER_PROFILE_UNSUPPORTED', 'INDEXER_CONFIG_INCOMPLETE',
  'INDEXER_MANIFEST_INVALID', 'INDEXER_CHAIN_UNAVAILABLE', 'INDEXER_NOT_STARTED',
  'INDEXER_DATA_INVALID', 'INDEXER_READ_UNAVAILABLE', 'DEPLOYMENT_REQUIRED',
  'DEPLOYMENT_UNAVAILABLE', 'EXECUTION_DISABLED', 'CONTRACT_NOT_DEPLOYED',
  'FLOOR_CONFIG_INVALID', 'LISTING_AUTHORITY_UNAVAILABLE',
]);

/** Keep operator setup instructions out of customer errors, retaining actionable transaction errors. */
export function serviceMessage(code: unknown, message: unknown, fallback: string): string {
  if (typeof code === 'string' && unavailable.has(code)) return 'This service is temporarily unavailable. Please try again later.';
  if (code === 'CURSOR_STALE') return 'Recent activity changed. Refresh this list to continue.';
  if (code === 'INDEXER_CHAIN_MOVED') return 'Activity is being updated after a network change. Please refresh shortly.';
  if (code === 'INDEXED_RECORD_NOT_FOUND') return 'This NFT is currently unavailable. Refresh the collection to view available items.';
  if (code === 'CONTENT_INTEGRITY') return 'The saved content could not be verified. Please try again later.';
  if (code === 'CONTENT_READ_TIMEOUT') return 'The saved content is taking too long to load. Please try again.';
  return typeof message === 'string' && message ? message : fallback;
}
