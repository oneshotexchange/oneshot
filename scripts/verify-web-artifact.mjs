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
if (output.some(path => /(?:^|[\\/])(?:_worker\.js|functions|\.env(?:\.|$))/.test(path))) throw new Error('The web artifact must contain only public static files.');
for (const path of output.filter(path => /\.(?:js|html)$/.test(path))) {
  const source = await readFile(path, 'utf8');
  if (/PRIVY_APP_SECRET|S3_SECRET_ACCESS_KEY|DATABASE_URL|ONESHOT_FLOOR_CREATORS|ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY|ONESHOT_REQUEST_METRICS|require\(["'](?:pg|sharp|next\/server)["']\)/.test(source)) {
    throw new Error(`Server configuration or runtime found in web artifact: ${path.slice(dist.length + 1)}`);
  }
}
console.log(`Verified ${output.length} public static files; no API runtime or server secret configuration in the Cloudflare artifact.`);
