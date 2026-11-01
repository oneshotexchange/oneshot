import path from 'node:path';
import { localReportPath, testDatabaseUrl } from './capacity';

export const nftDatabaseFiles = [
  'apps/indexer/test/postgres.integration.test.ts',
  'apps/api/lib/server/postgres.integration.test.ts',
  'apps/api/lib/server/indexed-nfts.integration.test.ts',
  'apps/api/lib/server/nft-launch-store.integration.test.ts',
  'apps/api/lib/server/nft-launch-progress-store.integration.test.ts',
  'scripts/lib/capacity-indexer-workload.integration.test.ts',
  'apps/indexer/test/watch-lease.integration.test.ts',
] as const;
export const nftJourneyFiles = [
  'apps/api/lib/server/nft-launch.integration.test.ts',
  'apps/api/lib/server/nft-checkout.integration.test.ts',
  'apps/api/lib/server/nft-floor.integration.test.ts',
  'apps/api/lib/server/nft-watch.integration.test.ts',
] as const;
export class NftVerificationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function parseNftVerificationArguments(args: string[], root: string) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--database-url', '--env-file', '--output'].includes(name) || flags.has(name) || !args[index + 1] || args[index + 1].startsWith('--')) throw new NftVerificationError('ARGUMENTS_INVALID');
    flags.set(name, args[++index]);
  }
  if (flags.has('--database-url') === flags.has('--env-file')) throw new NftVerificationError('EXPLICIT_TEST_DATABASE_REQUIRED');
  return { databaseUrl: flags.get('--database-url'), envFile: flags.get('--env-file'), output: flags.has('--output') ? localReportPath(root, flags.get('--output')!) : undefined };
}

/** An explicit selection is mandatory; ordinary DATABASE_URL is never a fallback. */
export function nftVerificationDatabase(value: string | undefined) {
  return testDatabaseUrl(value ?? '');
}

export function assertNftVerificationDatabaseIdentity(row: { database?: unknown; role?: unknown; version?: unknown } | undefined, databaseUrl: string) {
  const expectedRole = decodeURIComponent(new URL(nftVerificationDatabase(databaseUrl)).username);
  if (row?.database !== 'oneshot_indexer_test' || row.role !== expectedRole || typeof row.version !== 'number' || !Number.isInteger(row.version) || Math.trunc(row.version / 10000) !== 17) throw new NftVerificationError('TEST_DATABASE_IDENTITY_MISMATCH');
}

export function nftVerificationEnvironment(environment: NodeJS.ProcessEnv, databaseUrl: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(environment).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|ONESHOT_FORGE_BIN|ONESHOT_ANVIL_BIN|ONESHOT_WSL_DISTRO)$/i.test(name)));
  return { ...inherited, NODE_ENV: 'test', ONESHOT_INDEXER_TEST_DATABASE_URL: nftVerificationDatabase(databaseUrl), ONESHOT_API_TEST_DATABASE_URL: nftVerificationDatabase(databaseUrl), ONESHOT_RUN_NFT_LAUNCH_INTEGRATION: 'true' };
}

type TestCount = { file: string; passed: number; failed: number; skipped: number };
export function summarizeNftTests(root: string, expected: readonly string[], exitCode: number | null, stdout: string): TestCount[] {
  try {
    const body = JSON.parse(stdout) as { success?: boolean; testResults?: { name?: string; status?: string; assertionResults?: { status?: string }[] }[] };
    if (!Array.isArray(body.testResults) || body.testResults.length !== expected.length) throw new Error();
    const remaining = new Set(expected.map(file => path.resolve(root, file)));
    const counts = body.testResults.map(suite => {
      if (typeof suite.name !== 'string' || !remaining.delete(path.resolve(suite.name)) || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) throw new Error();
      if (suite.status !== 'passed') throw new NftVerificationError('TESTS_FAILED_OR_SKIPPED');
      const passed = suite.assertionResults.filter(test => test.status === 'passed').length;
      const failed = suite.assertionResults.filter(test => test.status === 'failed').length;
      const skipped = suite.assertionResults.length - passed - failed;
      return { file: expected.find(file => path.resolve(root, file) === path.resolve(suite.name!))!, passed, failed, skipped };
    });
    if (remaining.size || exitCode !== 0 || body.success !== true || counts.some(file => file.failed || file.skipped || !file.passed)) throw new NftVerificationError('TESTS_FAILED_OR_SKIPPED');
    return counts;
  } catch (error) {
    if (error instanceof NftVerificationError) throw error;
    throw new NftVerificationError('TEST_REPORT_INVALID');
  }
}

export type NftVerificationStage = { name: string; status: 'passed' | 'blocked' | 'failed' | 'skipped'; code?: string; tests?: TestCount[] };
export async function runNftVerification(deps: {
  database(): Promise<void>;
  tool(name: 'forge' | 'anvil'): Promise<void>;
  tests(files: readonly string[]): Promise<TestCount[]>;
}) {
  const stages: NftVerificationStage[] = [];
  const checks: { name: string; run(): Promise<void | TestCount[]>; blockedCode?: string }[] = [
    { name: 'database', run: deps.database, blockedCode: 'TEST_DATABASE_UNAVAILABLE' },
    { name: 'forge', run: () => deps.tool('forge'), blockedCode: 'FORGE_UNAVAILABLE' },
    { name: 'anvil', run: () => deps.tool('anvil'), blockedCode: 'ANVIL_UNAVAILABLE_OR_BLOCKED' },
    { name: 'database-tests', run: () => deps.tests(nftDatabaseFiles) },
    ...nftJourneyFiles.map(file => ({ name: file.split('/').at(-1)!.replace('.integration.test.ts', ''), run: () => deps.tests([file]) })),
  ];
  let stopped = false;
  for (const check of checks) {
    if (stopped) { stages.push({ name: check.name, status: 'skipped' }); continue; }
    try {
      const tests = await check.run();
      stages.push({ name: check.name, status: 'passed', ...(tests ? { tests } : {}) });
    } catch (error) {
      const code = check.blockedCode ?? (error instanceof NftVerificationError ? error.code : 'TEST_RUN_FAILED');
      stages.push({ name: check.name, status: check.blockedCode ? 'blocked' : 'failed', code });
      stopped = true;
    }
  }
  return { passed: !stopped, status: stages.some(stage => stage.status === 'blocked') ? 'blocked' : stopped ? 'failed' : 'passed', stages };
}
