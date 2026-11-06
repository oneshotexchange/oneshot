import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(root, 'apps/web/dist');
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : resolve(path, entry.name)))).flat();
}
const output = await files(dist);
if (!output.includes(resolve(dist, 'index.html'))) throw new Error('The static web index is missing.');
if (output.some(path => /(?:^|[\\/])(?:functions|\.env(?:\.|$))/.test(path))) throw new Error('The web artifact must not contain API functions or environment files.');
// The sole edge entry point is the reviewed public invitation proxy. Never allow
// Vite to add another worker or bundle the API runtime into the web artifact.
for (const path of output.filter(path => path.endsWith('_worker.js'))) {
  if (path !== resolve(dist, '_worker.js') || await readFile(path, 'utf8') !== await readFile(resolve(root, 'apps/web/public/_worker.js'), 'utf8')) throw new Error('Unexpected edge worker in web artifact.');
}
for (const path of output.filter(path => /\.(?:js|html)$/.test(path))) {
  const source = await readFile(path, 'utf8');
  if (/X_OAUTH_CLIENT_SECRET|GETX_API_KEY|PRIVY_APP_SECRET|S3_SECRET_ACCESS_KEY|DATABASE_URL|ONESHOT_FLOOR_CREATORS|ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY|ONESHOT_REQUEST_METRICS|require\(["'](?:pg|sharp|next\/server)["']\)/.test(source)) {
    throw new Error(`Server configuration or runtime found in web artifact: ${path.slice(dist.length + 1)}`);
  }
}
console.log(`Verified ${output.length} public web files including the invitation proxy; no API runtime or server secret configuration in the Cloudflare artifact.`);
