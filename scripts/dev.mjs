import { spawn, spawnSync } from 'node:child_process';

// npm's own JS entrypoint works without a shell on Windows and Linux.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Start development with npm run dev.');
const children = ['@oneshot/api', '@b20/web'].map(workspace => spawn(process.execPath, [npm, 'run', 'dev', '--workspace', workspace], {
  stdio: 'inherit', env: process.env, detached: process.platform !== 'win32', windowsHide: true,
}));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    // Stop only the process trees created above, including Next/Vite children.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
