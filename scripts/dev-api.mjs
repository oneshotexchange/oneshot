import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveApiDevelopmentEnvironment } from './lib/dev-environment.mjs';
import { isManagedLocalDatabase, startLocalDatabaseKeeper } from '../deploy/local/local-runtime.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const apiRoot = fileURLToPath(new URL('../apps/api/', import.meta.url));
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
let keeper;

try {
  let child;
  let shutdownCode;
  let forceStop;
  // Load private API env files only in this child process. The root launcher and
  // its sibling Vite process never receive API secrets from these files.
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
    throw new Error('The API development launcher requires NODE_ENV=development. Use start:api for production.');
  }
  process.env.NODE_ENV = 'development';
  const { loadEnvConfig } = requireApi('@next/env');
  const { combinedEnv } = loadEnvConfig(apiRoot, true);
  const environment = resolveApiDevelopmentEnvironment(combinedEnv, repositoryRoot);
  if (isManagedLocalDatabase(environment.DATABASE_URL)) {
    keeper = await startLocalDatabaseKeeper({ onUnexpectedExit: error => {
      console.error(error.message);
      stop('SIGTERM');
    } });
  }
  const nextCli = requireApi.resolve('next/dist/bin/next');
  child = spawn(process.execPath, [nextCli, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3001'], {
    cwd: apiRoot,
    env: environment,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  function signalOwnedChild(signal) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') console.error('The API development process could not be stopped.');
      }
    }
  }
  function stop(signal) {
    if (shutdownCode !== undefined) return;
    shutdownCode = signal === 'SIGINT' ? 130 : 143;
    keeper?.stop();
    signalOwnedChild(signal);
    if (process.platform !== 'win32') {
      forceStop = setTimeout(() => signalOwnedChild('SIGKILL'), 5_000);
      forceStop.unref();
    }
  }
  child.on('error', () => { keeper?.stop(); console.error('The API development server could not be started.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    keeper?.stop();
    if (forceStop) clearTimeout(forceStop);
    process.exitCode = shutdownCode ?? code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
} catch (error) {
  keeper?.stop();
  console.error(error instanceof Error ? error.message : 'The API development environment could not be loaded.');
  process.exitCode = 1;
}
