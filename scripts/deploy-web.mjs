import { spawnSync } from 'node:child_process';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { checkDeployment } from './check-deployment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
const env = { ...loadEnv('production', web, 'NEXT_PUBLIC_'), ...process.env };
checkDeployment(env, true);
if (!process.env.npm_execpath) throw new Error('Deploy with npm run deploy:web.');
for (const args of [
  ['run', 'build:web'],
  ['exec', '--yes', '--package=wrangler@4.151.3', '--', 'wrangler', 'pages', 'deploy', 'apps/web/dist', '--project-name', process.env.CLOUDFLARE_PAGES_PROJECT || 'oneshot-web'],
]) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
