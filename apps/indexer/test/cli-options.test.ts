import { describe, expect, it } from 'vitest';
import { assertLocalWatchDatabase, parseIndexerArguments } from '../src/cli-options';

describe('local indexer CLI flags', () => {
  it('preserves bounded one-pass defaults and opts into watch only explicitly', () => {
    expect(parseIndexerArguments(['--manifest', 'local.json'])).toEqual({ manifest: 'local.json', envFile: undefined, watch: false,
      pollIntervalMs: 2000, maxBlocks: 100, confirmationDepth: 0, maxReorgDepth: 64 });
    expect(parseIndexerArguments(['--watch', '--manifest', 'local.json', '--env-file', 'private.env', '--poll-interval-ms', '60000',
      '--max-blocks', '1000', '--confirmations', '1000', '--max-reorg-depth', '1000']))
      .toMatchObject({ watch: true, envFile: 'private.env', pollIntervalMs: 60000, maxBlocks: 1000, confirmationDepth: 1000, maxReorgDepth: 1000 });
  });
  it.each([
    ['--manifest', 'local.json', '--watch', '--watch'], ['--manifest', 'local.json', '--manifest', 'other.json'],
    ['--manifest', 'local.json', '--poll-interval-ms', '2000'], ['--watch', '--manifest', 'local.json', '--poll-interval-ms', '499'],
    ['--watch', '--manifest', 'local.json', '--poll-interval-ms', '60001'], ['--manifest', 'local.json', '--max-blocks', '0'],
    ['--manifest', 'local.json', '--max-blocks', '1001'], ['--manifest', 'local.json', '--confirmations', '-1'],
    ['--manifest', 'local.json', '--max-reorg-depth', '0'], ['--manifest', 'local.json', '--max-blocks', '01'],
    ['--manifest', 'local.json', '--watch', 'true'], ['--unknown', 'anything'], ['--manifest'], ['--manifest', ' '],
  ].map(args => ({ args })))('rejects malformed/ambiguous flags before connecting: $args', ({ args }) => {
    expect(() => parseIndexerArguments(args)).toThrow('CLI_ARGUMENTS_INVALID');
  });
  it('requires an explicit manifest', () => {
    expect(() => parseIndexerArguments(['--watch'])).toThrow('MANIFEST_REQUIRED');
  });
});

describe('continuous local indexer database gate', () => {
  it.each([
    'postgresql://local_user:local_password@127.0.0.1:5433/oneshot_dev',
    'postgres://localhost/oneshot_indexer_test',
    'postgresql://local_user:escaped%40password@localhost:5432/oneshot_indexer_test',
    'postgresql://[::1]:5433/oneshot_indexer_test',
  ])('accepts an explicit local PostgreSQL URL: %s', value => {
    expect(() => assertLocalWatchDatabase(value)).not.toThrow();
  });

  it.each([
    undefined, null, '', 'not-a-url', 'host=localhost dbname=oneshot_dev',
    'postgresql://remote.example/oneshot_dev', 'postgresql://127.0.0.2/oneshot_dev',
    'https://localhost/oneshot_dev', 'postgresql://localhost', 'postgresql://localhost/',
    'postgresql://localhost/%20', 'postgresql://localhost/%zz',
    'postgresql://localhost/oneshot_dev?host=remote.example',
    'postgresql://localhost/oneshot_dev?hostaddr=203.0.113.10',
    'postgresql://localhost/oneshot_dev?', 'postgresql://localhost/oneshot_dev#',
    'postgresql://localhost/oneshot_dev#ignored', 'postgresql://localhost:65536/oneshot_dev',
    'postgresql://127.1/oneshot_dev', 'postgresql://2130706433/oneshot_dev',
    'postgresql://%6cocalhost/oneshot_dev', 'postgresql://localhost./oneshot_dev',
    'postgresql://user@localhost@remote.example/oneshot_dev', 'postgresql://localhost/oneshot_dev\n',
  ])('rejects unavailable/remote/overridden targets with a static error: %s', value => {
    expect(() => assertLocalWatchDatabase(value)).toThrow('LOCAL_DATABASE_REQUIRED');
  });

  it('never includes credentials in a rejection', () => {
    try { assertLocalWatchDatabase('postgresql://secret-user:secret-password@remote.example/private-db'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'LOCAL_DATABASE_REQUIRED', message: 'LOCAL_DATABASE_REQUIRED' });
      expect(String(error)).not.toMatch(/secret|remote|private/);
      return;
    }
    throw new Error('Expected a guarded rejection');
  });
});
