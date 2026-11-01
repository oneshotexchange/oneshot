import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Identify only the disposable local app database managed by this folder. */
export function isManagedLocalDatabase(connectionString) {
  try {
    const url = new URL(connectionString);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.username === 'oneshot_dev' && url.pathname === '/oneshot_dev'
      && Number(url.port || 5432) === Number(process.env.ONESHOT_LOCAL_DB_PORT || 5433);
  } catch { return false; }
}

/** Returns the existing Docker-capable WSL distro, or null for native Docker. */
export function detectWslDocker() {
  if (process.platform !== 'win32') return null;
  const native = spawnSync('docker', ['--context', 'default', 'compose', 'version', '--short'], {
    stdio: 'ignore', windowsHide: true,
  });
  if (!native.error && native.status === 0) return null;
  const distro = process.env.ONESHOT_WSL_DISTRO || 'Ubuntu-24.04';
  const result = spawnSync('wsl.exe', ['--distribution', distro, '--exec', 'docker', '--host', 'unix:///var/run/docker.sock',
    'compose', 'version', '--short'], { stdio: 'ignore', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('The existing local WSL Docker backend is unavailable.');
  return distro;
}

/**
 * Keep a foreground WSL client alive while Windows Node uses its PostgreSQL.
 * WSL can otherwise stop the distro when its last foreground client exits.
 * Caller owns the lifetime: stop() terminates only this spawned client.
 */
export async function startLocalDatabaseKeeper({ onUnexpectedExit = () => {} } = {}) {
  const distro = detectWslDocker();
  if (!distro) return null;
  const marker = 'oneshot-local-wsl-ready';
  const token = `oneshot-local-keeper-${randomUUID()}`;
  const child = spawn('wsl.exe', ['--distribution', distro, '--exec', 'sh', '-c',
    `printf '${marker}:%s\\n' "$$"; cat >/dev/null`, token], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stopping = false;
  let started = false;
  let linuxPid;
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = () => {
    if (stopping) return closed;
    stopping = true;
    // EOF lets the owned Linux cat/shell exit before its Windows client closes.
    child.stdin.end();
    const fallback = setTimeout(() => {
      // Node retains the owned process handle; never kill a distro or daemon.
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 1_500);
    fallback.unref();
    closed.then(() => clearTimeout(fallback));
    return closed;
  };
  child.stdin.on('error', () => { /* A stopped client can close its stdin first. */ });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('Timed out starting the local WSL database keeper.')); }, 20_000);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-256);
      const match = output.match(/oneshot-local-wsl-ready:(\d+)/);
      if (!started && match) {
        started = true;
        linuxPid = Number(match[1]);
        clearTimeout(timeout);
        resolve();
      }
    });
    // Consume diagnostics without exposing unexpected terminal output to callers.
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Could not start the local WSL database keeper.')); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!started) reject(new Error(`Local WSL database keeper exited before startup (${code ?? signal}).`));
      else if (!stopping) onUnexpectedExit(new Error(`Local WSL database keeper exited (${code ?? signal}).`));
    });
  });
  try { await ready; }
  catch (error) { stop(); throw error; }
  return { child, ready, closed, stop, distro, linuxPid, token };
}
