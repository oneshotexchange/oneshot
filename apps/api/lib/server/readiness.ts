import { database } from './store';
import { apiOrigin, webOrigin } from './origins';

/** DB availability is probed; object storage is a configuration check, not an availability claim. */
export async function readiness() {
  let originsConfigured = false;
  try { apiOrigin(); webOrigin(); originsConfigured = true; } catch { /* Return only configuration flags. */ }
  const objectStorageConfigured = Boolean(process.env.S3_BUCKET && process.env.S3_ENDPOINT
    && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
  let databaseAvailable = false;
  try {
    const db = database();
    if (db) { await db.query('SELECT 1'); databaseAvailable = true; }
  } catch { /* Do not expose connection strings or driver errors. */ }
  const ready = originsConfigured && objectStorageConfigured && databaseAvailable;
  return {
    ready,
    checks: { originsConfigured, databaseAvailable, objectStorageConfigured },
    storageAvailabilityVerified: false,
    chainConnectionVerified: false,
  };
}
