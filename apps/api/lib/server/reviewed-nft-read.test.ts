import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createReviewedNftReader, type ReviewedNftReaderDependencies } from './reviewed-nft-read';
import { rManifest as manifest, ra } from '../../../indexer/test/reviewed-nft-fixture';
import { api } from './http';
import type { SqlClient } from '../../../indexer/src/store';
afterEach(() => vi.useRealTimers());
const invoke = (handler: ReturnType<typeof createReviewedNftReader>, path = '/status', method = 'GET') => api(handler)(new NextRequest(`http://localhost/api/oneshot/reviewed-nfts${path}`, { method }), {});
function fixture(extra: Partial<ReviewedNftReaderDependencies> = {}) {
  const pool = vi.fn(() => null), load = vi.fn(async () => manifest), source = vi.fn(async () => { throw Error('No provider should be reached.'); });
  const env = { ONESHOT_NETWORK: 'local', ONESHOT_REVIEWED_NFT_READS_ENABLED: 'false', ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED: 'true', ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_REVIEWED_NFT_MANIFEST_PATH: 'fixture.json', DATABASE_URL: 'fixture' };
  return { pool, load, source, env, reader: createReviewedNftReader({ env: () => env, pool, loadManifest: load, source, ...extra }) };
}
describe('reviewed NFT public read boundaries', () => {
  it('has its own opt-in and exposes only useful customer availability without configuration', async () => {
    const f = fixture(), response = await invoke(f.reader), body = await response.json();
    expect(response.status).toBe(200); expect(body.context).toMatchObject({ enabled: false, available: false, source: null, network: null, checkpoint: null });
    expect(JSON.stringify(body)).not.toMatch(/DATABASE|RPC|MANIFEST|PRIVATE|fixture|importsEnabled/); expect(f.pool).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
  });
  it('rejects unknown/duplicate filters, unsafe IDs, unsupported methods and native cursor shapes before I/O', async () => {
    const f = fixture();
    for (const path of ['/collections?wallet=someone', '/collections?limit=2&limit=3', `/collections/${ra(10)}/items/00`, `/collections/${ra(10)}/items/${2n ** 256n}`, '/collections?limit=0', '/activity?wallets=unknown', '/collections?cursor=not-valid-json']) expect((await invoke(f.reader, path)).status).toBe(400);
    expect((await invoke(f.reader, '/collections', 'POST')).status).toBe(405); expect(f.pool).not.toHaveBeenCalled();
  });
  it('redacts unavailable database/provider details without publishing an empty success', async () => {
    const f = fixture({ pool: () => ({ connect: async () => { throw Error('postgres://private:secret@db'); } }) }); f.env.ONESHOT_REVIEWED_NFT_READS_ENABLED = 'true';
    const response = await invoke(f.reader, '/collections'); expect(response.status).toBe(503); const text = await response.text(); expect(text).not.toContain('secret'); expect(text).not.toContain('"items":[]');
  });
  it('bounds acquisition and destroys a late pool connection exactly once', async () => {
    vi.useFakeTimers(); let resolve!: (client: SqlClient) => void;
    const release = vi.fn(), client: SqlClient = { query: vi.fn(), release }, connect = vi.fn(() => new Promise<SqlClient>(done => { resolve = done; }));
    const f = fixture({ pool: () => ({ connect }) }); f.env.ONESHOT_REVIEWED_NFT_READS_ENABLED = 'true';
    const pending = invoke(f.reader); await vi.advanceTimersByTimeAsync(5001); expect((await pending).status).toBe(504);
    resolve(client); await vi.advanceTimersByTimeAsync(0); expect(release).toHaveBeenCalledExactlyOnceWith(true); expect(client.query).not.toHaveBeenCalled();
  });
});
