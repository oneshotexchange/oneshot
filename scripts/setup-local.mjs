import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Explicit setup only: never overwrite an existing developer's configuration.
const root = new URL('../', import.meta.url);
const port = process.env.ONESHOT_LOCAL_DB_PORT || '5433';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
  throw new Error('ONESHOT_LOCAL_DB_PORT must be an integer between 1024 and 65535.');
}
await mkdir(new URL('.local/oneshot/', root), { recursive: true });
const apiTemplate = await readFile(new URL('.env.example', root), 'utf8');
const database = `postgresql://oneshot_dev:oneshot_dev_local_only@127.0.0.1:${Number(port)}/oneshot_dev`;
try {
  await writeFile(new URL('apps/api/.env.local', root), apiTemplate.replace(/^DATABASE_URL=$/m, `DATABASE_URL=${database}`), { flag: 'wx', mode: 0o600 });
  console.log('Created apps/api/.env.local for the disposable local PostgreSQL.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing apps/api/.env.local.');
}
try {
  await copyFile(fileURLToPath(new URL('apps/web/.env.example', root)), fileURLToPath(new URL('apps/web/.env.local', root)), constants.COPYFILE_EXCL);
  console.log('Created apps/web/.env.local with public localhost settings.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing apps/web/.env.local.');
}
console.log('Next: npm run db:local -- up, npm run db:local -- migrate, then npm run dev.');
console.log('Privy and chain configuration remain explicit; media uses local files until R2 is configured.');
