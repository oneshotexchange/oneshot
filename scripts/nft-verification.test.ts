import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertNftVerificationDatabaseIdentity, nftDatabaseFiles, nftJourneyFiles, nftVerificationDatabase, nftVerificationEnvironment, parseNftVerificationArguments, runNftVerification, summarizeNftTests } from './lib/nft-verification';

const root = process.cwd();
const databaseUrl = 'postgresql://oneshot_test:fixture-only@127.0.0.1:5433/oneshot_indexer_test';
const report = (files: readonly string[], statuses = ['passed']) => JSON.stringify({ success: true, testResults: files.map(file => ({ name: path.resolve(root, file), status: 'passed', assertionResults: statuses.map(status => ({ status, failureMessages: ['secret-provider-value'] })) })) });

describe('explicit local NFT verification', () => {
  it('requires exactly one explicit test database source and a local JSON output', () => {
    expect(() => parseNftVerificationArguments([], root)).toThrow('EXPLICIT_TEST_DATABASE_REQUIRED');
    expect(() => parseNftVerificationArguments(['--database-url', databaseUrl, '--env-file', 'test.env'], root)).toThrow('EXPLICIT_TEST_DATABASE_REQUIRED');
    for (const args of [['--database-url', databaseUrl, '--unknown', 'true'], ['--database-url', databaseUrl, '--database-url', databaseUrl]]) expect(() => parseNftVerificationArguments(args, root)).toThrow('ARGUMENTS_INVALID');
    expect(() => parseNftVerificationArguments(['--env-file', 'test.env', '--output', '../report.json'], root)).toThrow('LOCAL_JSON_REPORT_REQUIRED');
    expect(parseNftVerificationArguments(['--database-url', databaseUrl, '--output', '.local/qa/nft.json'], root)).toMatchObject({ databaseUrl, output: path.resolve('.local/qa/nft.json') });
    for (const invalid of [undefined, 'postgresql://name:secret@remote.example/oneshot_indexer_test', 'postgresql://name:secret@127.0.0.1/oneshot_dev', `${databaseUrl}?host=remote`]) expect(() => nftVerificationDatabase(invalid)).toThrow('DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED');
  });

  it('checks the actual database, role and version rather than trusting URL labels', () => {
    const actual = { database: 'oneshot_indexer_test', role: 'oneshot_test', version: 170006 };
    expect(() => assertNftVerificationDatabaseIdentity(actual, databaseUrl)).not.toThrow();
    for (const row of [undefined, { ...actual, database: 'oneshot_dev' }, { ...actual, role: 'other' }, { ...actual, version: 160006 }, { ...actual, version: '170006' }]) expect(() => assertNftVerificationDatabaseIdentity(row, databaseUrl)).toThrow('TEST_DATABASE_IDENTITY_MISMATCH');
  });

  it('does not forward ambient production credentials or execution flags', () => {
    const environment = nftVerificationEnvironment({ PATH: 'tools', DATABASE_URL: 'production-secret', PRIVY_APP_SECRET: 'provider-secret', S3_SECRET_ACCESS_KEY: 'storage-secret', NODE_OPTIONS: '--require=unsafe', ONESHOT_NETWORK: 'zero', ONESHOT_RPC_URL: 'private-rpc', ONESHOT_FORGE_BIN: 'installed-forge' }, databaseUrl);
    expect(environment).toMatchObject({ PATH: 'tools', ONESHOT_FORGE_BIN: 'installed-forge', NODE_ENV: 'test', ONESHOT_INDEXER_TEST_DATABASE_URL: databaseUrl, ONESHOT_API_TEST_DATABASE_URL: databaseUrl, ONESHOT_RUN_NFT_LAUNCH_INTEGRATION: 'true' });
    for (const name of ['DATABASE_URL', 'PRIVY_APP_SECRET', 'S3_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'ONESHOT_NETWORK', 'ONESHOT_RPC_URL']) expect(environment).not.toHaveProperty(name);
  });

  it('accepts only complete successful results for every expected file and strips exception text', () => {
    const counts = summarizeNftTests(root, nftDatabaseFiles, 0, report(nftDatabaseFiles));
    expect(counts).toHaveLength(nftDatabaseFiles.length);
    expect(JSON.stringify(counts)).not.toContain('secret-provider-value');
    for (const [code, body] of [[1, report(nftDatabaseFiles)], [0, report(nftDatabaseFiles, ['passed', 'pending'])], [0, report(nftDatabaseFiles, ['passed', 'failed'])], [0, report(nftDatabaseFiles, [])], [0, report(nftDatabaseFiles.slice(1))], [0, '{"success":true}'], [0, 'invalid secret-provider-value']] as const) expect(() => summarizeNftTests(root, nftDatabaseFiles, code, body)).toThrow(/TESTS_FAILED_OR_SKIPPED|TEST_REPORT_INVALID/);
    expect(() => summarizeNftTests(root, nftJourneyFiles, 0, report([nftJourneyFiles[0], nftJourneyFiles[0], nftJourneyFiles[2], nftJourneyFiles[3]]))).toThrow('TEST_REPORT_INVALID');
  });

  it('reports a blocked prerequisite, never runs tests afterward and never includes the raw error', async () => {
    const tests = vi.fn();
    const result = await runNftVerification({ database: async () => {}, tool: async name => { if (name === 'anvil') throw new Error('Windows policy / private-secret'); }, tests });
    expect(result).toMatchObject({ passed: false, status: 'blocked' });
    expect(result.stages.find(stage => stage.name === 'anvil')).toMatchObject({ status: 'blocked', code: 'ANVIL_UNAVAILABLE_OR_BLOCKED' });
    expect(result.stages.filter(stage => stage.status === 'skipped')).toHaveLength(5);
    expect(tests).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('runs the database checks and four journeys in order, and stops after a failed journey', async () => {
    const visited: string[][] = [];
    const tests = vi.fn(async (files: readonly string[]) => { visited.push([...files]); return summarizeNftTests(root, files, 0, report(files)); });
    const passed = await runNftVerification({ database: async () => {}, tool: async () => {}, tests });
    expect(passed.passed).toBe(true); expect(visited).toEqual([nftDatabaseFiles, ...nftJourneyFiles.map(file => [file])]);
    const failed = await runNftVerification({ database: async () => {}, tool: async () => {}, tests: async files => { if (files[0] === nftJourneyFiles[1]) throw new Error('secret assertion'); return []; } });
    expect(failed).toMatchObject({ passed: false, status: 'failed' });
    expect(failed.stages.slice(-2).every(stage => stage.status === 'skipped')).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret assertion');
  });
});
