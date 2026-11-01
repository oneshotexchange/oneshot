const unavailable = new Set([
  'AUTH_NOT_CONFIGURED', 'AUTH_CONFIG_INVALID', 'AUTH_SERVICE_UNAVAILABLE', 'AUTH_PROVIDER_UNAVAILABLE',
  'DATABASE_REQUIRED', 'INVALID_STORAGE_QUOTA', 'STORAGE_REQUIRED',
  'APP_ORIGIN_REQUIRED', 'API_ORIGIN_REQUIRED', 'INVALID_APP_ORIGIN', 'INVALID_API_ORIGIN',
  'PUBLIC_ORIGIN_REQUIRED', 'PUBLIC_API_ORIGIN_REQUIRED', 'HTTPS_METADATA_REQUIRED',
  'DEPLOYMENT_REQUIRED', 'DEPLOYMENT_UNAVAILABLE', 'EXECUTION_DISABLED', 'CONTRACT_NOT_DEPLOYED',
  'FLOOR_CONFIG_INVALID', 'LISTING_AUTHORITY_UNAVAILABLE',
]);

/** Public API responses retain error codes and transaction actions, but never setup instructions. */
export function publicErrorMessage(code: string, message: string): string {
  if (code === 'INDEXER_CHAIN_MOVED') return 'Activity is being updated after a network change. Please refresh shortly.';
  if (unavailable.has(code) || code.startsWith('INDEXER_') || code.startsWith('RPC_')) {
    return 'This service is temporarily unavailable. Please try again later.';
  }
  return message;
}
