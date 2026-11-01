import { IndexerError } from './types';

export type IndexerCliOptions = {
  manifest: string; envFile?: string; watch: boolean; pollIntervalMs: number;
  maxBlocks: number; confirmationDepth: number; maxReorgDepth: number;
};

/** A continuous local worker must never follow a libpq host/query override. */
export function assertLocalWatchDatabase(connectionString: unknown): asserts connectionString is string {
  try {
    if (typeof connectionString !== 'string' || /[?#\u0000-\u0020\u007f]/.test(connectionString)) throw new Error();
    const authority = /^postgres(?:ql)?:\/\/([^/]+)\//i.exec(connectionString)?.[1];
    const host = authority?.slice(authority.lastIndexOf('@') + 1);
    // Check the literal authority before URL normalization can expand shorthand IPv4.
    if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/i.test(host)) throw new Error();
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !decodeURIComponent(url.pathname.slice(1)).trim() || url.search || url.hash) throw new Error();
  } catch {
    throw new IndexerError('LOCAL_DATABASE_REQUIRED');
  }
}

/** Parse completely before opening RPC/database connections. One pass is the default. */
export function parseIndexerArguments(args: readonly string[]): IndexerCliOptions {
  const flags = new Map<string, string>();
  const allowed = new Set(['--env-file', '--manifest', '--max-blocks', '--confirmations', '--max-reorg-depth', '--poll-interval-ms']);
  let watch = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--watch') {
      if (watch) throw new IndexerError('CLI_ARGUMENTS_INVALID');
      watch = true;
      continue;
    }
    const value = args[++index];
    if (!allowed.has(flag) || !value?.trim() || value.startsWith('--') || flags.has(flag)) throw new IndexerError('CLI_ARGUMENTS_INVALID');
    flags.set(flag, value);
  }
  if (!flags.has('--manifest')) throw new IndexerError('MANIFEST_REQUIRED');
  if (!watch && flags.has('--poll-interval-ms')) throw new IndexerError('CLI_ARGUMENTS_INVALID');
  const integer = (flag: string, fallback: number, minimum: number, maximum: number) => {
    const raw = flags.get(flag);
    if (raw === undefined) return fallback;
    if (!/^(0|[1-9]\d{0,4})$/.test(raw)) throw new IndexerError('CLI_ARGUMENTS_INVALID');
    const value = Number(raw);
    if (value < minimum || value > maximum) throw new IndexerError('CLI_ARGUMENTS_INVALID');
    return value;
  };
  return { manifest: flags.get('--manifest')!, envFile: flags.get('--env-file'), watch,
    pollIntervalMs: integer('--poll-interval-ms', 2_000, 500, 60_000),
    maxBlocks: integer('--max-blocks', 100, 1, 1_000),
    confirmationDepth: integer('--confirmations', 0, 0, 1_000),
    maxReorgDepth: integer('--max-reorg-depth', 64, 1, 1_000) };
}
