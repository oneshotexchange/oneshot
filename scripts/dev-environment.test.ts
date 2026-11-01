import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveApiDevelopmentEnvironment } from './lib/dev-environment.mjs';

const root = resolve('.local/dev-environment-fixture');

describe('API-only local development configuration', () => {
  it('provides matching web/API origins and a stable repository data directory without env files', () => {
    const result = resolveApiDevelopmentEnvironment({}, root);
    expect(result).toMatchObject({
      NODE_ENV: 'development', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3000', ONESHOT_API_URL: 'http://127.0.0.1:3001',
      ONESHOT_DATA_DIR: resolve(root, '.local/oneshot'),
    });
    expect(result.PRIVY_APP_ID).toBeUndefined(); expect(result.PRIVY_APP_SECRET).toBeUndefined();
    expect(result.ONESHOT_RPC_URL).toBeUndefined();
  });
  it('preserves explicit process and Next-loaded env-file values instead of overriding them with defaults', () => {
    // @next/env resolves process > .env.development.local > .env.local >
    // .env.development > .env before passing this combined object to the helper.
    const loaded = {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000', ONESHOT_API_URL: 'http://localhost:3001',
      PRIVY_APP_ID: 'configured-app', PRIVY_APP_SECRET: 'api-only-secret', S3_SECRET_ACCESS_KEY: 'api-only-storage',
    };
    expect(resolveApiDevelopmentEnvironment(loaded, root)).toMatchObject(loaded);
  });
  it('loads Next env precedence inside an isolated API process without loading root env files', () => {
    const fixtureBase = resolve('.local/dev-environment-tests'); mkdirSync(fixtureBase, { recursive: true });
    const fixture = mkdtempSync(resolve(fixtureBase, 'case-'));
    const apiDirectory = resolve(fixture, 'apps/api'); mkdirSync(apiDirectory, { recursive: true });
    const markers = {
      '.env': 'ONESHOT_DEV_TEST_BASE=base\nONESHOT_DEV_TEST_DEVELOPMENT=base\nONESHOT_DEV_TEST_LOCAL=base\nONESHOT_DEV_TEST_TOP=base\nONESHOT_DEV_TEST_PROCESS=base\n',
      '.env.development': 'ONESHOT_DEV_TEST_DEVELOPMENT=development\nONESHOT_DEV_TEST_LOCAL=development\nONESHOT_DEV_TEST_TOP=development\nONESHOT_DEV_TEST_PROCESS=development\n',
      '.env.local': 'ONESHOT_DEV_TEST_LOCAL=local\nONESHOT_DEV_TEST_TOP=local\nONESHOT_DEV_TEST_PROCESS=local\n',
      '.env.development.local': 'ONESHOT_DEV_TEST_TOP=development-local\nONESHOT_DEV_TEST_PROCESS=development-local\nNEXT_PUBLIC_APP_URL=http://localhost:3000\nPRIVY_APP_SECRET=synthetic-api-secret\n',
    };
    writeFileSync(resolve(fixture, '.env'), 'ONESHOT_DEV_TEST_ROOT_ONLY=must-not-load\n');
    for (const [file, content] of Object.entries(markers)) writeFileSync(resolve(apiDirectory, file), content);
    const script = `
      import { createRequire } from 'node:module';
      import { resolveApiDevelopmentEnvironment } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/dev-environment.mjs')).href)};
      const requireApi = createRequire(${JSON.stringify(pathToFileURL(resolve('apps/api/package.json')).href)});
      const { loadEnvConfig } = requireApi('@next/env');
      delete process.env.__NEXT_PROCESSED_ENV;
      const { combinedEnv } = loadEnvConfig(${JSON.stringify(apiDirectory)}, true, { info() {}, error() {} });
      const api = resolveApiDevelopmentEnvironment(combinedEnv, ${JSON.stringify(fixture)});
      console.log(JSON.stringify({ base: api.ONESHOT_DEV_TEST_BASE, development: api.ONESHOT_DEV_TEST_DEVELOPMENT,
        local: api.ONESHOT_DEV_TEST_LOCAL, top: api.ONESHOT_DEV_TEST_TOP, explicit: api.ONESHOT_DEV_TEST_PROCESS,
        rootOnly: api.ONESHOT_DEV_TEST_ROOT_ONLY, webOrigin: api.NEXT_PUBLIC_APP_URL, apiOrigin: api.ONESHOT_API_URL,
        hasApiSecret: api.PRIVY_APP_SECRET === 'synthetic-api-secret' }));
    `;
    const childEnvironment = { ...process.env, NODE_ENV: 'development', ONESHOT_DEV_TEST_PROCESS: 'explicit-process' };
    for (const name of ['NEXT_PUBLIC_APP_URL', 'ONESHOT_API_URL', 'ONESHOT_DEV_TEST_ROOT_ONLY', 'PRIVY_APP_SECRET']) delete childEnvironment[name as keyof typeof childEnvironment];
    const originalSecret = process.env.PRIVY_APP_SECRET;
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnvironment, encoding: 'utf8', windowsHide: true });
      expect(JSON.parse(output)).toEqual({ base: 'base', development: 'development', local: 'local', top: 'development-local',
        explicit: 'explicit-process', webOrigin: 'http://localhost:3000', apiOrigin: 'http://127.0.0.1:3001', hasApiSecret: true });
      expect(process.env.PRIVY_APP_SECRET).toBe(originalSecret);
    } finally {
      if (!fixture.startsWith(fixtureBase + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe development test cleanup.');
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it('does not mutate the parent/frontend environment or invent authentication configuration', () => {
    const parent = Object.freeze({ NEXT_PUBLIC_PRIVY_APP_ID: 'public-id' });
    const loadedApi = { ...parent, PRIVY_APP_ID: 'public-id', PRIVY_APP_SECRET: 'private-api-value' };
    const before = { ...loadedApi };
    const api = resolveApiDevelopmentEnvironment(loadedApi, root);
    expect(loadedApi).toEqual(before); expect(parent).toEqual({ NEXT_PUBLIC_PRIVY_APP_ID: 'public-id' });
    expect(parent).not.toHaveProperty('PRIVY_APP_SECRET');
    expect(api.PRIVY_APP_SECRET).toBe('private-api-value');
    expect(api).not.toBe(loadedApi);
  });
  it('normalizes explicit relative data paths against the repository, preserving absolute paths', () => {
    expect(resolveApiDevelopmentEnvironment({ ONESHOT_DATA_DIR: 'custom/data' }, root).ONESHOT_DATA_DIR).toBe(resolve(root, 'custom/data'));
    const absolute = resolve(root, 'absolute-data');
    expect(resolveApiDevelopmentEnvironment({ ONESHOT_DATA_DIR: absolute }, root).ONESHOT_DATA_DIR).toBe(absolute);
  });
  it('honors the legacy directory only when the current directory is missing or empty', () => {
    const legacy = resolveApiDevelopmentEnvironment({ B20_DATA_DIR: 'legacy/data' }, root);
    expect(legacy.ONESHOT_DATA_DIR).toBe(resolve(root, 'legacy/data'));
    expect(legacy.B20_DATA_DIR).toBe(resolve(root, 'legacy/data'));
    expect(resolveApiDevelopmentEnvironment({ ONESHOT_DATA_DIR: '', B20_DATA_DIR: 'legacy/data' }, root).ONESHOT_DATA_DIR).toBe(resolve(root, 'legacy/data'));
    expect(resolveApiDevelopmentEnvironment({ ONESHOT_DATA_DIR: 'current/data', B20_DATA_DIR: 'legacy/data' }, root).ONESHOT_DATA_DIR).toBe(resolve(root, 'current/data'));
  });
  it('refuses production or ambiguous NODE_ENV values in the development launcher', () => {
    for (const NODE_ENV of ['production', 'test', 'staging']) {
      expect(() => resolveApiDevelopmentEnvironment({ NODE_ENV }, root)).toThrow('NODE_ENV=development');
    }
    expect(() => resolveApiDevelopmentEnvironment({}, 'relative/root')).toThrow('must be absolute');
  });
});
