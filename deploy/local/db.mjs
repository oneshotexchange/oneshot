import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalDatabaseKeeper } from './local-runtime.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const directory = fileURLToPath(new URL('.', import.meta.url));
const portText = process.env.ONESHOT_LOCAL_DB_PORT || '5433';
if (!/^\d+$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) {
  throw new Error('ONESHOT_LOCAL_DB_PORT must be an integer between 1024 and 65535.');
}
const port = String(Number(portText));
const appUrl = `postgresql://oneshot_dev:oneshot_dev_local_only@127.0.0.1:${port}/oneshot_dev`;
const testUrl = `postgresql://oneshot_indexer_test:oneshot_test_local_only@127.0.0.1:${port}/oneshot_indexer_test`;
const command = process.argv[2] || 'help';
const allowed = new Set(['help', 'doctor', 'up', 'stop', 'status', 'check', 'migrate', 'test', 'env', 'hold']);
if (!allowed.has(command) || process.argv.length > 3) throw new Error('Use one command: help | doctor | up | stop | status | check | migrate | test | env | hold');

function execute(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repository, windowsHide: true, encoding: 'utf8', ...options,
  });
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.code || result.error.message}`);
  if (result.status !== 0) throw new Error(`Command exited with status ${result.status}: ${executable}`);
  return result.stdout?.trim() || '';
}

function dockerCommand() {
  // Explicit local context/socket prevents accidentally using a remote context.
  const native = spawnSync('docker', ['--context', 'default', 'compose', 'version', '--short'], {
    cwd: repository, windowsHide: true, encoding: 'utf8',
  });
  if (!native.error && native.status === 0) {
    const endpoint = execute('docker', ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']);
    if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) {
      throw new Error('The default Docker context must use a local Unix socket or Windows named pipe.');
    }
    return {
      label: 'native Docker default context',
      compose: (...args) => execute('docker', ['--context', 'default', 'compose', '--project-name', 'oneshot-local',
        '--project-directory', directory, '--file', resolve(directory, 'compose.yaml'), ...args], {
        stdio: 'inherit', env: { ...process.env, ONESHOT_LOCAL_DB_PORT: port },
      }),
      version: native.stdout.trim(),
    };
  }
  if (process.platform === 'win32') {
    const distro = process.env.ONESHOT_WSL_DISTRO || 'Ubuntu-24.04';
    const prefix = ['--distribution', distro, '--exec'];
    const version = execute('wsl.exe', [...prefix, 'docker', '--host', 'unix:///var/run/docker.sock', 'compose', 'version', '--short']);
    const linuxDirectory = execute('wsl.exe', [...prefix, 'wslpath', '-a', directory]);
    return {
      label: `existing Docker in WSL ${distro}`,
      version,
      compose: (...args) => execute('wsl.exe', [...prefix, 'env', `ONESHOT_LOCAL_DB_PORT=${port}`,
        'docker', '--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', 'oneshot-local',
        '--project-directory', linuxDirectory, '--file', `${linuxDirectory}/compose.yaml`, ...args], { stdio: 'inherit' }),
    };
  }
  throw new Error('A local Docker Engine and Compose plugin are required. This helper does not install or start Docker.');
}

async function checkDatabase(connectionString, expectedDatabase, expectedUser) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    // WSL's Docker daemon can still be starting after its foreground client is
    // ready. Retry only transient startup failures, with a bounded wait.
    let row;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ rows: [row] } = await pool.query("SELECT current_database() AS db, current_user AS role, current_setting('server_version_num')::integer AS version"));
        break;
      } catch (error) {
        if (attempt >= 15 || !['ECONNREFUSED', 'ECONNRESET', '57P03'].includes(error.code)) throw error;
        await delay(500);
      }
    }
    if (row.db !== expectedDatabase || row.role !== expectedUser || Math.trunc(row.version / 10000) !== 17) {
      throw new Error(`Unexpected PostgreSQL database/user/version for ${expectedDatabase}.`);
    }
    console.log(`${expectedDatabase}: PostgreSQL 17 ready as ${expectedUser}.`);
  } finally { await pool.end(); }
}

async function checkBoth() {
  await checkDatabase(appUrl, 'oneshot_dev', 'oneshot_dev');
  await checkDatabase(testUrl, 'oneshot_indexer_test', 'oneshot_indexer_test');
}

let keeper;
let finishHold;
try {
  if (['up', 'check', 'migrate', 'test', 'hold'].includes(command)) {
    keeper = await startLocalDatabaseKeeper({ onUnexpectedExit: error => {
      console.error(error.message); process.exitCode = 1; finishHold?.();
    } });
  }
  if (command === 'help') {
    console.log('node deploy/local/db.mjs COMMAND\nCommands: doctor | up | stop | status | check | migrate | test | env | hold');
    console.log('Only the oneshot-local project is managed. stop preserves its database volume.');
  } else if (command === 'hold') {
    if (!keeper) console.log('Native Docker does not need a WSL foreground keeper.');
    else {
      console.log(`Keeping WSL ${keeper.distro} active for the local database. Stop with Ctrl+C.`);
      await new Promise(resolve => {
        finishHold = resolve;
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    }
  } else if (command === 'env') {
    console.log(`# Disposable local PostgreSQL only; never production.\nDATABASE_URL=${appUrl}\nONESHOT_INDEXER_TEST_DATABASE_URL=${testUrl}\nONESHOT_API_TEST_DATABASE_URL=${testUrl}`);
  } else if (command === 'check') {
    await checkBoth();
  } else if (command === 'migrate') {
    await checkDatabase(appUrl, 'oneshot_dev', 'oneshot_dev');
    execute(process.execPath, ['--import', 'tsx', resolve(repository, 'scripts/migrate.ts')], {
      stdio: 'inherit', env: { ...process.env, DATABASE_URL: appUrl },
    });
  } else if (command === 'test') {
    await checkDatabase(testUrl, 'oneshot_indexer_test', 'oneshot_indexer_test');
    const environment = { ...process.env, ONESHOT_INDEXER_TEST_DATABASE_URL: testUrl, ONESHOT_API_TEST_DATABASE_URL: testUrl };
    // The integration fixture must never receive an ambient production DB URL.
    delete environment.DATABASE_URL;
    execute(process.execPath, [resolve(repository, 'node_modules/vitest/vitest.mjs'), 'run', 'apps/indexer/test/postgres.integration.test.ts', 'apps/api/lib/server/postgres.integration.test.ts', 'apps/api/lib/server/indexed-nfts.integration.test.ts', 'apps/api/lib/server/nft-launch-store.integration.test.ts', 'apps/api/lib/server/nft-launch-progress-store.integration.test.ts', 'scripts/lib/capacity-indexer-workload.integration.test.ts', 'apps/indexer/test/watch-lease.integration.test.ts'], {
      stdio: 'inherit', env: environment,
    });
  } else {
    const docker = dockerCommand();
    console.log(`Local PostgreSQL: ${docker.label}; Compose ${docker.version}; port ${port}.`);
    if (command === 'up') { docker.compose('up', '-d', '--wait', 'db'); await checkBoth(); }
    else if (command === 'stop') docker.compose('stop', 'db');
    else if (command === 'status') docker.compose('ps', 'db');
    else if (command === 'doctor') docker.compose('config', '--quiet');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  keeper?.stop();
}
