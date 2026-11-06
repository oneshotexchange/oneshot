import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const index = args.indexOf('--env-file');
if (index >= 0) { if (!args[index + 1]) throw new Error('Supply an environment file path.'); loadEnvFile(resolve(args[index + 1])); args.splice(index, 2); }
if (args.some(value => value !== '--watch')) throw new Error('Usage: node scripts/genesis-worker.mjs [--env-file PATH] [--watch]');
const origin = new URL(process.env.ONESHOT_API_URL || 'http://127.0.0.1:3001');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new Error('Use the configured HTTPS API origin, or loopback in development.');
if (!process.env.ONESHOT_ADMIN_PASSWORD) throw new Error('The verification worker requires the server administrator credential.');
let session = null; let stopping = false;
process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
async function post(path, body, token) {
  const response = await fetch(new URL('/api/admin/' + path, origin), { method:'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(45_000) });
  if (!response.ok) { if (response.status === 401) session = null; throw new Error('The verification batch could not finish. Check authenticated administration.'); }
  return response.json();
}
do {
  try {
    if (!session || session.expiresAt <= Date.now() + 60_000) session = await post('session',{password:process.env.ONESHOT_ADMIN_PASSWORD});
    const result = await post('genesis/run-checks',{},session.token);
    if (result.processed) console.log(`Processed ${result.processed} Genesis verification jobs.`);
  } catch (error) { console.error(error.message === 'The verification batch could not finish. Check authenticated administration.' ? error.message : 'Genesis verification is temporarily unavailable. Check authenticated administration.'); if (!watch) process.exitCode = 1; }
  if (watch && !stopping) await delay(30_000);
} while (watch && !stopping);
