import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { isPublicMetadataOrigin } from '../apps/web/lib/oneshot-origin.mjs';

export function checkDeployment(env, webOnly = false) {
  function origin(name) {
    const value = env[name];
    if (typeof value !== 'string' || !isPublicMetadataOrigin(value)) {
      throw new Error(`${name} must be a public HTTPS origin without a path or credentials.`);
    }
    return new URL(value).origin;
  }
  if (webOnly) { origin('NEXT_PUBLIC_API_URL'); return; }
  const web = origin('NEXT_PUBLIC_APP_URL'), api = origin('ONESHOT_API_URL');
  if (web === api) throw new Error('Web and API must have separate origins.');
  for (const name of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!env[name]) throw new Error(`${name} must be configured on the API host.`);
  }
  if (env.NEXT_PUBLIC_PRIVY_APP_ID && env.NEXT_PUBLIC_PRIVY_APP_ID !== env.PRIVY_APP_ID) {
    throw new Error('Public and server Privy App IDs must match.');
  }
  if (!env.DATABASE_URL && !env.PGPASSWORD_FILE) throw new Error('Configure DATABASE_URL, or mount the PostgreSQL password file for the Contabo bootstrap.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const webOnly = args.includes('--web');
    const remaining = args.filter(arg => arg !== '--web');
    if (remaining.length) {
      if (remaining.length !== 2 || remaining[0] !== '--env-file') throw new Error('Usage: npm run check:deployment -- [--web] [--env-file PATH]');
      loadEnvFile(remaining[1]);
    }
    checkDeployment(process.env, webOnly);
    console.log('Deployment configuration checks passed. Provider connectivity and credentials have not been verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
