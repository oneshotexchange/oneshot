import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Pool } from 'pg';
import { startLocalDatabaseKeeper } from '../deploy/local/local-runtime.mjs';
import { capacityLocalDirectory, writeCapacityReport } from './lib/capacity';
import { assertNftVerificationDatabaseIdentity, NftVerificationError, nftVerificationDatabase, nftVerificationEnvironment, parseNftVerificationArguments, runNftVerification, summarizeNftTests } from './lib/nft-verification';

const root = fileURLToPath(new URL('../', import.meta.url));
const lifecycle: { keeper: Awaited<ReturnType<typeof startLocalDatabaseKeeper>> } = { keeper: null };
let output: string | undefined;
let result: Awaited<ReturnType<typeof runNftVerification>> | undefined;
let failureCode: string | undefined;
let keeperStopped = false;
let keeperFailed = false;

function execute(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', oversized = false, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); timeout.unref();
    child.stderr.resume(); // Child exception text may contain credentials; only emit our fixed codes.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > 8_388_608) { oversized = true; child.kill(); return; }
      stdout += chunk;
    });
    child.once('error', () => { clearTimeout(timeout); reject(new NftVerificationError('PROCESS_UNAVAILABLE_OR_BLOCKED')); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (oversized || timedOut) reject(new NftVerificationError(oversized ? 'TEST_REPORT_TOO_LARGE' : 'TEST_PROCESS_TIMEOUT'));
      else resolve({ code, stdout });
    });
  });
}

try {
  const options = parseNftVerificationArguments(process.argv.slice(2), root);
  output = options.output ?? path.join(await capacityLocalDirectory(root), 'qa', `nft-verification-${randomUUID()}.json`);
  try { await access(output); throw new NftVerificationError('REPORT_ALREADY_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let selected = options.databaseUrl;
  if (options.envFile) {
    const bytes = await readFile(path.resolve(root, options.envFile));
    if (bytes.length > 65_536) throw new NftVerificationError('ENV_FILE_TOO_LARGE');
    selected = parseEnv(bytes.toString()).ONESHOT_INDEXER_TEST_DATABASE_URL;
  }
  const databaseUrl = nftVerificationDatabase(selected);
  const env = nftVerificationEnvironment(process.env, databaseUrl);
  result = await runNftVerification({
    database: async () => {
      lifecycle.keeper = await startLocalDatabaseKeeper({ onUnexpectedExit: () => { keeperFailed = true; } });
      const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, query_timeout: 5000, statement_timeout: 5000 });
      try {
        const { rows } = await pool.query("SELECT current_database() AS database, current_user AS role, current_setting('server_version_num')::integer AS version");
        assertNftVerificationDatabaseIdentity(rows[0], databaseUrl);
      } finally { await pool.end(); }
    },
    tool: async name => {
      const executable = name === 'forge' ? env.ONESHOT_FORGE_BIN ?? (process.platform === 'win32' ? 'forge.exe' : 'forge') : env.ONESHOT_ANVIL_BIN ?? (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
      const check = await execute(executable, ['--version'], env, 10_000);
      if (check.code !== 0 || !check.stdout.trim()) throw new Error();
    },
    tests: async files => {
      const tests = await execute(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files, '--no-file-parallelism', '--reporter=json'], env, 600_000);
      return summarizeNftTests(root, files, tests.code, tests.stdout);
    },
  });
} catch (error) {
  failureCode = error instanceof NftVerificationError ? error.code : error && typeof error === 'object' && 'code' in error && error.code === 'DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED' ? error.code : 'VERIFICATION_SETUP_FAILED';
} finally {
  try { await lifecycle.keeper?.stop(); keeperStopped = true; } catch { failureCode = 'DATABASE_KEEPER_CLEANUP_FAILED'; }
  if (keeperFailed) failureCode = 'DATABASE_KEEPER_EXITED';
  const passed = Boolean(result?.passed && !failureCode && keeperStopped);
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), scope: 'local-test-ETH-and-dedicated-test-PostgreSQL',
    passed, status: failureCode ? 'blocked' : result?.status ?? 'blocked', failureCode: failureCode ?? null,
    stages: result?.stages ?? [], cleanup: { databaseKeeperStopped: keeperStopped },
    limitations: ['Fixture Privy sessions and DNS responses; no real login or wallet approval.', 'Local test ETH only; no Zero deployment, public HTTPS or hosted R2 verification.', 'Skipped or missing expected tests cannot pass. Child timeout/abnormal termination requires checking for leftover owned test processes before retrying.'],
  };
  if (output && failureCode !== 'REPORT_ALREADY_EXISTS') {
    try { await writeCapacityReport(root, output, report); }
    catch { failureCode = 'REPORT_WRITE_FAILED'; }
  }
  console.log(JSON.stringify({ ...report, ...(failureCode ? { passed: false, status: 'blocked', failureCode } : {}), report: output ? path.relative(root, output) : null }));
  if (!passed || failureCode) process.exitCode = 1;
}
