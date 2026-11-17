import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
for (const [args, profile] of [[['build', '--root', 'contracts-evm'], 'v4_core'], [['test', '--root', 'contracts-evm', ...process.argv.slice(2)], 'default']]) {
  const result = spawnSync(forge, args, { cwd: resolve(root), env: { ...process.env, FOUNDRY_PROFILE: profile }, stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error('Foundry could not start. Install the pinned tools or set ONESHOT_FORGE_BIN.'); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
