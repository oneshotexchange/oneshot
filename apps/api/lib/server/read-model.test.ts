import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAddress } from './config';
import { ApiError } from './http';
import { nftIndex, nftPage } from './read-model';
import { discoverOwnership, mapOwnership, OwnershipBudget } from './ownership';

const mocks = vi.hoisted(() => ({ chainFetch: vi.fn(), nftPackage: vi.fn(), database: vi.fn(), getRecord: vi.fn(), listRecords: vi.fn(), query: vi.fn() }));
vi.mock('./config', async original => ({
  ...await original<typeof import('./config')>(), chainFetch: mocks.chainFetch,
  nftPackage: mocks.nftPackage, graphql: () => 'https://indexer.test/v1/graphql',
}));
vi.mock('./store', () => ({ database: mocks.database, getRecord: mocks.getRecord, listRecords: mocks.listRecords }));

const PKG = normalizeAddress('0xb20');
const OWNER = normalizeAddress('0xa');
const OTHER = normalizeAddress('0xb');
const COLLECTION = normalizeAddress('0xc');
const OLD = normalizeAddress('0xd');
const INCOMING = normalizeAddress('0xe');
const FOREIGN = normalizeAddress('0xf');
const LISTING = normalizeAddress('0x11');

const row = (token: string, owner = OWNER) => ({ token_data_id: token, owner_address: owner, amount: '1', token_standard: 'v2', last_transaction_version: '90071992547409931', current_token_data: { collection_id: COLLECTION } });
const resources = (owner: string, overrides: { package?: string; collection?: string; serial?: string } = {}) => [
  { type: `${overrides.package ?? PKG}::nft_launch::Provenance`, data: { collection: overrides.collection ?? COLLECTION, serial: overrides.serial ?? '2' } },
  { type: '0x1::object::ObjectCore', data: { owner } },
  { type: '0x4::token::Token', data: { name: 'An actual B20 original' } },
];
let fetchMock: ReturnType<typeof vi.fn>;
let custody: Map<string, unknown[]>;
let activeListings: Map<string, Record<string, string>>;
let now = Date.now();

beforeEach(() => {
  now += 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('APTOS_API_KEY', 'test-server-key');
  vi.stubEnv('GEOMI_API_KEY', '');
  mocks.nftPackage.mockReset().mockReturnValue(PKG);
  mocks.database.mockReset().mockReturnValue({ query: mocks.query });
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.getRecord.mockReset().mockResolvedValue(null);
  mocks.listRecords.mockReset().mockResolvedValue([]);
  fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [] } }));
  vi.stubGlobal('fetch', fetchMock);
  custody = new Map(); activeListings = new Map();
  mocks.chainFetch.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/view') {
      const input = JSON.parse(String(init?.body));
      const listing = activeListings.get(input.arguments[0]);
      if (input.function === `${PKG}::marketplace::is_active`) return [Boolean(listing)];
      if (input.function === `${PKG}::marketplace::get_listing` && listing) return [listing];
      throw new Error('Unexpected marketplace view');
    }
    const token = path.match(/^\/accounts\/(0x[0-9a-f]+)\/resources$/)?.[1];
    if (token && custody.has(token)) return custody.get(token);
    throw new ApiError(503, 'CHAIN_REQUEST_FAILED', 'Test fullnode unavailable');
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('NFT ownership refresh across ordinary DA transfers', () => {
  it('leaves native-APT-only portfolios available before a B20 NFT deployment exists', async () => {
    mocks.nftPackage.mockReturnValue(null);
    await expect(nftPage(undefined, OWNER)).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.chainFetch).not.toHaveBeenCalled();
  });

  it('discovers an external incoming token absent from B20 projections and removes an outgoing token', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, collection_address: COLLECTION, owner_address: OWNER, serial: '1' }] });
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING)] } }));
    custody.set(OLD, resources(OTHER)); custody.set(INCOMING, resources(OWNER));

    const items = await nftIndex(undefined, OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: INCOMING, collectionId: COLLECTION, owner: OWNER, serial: 2, name: 'An actual B20 original', ownershipSource: 'aptos-fullnode' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://indexer.test/v1/graphql');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', headers: { Authorization: 'Bearer test-server-key' } });
    expect(JSON.parse(init.body).variables.where._and).toContainEqual({ owner_address: { _eq: OWNER } });
    expect(JSON.stringify(items)).not.toContain('test-server-key');
  });

  it('rejects a stale hosted owner after a fullnode transfer, even if both projections still name the old owner', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: OWNER }] });
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(OLD)] } }));
    custody.set(OLD, resources(OTHER));
    await expect(nftIndex(undefined, OWNER)).resolves.toEqual([]);
  });

  it('ignores arbitrary tokens claiming the same collection unless configured B20 Provenance exists', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING), row(FOREIGN)] } }));
    custody.set(INCOMING, resources(OWNER)); custody.set(FOREIGN, resources(OWNER, { package: '0xf00d' }));
    const items = await nftIndex(undefined, OWNER);
    expect(items.map(item => item.id)).toEqual([INCOMING]);
    expect(mocks.chainFetch.mock.calls.filter(([path]) => path === '/view')).toHaveLength(1);
  });

  it('refreshes collection owners and discovers collection items absent from the B20 event store', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: OWNER }] });
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING, OTHER)] } }));
    custody.set(OLD, resources(OTHER)); custody.set(INCOMING, resources(OTHER, { serial: '3' }));
    const items = await nftIndex(COLLECTION);
    expect(items.map(item => [item.id, item.owner])).toEqual([[OLD, OTHER], [INCOMING, OTHER]]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.where._and).toContainEqual({ current_token_data: { collection_id: { _eq: COLLECTION } } });
  });

  it('matches compact package-address spelling in fullnode Provenance resources', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING)] } }));
    custody.set(INCOMING, resources(OWNER, { package: '0xb20' }));
    await expect(nftIndex(undefined, OWNER)).resolves.toMatchObject([{ id: INCOMING }]);
  });

  it('also refreshes the local-development candidate store without retaining stale owners', async () => {
    mocks.database.mockReturnValue(null);
    mocks.listRecords.mockResolvedValue([{ id: OLD, collectionId: COLLECTION, owner: OWNER }]);
    custody.set(OLD, resources(OTHER));
    await expect(nftIndex(undefined, OWNER)).resolves.toEqual([]);
  });
});

describe('current escrow and seller portfolio semantics', () => {
  it('includes a listed token for its seller while correctly reporting escrow custody', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: LISTING, listing_address: LISTING, seller_address: OWNER, price_octas: '100000000' }] });
    custody.set(OLD, resources(LISTING));
    activeListings.set(LISTING, { listing: LISTING, token: OLD, collection: COLLECTION, seller: OWNER, price_octas: '100000000' });
    const items = await nftIndex(undefined, OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: OLD, owner: LISTING, seller: OWNER, listingId: LISTING, priceApt: '1' });
    expect(mocks.query.mock.calls[0][0]).toContain('l.seller_address');
  });

  it('clears obsolete listing metadata after cancellation instead of copying projected escrow', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: LISTING, listing_address: LISTING, seller_address: OWNER, price_octas: '100000000' }] });
    custody.set(OLD, resources(OWNER));
    const [item] = await nftIndex(undefined, OWNER);
    expect(item.owner).toBe(OWNER);
    expect(item.listingId).toBeUndefined(); expect(item.seller).toBeUndefined(); expect(item.priceApt).toBeUndefined();
  });

  it('removes an obsolete seller listing after sale to a different wallet', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: LISTING, listing_address: LISTING, seller_address: OWNER }] });
    custody.set(OLD, resources(OTHER));
    await expect(nftIndex(undefined, OWNER)).resolves.toEqual([]);
  });

  it('does not present an active listing whose token no longer matches the escrow object', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: LISTING }] });
    custody.set(OLD, resources(LISTING));
    activeListings.set(LISTING, { listing: LISTING, token: INCOMING, collection: COLLECTION, seller: OWNER, price_octas: '100000000' });
    await expect(nftIndex(undefined, OWNER)).rejects.toMatchObject({ code: 'NFT_LISTING_REFRESH_FAILED', status: 503 });
  });
});

describe('unavailable and bounded hosted ownership reads', () => {
  it('returns an actionable error without substituting event-projection ownership when GraphQL fails', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: OWNER }] });
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(nftIndex(undefined, OWNER)).rejects.toMatchObject({ code: 'OWNERSHIP_INDEXER_UNAVAILABLE', status: 503, message: expect.stringContaining('indexer URL') });
    expect(mocks.chainFetch).not.toHaveBeenCalled();
  });

  it('rejects partial GraphQL data with errors rather than treating it as an empty portfolio', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [] }, errors: [{ message: 'Permission denied' }] }));
    await expect(nftIndex(undefined, OWNER)).rejects.toMatchObject({ code: 'OWNERSHIP_INDEXER_UNAVAILABLE' });
  });

  it('does not copy a hosted or cached owner when fullnode custody verification fails', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING)] } }));
    await expect(nftIndex(undefined, OWNER)).rejects.toMatchObject({ code: 'OWNERSHIP_FULLNODE_UNAVAILABLE', status: 503 });
  });

  it('omits a disappeared token after a fullnode 404 instead of retaining its projected owner', async () => {
    mocks.query.mockResolvedValue({ rows: [{ token_address: OLD, owner_address: OWNER }] });
    mocks.chainFetch.mockRejectedValue(new ApiError(404, 'CHAIN_REQUEST_FAILED', 'Token no longer exists'));
    await expect(nftIndex(undefined, OWNER)).resolves.toEqual([]);
  });

  it('stops scheduling ownership work after a fullnode failure instead of draining the entire scan', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('Unavailable'));
    await expect(mapOwnership(Array.from({ length: 100 }, (_, index) => index), refresh)).rejects.toThrow('Unavailable');
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it('requests only 21 discovery candidates after the supplied token-address cursor', async () => {
    const cursor = normalizeAddress('0x1000');
    const first = Array.from({ length: 21 }, (_, index) => row(normalizeAddress(`0x${(0x1001 + index).toString(16)}`)));
    fetchMock.mockResolvedValueOnce(Response.json({ data: { current_token_ownerships_v2: first } }));
    const found = await discoverOwnership({ owner: OWNER, knownTokens: [], cursor });
    expect(found).toHaveLength(21);
    const { variables } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(variables.limit).toBe(21);
    expect(variables.where._and).toContainEqual({ token_data_id: { _gt: cursor } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('advances across a foreign-only page without exhausting a large wallet or hiding its next page', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const { variables } = JSON.parse(init.body);
      const after = variables.where._and.find((condition: any) => condition.token_data_id?._gt)?.token_data_id._gt;
      const start = after ? Number(BigInt(after)) + 1 : 0x1000;
      const items = Array.from({ length: variables.limit }, (_, index) => row(normalizeAddress(`0x${(start + index).toString(16)}`)));
      for (const item of items) custody.set(item.token_data_id, resources(OWNER, { package: '0xf00d' }));
      return Response.json({ data: { current_token_ownerships_v2: items } });
    });
    const first = await nftPage(undefined, OWNER);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBe(normalizeAddress('0x1013'));
    const second = await nftPage(undefined, OWNER, first.nextCursor!);
    expect(second.nextCursor).toBe(normalizeAddress('0x1027'));
    expect(mocks.chainFetch).toHaveBeenCalledTimes(40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps page fullnode work within 60 calls even when all 20 NFTs are listed', async () => {
    const tokens = Array.from({ length: 21 }, (_, index) => normalizeAddress(`0x${(0x1000 + index).toString(16)}`));
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: tokens.map(token => row(token)) } }));
    for (const token of tokens) {
      const listing = normalizeAddress(`0x${(BigInt(token) + 0x1000n).toString(16)}`);
      custody.set(token, resources(listing));
      activeListings.set(listing, { listing, token, collection: COLLECTION, seller: OWNER, price_octas: '100000000' });
    }
    const page = await nftPage(undefined, OWNER);
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(tokens[19]);
    expect(mocks.chainFetch).toHaveBeenCalledTimes(60);
  });

  it('labels a five-second observed snapshot and never uses an expired cache as an outage fallback', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { current_token_ownerships_v2: [row(INCOMING)] } }));
    custody.set(INCOMING, resources(OWNER));
    const first = await nftPage(undefined, OWNER);
    expect(first.items[0]).toMatchObject({ ownershipObservedAt: expect.any(String), ownershipCacheMaxAgeSeconds: 5, ownershipSource: 'aptos-fullnode' });
    expect(await nftPage(undefined, OWNER)).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 5001;
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(nftPage(undefined, OWNER)).rejects.toMatchObject({ code: 'OWNERSHIP_INDEXER_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates simultaneous refreshes for the same page', async () => {
    let complete!: (response: Response) => void;
    const response = new Promise<Response>(done => { complete = done; });
    fetchMock.mockReturnValue(response);
    const first = nftPage(undefined, OWNER);
    const second = nftPage(undefined, OWNER);
    complete(Response.json({ data: { current_token_ownerships_v2: [] } }));
    expect(await first).toEqual(await second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an indexer fetch at the shared deadline with an actionable budget error', async () => {
    const budget = new OwnershipBudget(15);
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    try {
      await expect(discoverOwnership({ owner: OWNER, knownTokens: [] }, budget)).rejects.toMatchObject({ code: 'OWNERSHIP_REFRESH_BUDGET', status: 503 });
      expect(budget.signal.aborted).toBe(true);
    } finally { budget.close(); }
  });

  it('aborts and settles all in-flight ownership tasks before returning a failed page', async () => {
    const budget = new OwnershipBudget();
    let settled = 0;
    try {
      const operation = mapOwnership(Array.from({ length: 30 }, (_, index) => index), async index => {
        if (index === 0) throw new Error('First task failed');
        await new Promise<void>(done => budget.signal.addEventListener('abort', () => { settled++; done(); }, { once: true }));
      }, error => budget.fail(error));
      await expect(operation).rejects.toThrow('First task failed');
      expect(settled).toBe(5);
      expect(budget.signal.aborted).toBe(true);
    } finally { budget.close(); }
  });
});
