import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Pool } from 'pg';
import { createIndexedNftReader, type IndexedReaderDependencies } from './indexed-nfts';
import { api } from './http';
import { oneshotApi } from './oneshot-api';
import * as auth from './oneshot-auth';
import { parseManifest } from '../../../indexer/src/manifest';
import type { ChainSource } from '../../../indexer/src/types';
import type { IndexedNftPresentation } from '@oneshot/evm';
import { stableJson } from './media';

const hash = (value: number): `0x${string}` => `0x${value.toString(16).padStart(64, '0')}`;
const address = (value: number): `0x${string}` => `0x${value.toString(16).padStart(40, '0')}`;
const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash(1), startBlock: '1', anchorHash: hash(1),
  factory: { address: address(1), codeHash: hash(2) }, marketplace: { address: address(2), codeHash: hash(3) },
});

function fixture(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = { ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_NETWORK: 'local',
    ONESHOT_INDEXER_MANIFEST_PATH: 'local-test-manifest.json', DATABASE_URL: 'postgresql://unused-local-unit-test', ...overrides };
  const pool = vi.fn<() => Pool | null>(() => null);
  const loadManifest = vi.fn(async () => manifest);
  const chain: ChainSource = {
    verify: vi.fn(async () => undefined), height: vi.fn(async () => 5n),
    block: vi.fn(async (number: bigint) => ({ number, hash: hash(Number(number)), parentHash: hash(Number(number) - 1), timestamp: 1_700_000_000n + number })),
    logs: vi.fn(async () => []),
  };
  const source = vi.fn(async () => chain);
  const resolveContent = vi.fn<(contentHash: string, tokenId: string) => Promise<IndexedNftPresentation | null>>(async () => null);
  const contentResolver = vi.fn<IndexedReaderDependencies['contentResolver']>(() => resolveContent);
  const reader = createIndexedNftReader({ pool, loadManifest, source, contentResolver, env: () => env });
  const read = (path: string, method = 'GET') => api(request => reader(request))(
    new NextRequest(`http://localhost/api/oneshot/indexed${path}`, { method }), {},
  );
  return { env, pool, loadManifest, chain, source, read, resolveContent, contentResolver };
}

function indexedFixture() {
  const state = fixture();
  const collections = [3, 4].map(id => ({ entity_id: address(id), value: {
    address: address(id), creator: address(8), name: `Collection ${id}`, symbol: 'SHOT', configured: true, opened: true,
    termsHash: hash(30), contentHash: hash(31), totalMinted: '1', primaryTotalPrice: '100', primaryPlatformFee: '2', primaryCreatorProceeds: '98', totalClaimed: '0',
    floorRaw: '12345', floorEnabled: true, allowlisted: true, privateEndpoint: 'https://private-rpc/secret-key',
  } }));
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (/^SELECT manifest_id/.test(sql)) return { rows: [{ manifest_id: 'fixture' }], rowCount: 1 };
    if (/^SELECT j.block_number/.test(sql)) return { rows: [{ block_number: '5', block_hash: hash(5), parent_hash: hash(4), block_timestamp: '1700000005', workerAlive: true, privateFloor: '12345' }], rowCount: 1 };
    if (/^SELECT to_regclass/.test(sql)) return { rows: [{ available: true }], rowCount: 1 };
    if (/^SELECT p.entity_id/.test(sql)) return { rows: projectedRows ?? (values?.[1] === address(3) ? collections.slice(1) : collections), rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  let projectedRows: Record<string, unknown>[] | undefined;
  state.pool.mockReturnValue({ connect: async () => ({ query, release }) } as unknown as Pool);
  return { ...state, query, release, collections, setRows: (rows: Record<string, unknown>[]) => { projectedRows = rows; } };
}

beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const publicPresentation = (contentHash: string, tokenId: string): IndexedNftPresentation => ({
  manifestHash: contentHash.slice(2), tokenId, name: `Committed original ${tokenId}`, description: 'Prepared public art',
  imagePath: `/api/media/${hash(40).slice(2)}.webp`, metadataPath: `/api/oneshot/metadata/${contentHash.slice(2)}/${tokenId}`,
  attributes: [{ trait_type: 'Edition', value: Number(tokenId) }],
});
const projectedItem = (tokenId = '2') => ({
  entity_id: `${address(3)}:${tokenId}`, value: { collection: address(3), tokenId, owner: address(8), burned: false }, listing_value: null,
});

describe('canonical indexed NFT presentation', () => {
  it('uses the held snapshot client for default content records without a nested pool checkout', async () => {
    const state = indexedFixture();
    const reader = createIndexedNftReader({ pool: state.pool, loadManifest: state.loadManifest, source: state.source, env: () => state.env });
    const response = await api(request => reader(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections?limit=1'), {});
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].presentation).toBeNull();
    expect(state.query).toHaveBeenCalledWith('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', ['oneshot_snapshots', hash(31).slice(2)]);
    expect(state.pool).toHaveBeenCalledOnce();
    expect(state.contentResolver).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith('COMMIT');
  });

  it('keeps standalone indexed history available when its optional content table is absent', async () => {
    const state = indexedFixture();
    const baseQuery = state.query.getMockImplementation()!;
    state.query.mockImplementation(async (sql, values) => /^SELECT to_regclass/.test(sql)
      ? { rows: [{ available: false }], rowCount: 1 } : baseQuery(sql, values));
    const reader = createIndexedNftReader({ pool: state.pool, loadManifest: state.loadManifest, source: state.source, env: () => state.env });
    const response = await api(request => reader(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections'), {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item: { presentation: unknown }) => item.presentation === null)).toBe(true);
    expect(state.query.mock.calls.filter(([sql]) => /^SELECT to_regclass/.test(sql))).toHaveLength(1);
    expect(state.query.mock.calls.some(([sql]) => /^SELECT value FROM b20_app_records/.test(sql))).toBe(false);
    expect(state.query).toHaveBeenCalledWith('COMMIT');
    expect(state.query).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('serializes concurrent default content lookups on the held SQL client', async () => {
    const state = indexedFixture();
    const baseQuery = state.query.getMockImplementation()!;
    const items = [{ serial: 1, metadataHash: hash(45).slice(2), metadataId: `${hash(45).slice(2)}.json`, imageHash: hash(46).slice(2) }];
    const manifestHash = createHash('sha256').update(stableJson({ items })).digest('hex');
    state.setRows(Array.from({ length: 8 }, (_, index) => ({ ...state.collections[0], entity_id: address(index + 100),
      value: { ...state.collections[0].value, address: address(index + 100), contentHash: index % 2 ? `0x${manifestHash}` : hash(index + 100) } })));
    let active = 0, maximum = 0;
    state.query.mockImplementation(async (sql, values) => {
      if (!/^SELECT (to_regclass|value FROM b20_app_records)/.test(sql)) return baseQuery(sql, values);
      active++; maximum = Math.max(maximum, active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (/^SELECT to_regclass/.test(sql)) return { rows: [{ available: true }], rowCount: 1 };
        if (values?.[0] === 'oneshot_snapshots' && values[1] === manifestHash) return { rows: [{ value: { manifestHash, items } }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } finally { active--; }
    });
    const reader = createIndexedNftReader({ pool: state.pool, loadManifest: state.loadManifest, source: state.source, env: () => state.env });
    const response = await api(request => reader(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections'), {});
    expect(response.status).toBe(200);
    expect(maximum).toBe(1); expect(active).toBe(0);
    expect(state.query.mock.calls.filter(([sql]) => /^SELECT to_regclass/.test(sql))).toHaveLength(1);
    expect(state.query).toHaveBeenCalledWith('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', ['media', items[0].metadataId]);
    expect(state.pool).toHaveBeenCalledOnce();
    expect(state.query).toHaveBeenCalledWith('COMMIT');
  });

  it.each(['availability', 'record'])('propagates the first default content SQL failure at %s and stops queued SQL', async stage => {
    const state = indexedFixture();
    const baseQuery = state.query.getMockImplementation()!;
    let recordCalls = 0;
    state.setRows(Array.from({ length: 8 }, (_, index) => ({ ...state.collections[0], entity_id: address(index + 100),
      value: { ...state.collections[0].value, address: address(index + 100), contentHash: hash(index + 100) } })));
    state.query.mockImplementation(async (sql, values) => {
      if (/^SELECT to_regclass/.test(sql) && stage === 'availability') throw new Error('private availability SQL failure');
      if (/^SELECT value FROM b20_app_records/.test(sql)) { recordCalls++; throw Object.assign(new Error('private record SQL failure'), { code: '08006' }); }
      return baseQuery(sql, values);
    });
    const reader = createIndexedNftReader({ pool: state.pool, loadManifest: state.loadManifest, source: state.source, env: () => state.env });
    const response = await api(request => reader(request))(new NextRequest('http://localhost/api/oneshot/indexed/collections'), {});
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'INDEXER_READ_UNAVAILABLE' } });
    expect(JSON.stringify(body)).not.toContain('private');
    expect(state.query.mock.calls.filter(([sql]) => /^SELECT to_regclass/.test(sql))).toHaveLength(1);
    expect(recordCalls).toBe(stage === 'availability' ? 0 : 1);
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.query).not.toHaveBeenCalledWith('COMMIT');
    expect(state.release).toHaveBeenCalledOnce();
  });

  it('attaches committed first-item art to collection cards and creates one resolver per request', async () => {
    const state = indexedFixture();
    state.resolveContent.mockImplementation(async (contentHash, tokenId) => publicPresentation(contentHash, tokenId));
    const response = await state.read('/collections?limit=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body.items[0].presentation).toEqual(publicPresentation(hash(31), '1'));
    expect(state.resolveContent).toHaveBeenCalledExactlyOnceWith(hash(31), '1');
    expect(state.contentResolver).toHaveBeenCalledOnce();
    expect(state.contentResolver.mock.calls[0][0]).toMatchObject({ query: state.query, release: state.release });
    expect(JSON.stringify(body)).not.toMatch(/floorRaw|floorEnabled|allowlisted|privateEndpoint|secret-key/);
    await state.read('/collections?limit=1');
    expect(state.contentResolver).toHaveBeenCalledTimes(2);
  });

  it.each([
    { opened: false, contentHash: hash(31) },
    { opened: true, contentHash: null },
    { opened: true, contentHash: hash(0) },
  ])('leaves presentation unavailable without an opened nonzero content commitment: %j', async policy => {
    const state = indexedFixture();
    state.setRows([{ ...state.collections[0], value: { ...state.collections[0].value, ...policy } }]);
    const response = await state.read('/collections');
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].presentation).toBeNull();
    expect(state.resolveContent).not.toHaveBeenCalled();
  });

  it.each([`/collections/${address(3)}/items/2`, `/collections/${address(3)}/items`, `/wallets/${address(8)}/items`])(
    'binds item art to its joined collection and exact token serial on %s', async path => {
      const state = indexedFixture();
      state.setRows([{ ...projectedItem(), collection_value: state.collections[0].value }]);
      state.resolveContent.mockImplementation(async (contentHash, tokenId) => publicPresentation(contentHash, tokenId));
      const response = await state.read(path);
      expect(response.status).toBe(200);
      const body = await response.json(), item = body.item ?? body.items[0];
      expect(item.presentation).toEqual(publicPresentation(hash(31), '2'));
      expect(state.resolveContent).toHaveBeenCalledExactlyOnceWith(hash(31), '2');
      const sql = state.query.mock.calls.find(([sql]) => /^SELECT p.entity_id/.test(sql))?.[0];
      expect(sql).toContain('c.value AS collection_value');
      expect(sql).toContain("c.manifest_id=p.manifest_id AND c.kind='collections' AND c.entity_id=p.value->>'collection'");
    },
  );

  it('keeps ownership available if the joined collection or stored content is absent', async () => {
    const state = indexedFixture();
    state.setRows([projectedItem()]);
    const missingCollection = await state.read(`/collections/${address(3)}/items/2`);
    expect(missingCollection.status).toBe(200);
    expect((await missingCollection.json()).item).toMatchObject({ tokenId: '2', owner: address(8), presentation: null });
    expect(state.resolveContent).not.toHaveBeenCalled();
    state.setRows([{ ...projectedItem(), collection_value: state.collections[0].value }]);
    const missingContent = await state.read(`/collections/${address(3)}/items/2`);
    expect(missingContent.status).toBe(200);
    expect((await missingContent.json()).item).toMatchObject({ owner: address(8), presentation: null });
    expect(state.resolveContent).toHaveBeenCalledExactlyOnceWith(hash(31), '2');
  });

  it('rejects a mismatched joined collection before resolving presentation', async () => {
    const state = indexedFixture();
    state.setRows([{ ...projectedItem(), collection_value: state.collections[1].value }]);
    const response = await state.read(`/collections/${address(3)}/items/2`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'INDEXER_DATA_INVALID' } });
    expect(state.resolveContent).not.toHaveBeenCalled();
  });

  it('checks canonicality again after content IO and suppresses an orphaned association', async () => {
    const state = indexedFixture();
    state.resolveContent.mockImplementation(async (contentHash, tokenId) => {
      expect(state.chain.block).not.toHaveBeenCalled();
      vi.mocked(state.chain.block).mockResolvedValue({ number: 5n, hash: hash(999), parentHash: hash(4), timestamp: 1700000005n });
      return publicPresentation(contentHash, tokenId);
    });
    const response = await state.read('/collections?limit=1');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'INDEXER_CHAIN_MOVED' } });
    expect(body).not.toHaveProperty('items');
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('retains storage/SQL failures instead of treating an aborted transaction as missing art', async () => {
    const state = indexedFixture();
    state.resolveContent.mockRejectedValue(Object.assign(new Error('private database connection lost'), { code: '08006' }));
    const response = await state.read('/collections?limit=1');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'INDEXER_READ_UNAVAILABLE' } });
    expect(JSON.stringify(body)).not.toContain('private database');
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('drains concurrent content lookups before releasing their shared transaction after a failure', async () => {
    const state = indexedFixture();
    let started!: () => void, finish!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { finish = resolve; });
    state.resolveContent.mockImplementationOnce(async () => { throw new Error('SQL lookup failed'); })
      .mockImplementationOnce(async () => { started(); await resume; return null; });
    const reading = state.read('/collections');
    await inFlight;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(state.release).not.toHaveBeenCalled();
    finish();
    expect((await reading).status).toBe(503);
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.release).toHaveBeenCalledOnce();
  });

  it('bounds presentation work to four calls and never resolves the extra pagination row', async () => {
    const state = indexedFixture();
    state.setRows(Array.from({ length: 51 }, (_, index) => ({ ...state.collections[0], entity_id: address(100 + index),
      value: { ...state.collections[0].value, address: address(100 + index), contentHash: hash(100 + index) } })));
    let active = 0, maximum = 0;
    state.resolveContent.mockImplementation(async (contentHash, tokenId) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--; return publicPresentation(contentHash, tokenId);
    });
    const response = await state.read('/collections?limit=50');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(50); expect(body.nextCursor).toBeTypeOf('string');
    expect(maximum).toBe(4); expect(active).toBe(0); expect(state.resolveContent).toHaveBeenCalledTimes(50);
    expect(state.resolveContent).not.toHaveBeenCalledWith(hash(150), '1');
    expect(body.items[0].address).toBe(address(100)); expect(body.items[49].address).toBe(address(149));
  });
});

describe('public indexed NFT request boundary', () => {
  it.each([undefined, '', 'false'])('does not initialize providers when the explicit read flag is %j', async value => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: value });
    const response = await state.read('/collections');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: { enabled: false, available: false, network: null, sync: null, readonly: true, finalized: false }, items: [], nextCursor: null });
    expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });

  it.each(['TRUE', '1', 'yes'])('rejects an invalid explicit read flag %j without initializing providers', async value => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: value });
    const response = await state.read('/collections');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'INDEXER_CONFIG_INVALID', message: 'This service is temporarily unavailable. Please try again later.' } });
    expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });

  it('returns a disabled detail without inventing an indexed item', async () => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: 'false' });
    const response = await state.read(`/collections/${address(5)}/items/1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: { enabled: false, available: false }, item: null });
  });

  it('offers disabled status without touching storage or identity providers', async () => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: 'false' });
    const response = await state.read('/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: { enabled: false, available: false, reason: 'NFT records are currently unavailable. You can still create and save collection drafts.' } });
    expect(state.pool).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });

  it.each(['/unknown', `/collections/${address(3)}/extra/path/parts`, `/wallets/${address(3)}/balance`])('rejects unknown resource %s even while disabled', async path => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: 'false' });
    expect((await state.read(path)).status).toBe(404);
    expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled();
  });

  it.each([
    '/collections/not-an-evm-address', `/collections/${address(3)}/items/not-a-token`,
    '/collections?limit=0', '/collections?limit=10000', '/collections?limit=1.5', '/collections?limit=1&limit=2',
    '/collections?unexpected=1', '/listings?status=expired', '/listings?collection=bad', '/listings?seller=bad',
    '/activity?wallet=bad', '/activity?collection=bad', '/wallets/invalid/items',
  ])('validates malformed paths or filters before configuration: %s', async path => {
    const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: 'false' });
    expect((await state.read(path)).status).toBe(400);
    expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });

  it.each(['not-json', '%%%', 'e30=', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ v: 1, unexpected: 'secret' })).toString('base64url')])(
    'rejects malformed or extra-field cursors before reading configuration: %s', async cursor => {
      const state = fixture({ ONESHOT_INDEXER_READS_ENABLED: 'false' });
      expect((await state.read(`/collections?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
      expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('refuses %s before any manifest/database or chain operation', async method => {
    const state = fixture();
    expect((await state.read('/collections', method)).status).toBe(405);
    expect(state.pool).not.toHaveBeenCalled(); expect(state.loadManifest).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });

  it.each([
    { ONESHOT_NETWORK: 'zero' }, { ONESHOT_NETWORK: undefined },
    { DATABASE_URL: undefined }, { ONESHOT_INDEXER_MANIFEST_PATH: undefined },
  ])('fails closed on incomplete or wrong-profile enabled configuration %j', async override => {
    const state = fixture(override);
    const response = await state.read('/collections');
    expect(response.status).toBe(503);
    expect(state.source).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('postgresql://');
  });

  it('does not silently fall back to browser files when the database pool is absent', async () => {
    const state = fixture();
    const response = await state.read('/collections');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('unused-local-unit-test');
  });

  it('translates a missing indexer schema without creating tables or exposing database errors', async () => {
    const state = fixture();
    const query = vi.fn(async (sql: string) => {
      if (/^SELECT manifest_id/.test(sql)) throw Object.assign(new Error('secret-db-host missing relation'), { code: '42P01' });
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    state.pool.mockReturnValue({ connect: async () => ({ query, release }) } as unknown as Pool);
    const response = await state.read('/collections');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'INDEXER_NOT_STARTED' } });
    expect(JSON.stringify(body)).not.toContain('secret-db-host');
    expect(query.mock.calls.map(([sql]) => sql).some(sql => /CREATE|INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });

  it('marks a deployment with no indexed head unavailable rather than reporting indexed assets', async () => {
    const state = fixture();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    state.pool.mockReturnValue({ connect: async () => ({ query, release }) } as unknown as Pool);
    const response = await state.read('/collections');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ context: { enabled: true, available: false, checkpoint: null, sync: null, readonly: true, finalized: false }, items: [], nextCursor: null });
    expect(query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query).toHaveBeenCalledWith('COMMIT'); expect(release).toHaveBeenCalledOnce();
    expect(state.chain.height).not.toHaveBeenCalled();
  });

  it('redacts a malformed manifest or failed source verification', async () => {
    const badManifest = fixture();
    badManifest.loadManifest.mockRejectedValue(new Error('C:/private/manifest-secret.json'));
    const failedManifest = await badManifest.read('/status');
    expect(failedManifest.status).toBe(503);
    expect(await failedManifest.json()).toMatchObject({ error: { code: 'INDEXER_MANIFEST_INVALID' } });
    const badSource = fixture();
    badSource.source.mockRejectedValue(new Error('https://private-rpc/key-secret'));
    const failedSource = await badSource.read('/status');
    expect(failedSource.status).toBe(503);
    const body = await failedSource.json();
    expect(body).toMatchObject({ error: { code: 'INDEXER_CHAIN_UNAVAILABLE' } });
    expect(JSON.stringify(body)).not.toContain('key-secret');
  });

  it('routes public indexed GETs before Privy authentication with the existing CORS policy', async () => {
    vi.stubEnv('ONESHOT_INDEXER_READS_ENABLED', 'false');
    const session = vi.spyOn(auth, 'requireOneshotSession').mockRejectedValue(new Error('Authentication must not be attempted'));
    const response = await oneshotApi(new NextRequest('http://localhost/api/oneshot/indexed/collections', { headers: { Origin: 'http://localhost' } }), {});
    expect(response.status).toBe(200); expect(session).not.toHaveBeenCalled();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const forbidden = await oneshotApi(new NextRequest('http://localhost/api/oneshot/indexed/collections', { headers: { Origin: 'https://foreign.example' } }), {});
    expect(forbidden.status).toBe(403); expect(session).not.toHaveBeenCalled();
  });
});

describe('observed indexed NFT freshness', () => {
  it.each([5n, 6n, 900719925474099312345n])('reports exact distance from the canonical snapshot at observed chain height %s', async height => {
    const state = indexedFixture();
    vi.mocked(state.chain.height).mockResolvedValue(height);
    const response = await state.read('/collections');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.context).toMatchObject({ available: true, checkpoint: { number: '5', hash: hash(5) }, sync: { chainHead: height.toString(), behindBlocks: (height - 5n).toString() }, readonly: true, finalized: false });
    expect(state.chain.height).toHaveBeenCalledOnce();
    expect(state.chain.block).toHaveBeenCalledExactlyOnceWith(5n);
    expect(state.query).toHaveBeenCalledWith('COMMIT');
    expect(JSON.stringify(body)).not.toMatch(/floorRaw|floorEnabled|allowlisted|workerAlive|privateFloor|private-rpc|secret-key/);
  });

  it('keeps checkpoint pagination valid when only the observed chain head advances', async () => {
    const state = indexedFixture();
    const first = await (await state.read('/collections?limit=1')).json();
    expect(first.nextCursor).toBeTypeOf('string');
    vi.mocked(state.chain.height).mockResolvedValue(8n);
    const response = await state.read(`/collections?limit=1&cursor=${first.nextCursor}`);
    expect(response.status).toBe(200);
    const second = await response.json();
    expect(second.context.checkpoint).toEqual(first.context.checkpoint);
    expect(second.context.sync).toEqual({ chainHead: '8', behindBlocks: '3' });
    expect(second.items.map((row: { address: string }) => row.address)).toEqual([address(4)]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([-1n, 5, '5', null, undefined])('fails closed when a chain provider returns malformed height %s', async height => {
    const state = indexedFixture();
    vi.mocked(state.chain.height).mockResolvedValue(height as bigint);
    const response = await state.read('/status');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'INDEXER_CHAIN_UNAVAILABLE' } });
    expect(state.chain.block).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.release).toHaveBeenCalledOnce();
  });

  it('refuses a checkpoint above the observed chain head without publishing freshness', async () => {
    const state = indexedFixture();
    vi.mocked(state.chain.height).mockResolvedValue(4n);
    const response = await state.read('/status');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'INDEXER_CHAIN_MOVED' } });
    expect(state.chain.block).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('refuses an orphaned checkpoint even when the chain has advanced', async () => {
    const state = indexedFixture();
    vi.mocked(state.chain.height).mockResolvedValue(12n);
    vi.mocked(state.chain.block).mockResolvedValue({ number: 5n, hash: hash(99), parentHash: hash(4), timestamp: 1700000005n });
    const response = await state.read('/status');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'INDEXER_CHAIN_MOVED' } });
    expect(state.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
