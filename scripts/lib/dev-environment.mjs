import { isAbsolute, resolve } from 'node:path';

/** Resolve only the API child's development environment, after Next loads its env files.
 * This function never changes the supplied parent/frontend environment.
 */
export function resolveApiDevelopmentEnvironment(environment, repositoryRoot) {
  if (!isAbsolute(repositoryRoot)) throw new Error('The development repository root must be absolute.');
  if (environment.NODE_ENV && environment.NODE_ENV !== 'development') {
    throw new Error('The API development launcher requires NODE_ENV=development. Use start:api for production.');
  }
  const api = { ...environment, NODE_ENV: 'development' };
  api.NEXT_PUBLIC_APP_URL ??= 'http://127.0.0.1:3000';
  api.ONESHOT_API_URL ??= 'http://127.0.0.1:3001';

  // Match the store's modern -> legacy -> default selection, then make the path
  // independent of whether npm was started at the root or inside a workspace.
  const directory = api.ONESHOT_DATA_DIR || api.B20_DATA_DIR || '.local/oneshot';
  api.ONESHOT_DATA_DIR = resolve(repositoryRoot, directory);
  if (api.B20_DATA_DIR) api.B20_DATA_DIR = resolve(repositoryRoot, api.B20_DATA_DIR);
  return api;
}
