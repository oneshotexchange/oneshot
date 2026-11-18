import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { stableJson } from '../apps/api/lib/server/media';
import { parseNftCatalogBackfillArguments, runNftCatalogBackfill } from './lib/nft-catalog-backfill';
const hash = 'a'.repeat(64);
describe('bounded NFT catalog backfill command', () => {
  it('makes help and one explicitly selected stored snapshot available without an implicit environment file', () => {
    expect(parseNftCatalogBackfillArguments(['--help'])).toEqual({ help: true });
    expect(parseNftCatalogBackfillArguments(['--manifest-hash', hash])).toEqual({ manifestHash: hash });
    expect(parseNftCatalogBackfillArguments(['--manifest-hash', hash, '--env-file', 'local.env', '--output', '.local/qa/catalog.json'])).toEqual({ manifestHash: hash, envFile: 'local.env', output: '.local/qa/catalog.json' });
  });
  it.each([[], ['--manifest-hash', `0x${hash}`], ['--manifest-hash', hash, '--manifest-hash', hash], ['--manifest-hash', hash, '--all', 'true'], ['--help', '--output', 'report.json'], ['--manifest-hash', hash, '--env-file'], ['--manifest-hash', hash, '--env-file', 'secret\n.env']].map(args => ({ args })))('rejects ambiguous or invalid write scope before storage: $args', ({ args }) => {
    expect(() => parseNftCatalogBackfillArguments(args)).toThrow('INVALID_CATALOG_ARGUMENTS');
  });
  it('reports only verified counts and bytes, excluding private original metadata and operator configuration', async () => {
    const metadataJson = JSON.stringify({ name: 'Private prepared NFT', image: 'https://private.example/key' });
    const rebuild = vi.fn(async () => ({ manifestHash: hash, items: [{ serial: 1, metadataJson }] }));
    const report = await runNftCatalogBackfill({ manifestHash: hash }, { rebuild });
    expect(report).toMatchObject({ status: 'verified', itemCount: 1, metadataBytes: Buffer.byteLength(metadataJson), code: null });
    expect(JSON.stringify(report)).not.toMatch(/Private prepared|private.example|image|operator/);
    expect(rebuild).toHaveBeenCalledWith(hash, { signal: expect.any(AbortSignal) });
  });
  it('does not start rebuilding after cancellation and redacts unrecognized storage errors', async () => {
    const controller = new AbortController(); controller.abort();
    const rebuild = vi.fn().mockRejectedValue(new Error('postgres://user:secret@host/db'));
    expect(await runNftCatalogBackfill({ manifestHash: hash }, { rebuild }, controller.signal)).toMatchObject({ status: 'failed', code: 'CATALOG_BACKFILL_TIMEOUT' });
    expect(rebuild).not.toHaveBeenCalled();
    const failure = await runNftCatalogBackfill({ manifestHash: hash }, { rebuild });
    expect(failure).toMatchObject({ status: 'failed', code: 'CATALOG_BACKFILL_FAILED' });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
  it('rejects incomplete or mismatched results rather than announcing an indexed collection', async () => {
    for (const catalog of [{ manifestHash: hash, items: [] }, { manifestHash: 'b'.repeat(64), items: [{ serial: 1, metadataJson: '{}' }] }, { manifestHash: hash, items: [{ serial: 2, metadataJson: '{}' }] }]) {
      const result = await runNftCatalogBackfill({ manifestHash: hash }, { rebuild: async () => catalog });
      expect(result).toMatchObject({ status: 'failed', code: 'INVALID_CATALOG_RESULT' });
    }
  });
  it('returns a timeout report for a stalled rebuild instead of waiting indefinitely',async()=>{
    const controller=new AbortController();let finish:((value:{manifestHash:string;items:{serial:number;metadataJson:string}[]})=>void)|undefined;
    const pending=new Promise<{manifestHash:string;items:{serial:number;metadataJson:string}[]}>(resolve=>{finish=resolve;});
    const running=runNftCatalogBackfill({manifestHash:hash},{rebuild:()=>pending},controller.signal);
    setTimeout(()=>controller.abort(),10);
    const report=await running;expect(report).toMatchObject({status:'failed',code:'CATALOG_BACKFILL_TIMEOUT'});
    finish!({manifestHash:hash,items:[{serial:1,metadataJson:'{}'}]});
    expect(report.status).toBe('failed');
  });
  it('rebuilds and repairs real local stored metadata, preserves reports and refuses changed source bytes', async () => {
    const root = process.cwd(), testRoot = path.resolve(root, '.local/qa/nft-discovery/catalog-cli-tests');
    await mkdir(testRoot, { recursive: true });
    const directory = await mkdtemp(path.join(testRoot, 'case-'));
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const imageHash = sha('synthetic image'), media: Record<string, unknown> = {};
    const metadata = Array.from({ length: 3 }, (_, index) => stableJson({ name: `Synthetic #${index + 1}`, image: `https://api.oneshot.app/api/media/${imageHash}.webp`, attributes: [{ trait_type: 'Edition', value: index + 1 }] }));
    const items = metadata.map((metadataJson, index) => ({ serial: index + 1, metadataId: `${sha(metadataJson)}.json`, metadataHash: sha(metadataJson), imageHash }));
    const manifestHash = sha(stableJson({ items }));
    await mkdir(path.join(directory, 'media'));
    for (const item of items) {
      await writeFile(path.join(directory, 'media', item.metadataId), metadata[item.serial - 1]);
      media[item.metadataId] = { mimeType: 'application/json', size: Buffer.byteLength(metadata[item.serial - 1]), owner: 'synthetic-private-owner' };
    }
    const stateFile = path.join(directory, 'state.json'), report = path.join(directory, 'report.json');
    await writeFile(stateFile, JSON.stringify({ oneshot_snapshots: { [manifestHash]: { manifestHash, items } }, media }));
    const run = (output?: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-nft-catalog.ts', '--manifest-hash', manifestHash, ...(output ? ['--output', output] : [])], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', ONESHOT_DATA_DIR: directory, B20_DATA_DIR: '', S3_BUCKET: '' },
    });
    try {
      const built = run(report); expect(built.status, built.stderr).toBe(0);
      expect(JSON.parse(built.stdout)).toMatchObject({ status: 'verified', itemCount: 3 });
      expect(built.stdout).not.toMatch(/synthetic-private-owner|api.oneshot|Edition/);
      const stored = JSON.parse(await readFile(stateFile, 'utf8'));
      expect(stored.oneshot_nft_catalogs[manifestHash].items.map((item: { metadataJson: string }) => item.metadataJson)).toEqual(metadata);
      stored.oneshot_nft_catalogs[manifestHash].items[0].metadataJson = '{}';
      await writeFile(stateFile, JSON.stringify(stored));
      const before = await readFile(stateFile, 'utf8'), originalReport = await readFile(report, 'utf8');
      expect(run(report).status).toBe(1);
      expect(await readFile(report, 'utf8')).toBe(originalReport); expect(await readFile(stateFile, 'utf8')).toBe(before);
      expect(run().status).toBe(0);
      const repaired = await readFile(stateFile, 'utf8');
      expect(JSON.parse(repaired).oneshot_nft_catalogs[manifestHash].items[0].metadataJson).toBe(metadata[0]);
      await writeFile(path.join(directory, 'media', items[0].metadataId), '{}');
      const rejected = run(); expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stdout).status).toBe('failed'); expect(await readFile(stateFile, 'utf8')).toBe(repaired);
    } finally {
      const relative = path.relative(testRoot, directory);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe catalog test cleanup');
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
