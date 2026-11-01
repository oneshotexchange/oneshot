import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from '@b20/sdk';
import { allowlistTree, prepareDraft, saveDraft, type Draft } from './drafts';
import { normalizeAddress } from './config';
import { getRecord, listRecords, putRecord, putVersionedRecord } from './store';
import { buildTransaction, confirmTransaction } from './transactions';

const mocks = vi.hoisted(() => ({
  chainFetch: vi.fn(),
  nftPackage: vi.fn(),
  nftDeployment: vi.fn(),
  fetchPublicResource: vi.fn(),
}));

vi.mock('./config', async importOriginal => ({
  ...await importOriginal<typeof import('./config')>(),
  chainFetch: mocks.chainFetch,
  nftPackage: mocks.nftPackage,
  nftDeployment: mocks.nftDeployment,
}));
vi.mock('./public-fetch', () => ({ fetchPublicResource: mocks.fetchPublicResource }));

const PKG = normalizeAddress('0xb20');
const OWNER = normalizeAddress('0xa');
const BUYER = normalizeAddress('0xb');
const COLLECTION = normalizeAddress('0xc');
const TOKEN = normalizeAddress('0xd');
const LISTING = normalizeAddress('0xe');
const HASH = `0x${'1'.repeat(64)}`;
const OLD_HASH = `0x${'2'.repeat(64)}`;
const NOW = Date.UTC(2030, 0, 1);
const ORIGIN = 'https://b20.example';
const MANIFEST_HASH = 'a'.repeat(64);
const BASE_URI = `${ORIGIN}/api/metadata/${MANIFEST_HASH}/`;
const COLLECTION_URI = `${ORIGIN}/api/media/${'b'.repeat(64)}.json`;
const TEST_ROOT = resolve('.local/transaction-tests');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const seconds = (date: string | undefined) => String(Date.parse(date!) / 1000);

function draftFixture(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'prepared-draft', owner: OWNER, status: 'prepared', createdAt: iso(-60_000),
    name: 'B20 regression collection', description: 'Immutable test metadata',
    maxSupply: 3, royaltyBps: 500, perWalletLimit: 2,
    publicPriceApt: '1.25', allowlistPriceApt: '0.5', allowlistAddresses: [],
    publicStart: iso(3_600_000), publicEnd: iso(86_400_000),
    allowlistStart: iso(300_000), allowlistEnd: iso(3_600_000),
    metadataMode: 'upload', imageUrl: 'https://art.example/cover.png',
    manifestHash: MANIFEST_HASH, baseUri: BASE_URI, collectionUri: COLLECTION_URI,
    ...overrides,
  };
}

/** Exact nft_launch::CollectionView JSON shape: u64 values are decimal strings. */
function mockCollectionView(draft: Draft, overrides: Record<string, unknown> = {}) {
  const allow = draft.allowlistAddresses.length > 0;
  return {
    collection: COLLECTION, creator: draft.owner, name: draft.name,
    metadata_base_uri: draft.baseUri, max_supply: String(draft.maxSupply),
    minted: '0', royalty_bps: String(draft.royaltyBps), opened: false, configured: false,
    allowlist_root: allowlistTree(COLLECTION, draft.allowlistAddresses).root,
    allowlist_start: allow ? seconds(draft.allowlistStart) : '0',
    allowlist_end: allow ? seconds(draft.allowlistEnd) : '0',
    allowlist_price_octas: allow ? parseUnits(draft.allowlistPriceApt).toString() : '0',
    allowlist_wallet_limit: allow ? String(draft.perWalletLimit) : '0',
    public_start: seconds(draft.publicStart), public_end: seconds(draft.publicEnd),
    public_price_octas: parseUnits(draft.publicPriceApt).toString(),
    public_wallet_limit: String(draft.perWalletLimit),
    ...overrides,
  };
}

function committedTransaction(version: string, events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: 'user_transaction', success: true, sender: OWNER, version,
    timestamp: String(BigInt(NOW) * 1000n), events, ...overrides,
  };
}

function createdTransaction(draft: Draft) {
  return committedTransaction('100', [{
    type: `${PKG}::nft_launch::CollectionCreated`,
    data: { collection: COLLECTION, creator: OWNER, name: draft.name,
      max_supply: String(draft.maxSupply), royalty_bps: String(draft.royaltyBps) },
  }]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let temporaryDirectory: string;
let collectionView: ReturnType<typeof mockCollectionView>;
let transactions: Map<string, ReturnType<typeof committedTransaction>>;

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  temporaryDirectory = await mkdtemp(join(TEST_ROOT, 'b20-transactions-test-'));
  vi.stubEnv('B20_DATA_DIR', temporaryDirectory);
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('S3_BUCKET', '');
  vi.stubEnv('B20_MEDIA_LIMIT_BYTES', String(1024 * 1024));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  mocks.chainFetch.mockReset();
  mocks.nftPackage.mockReset().mockReturnValue(PKG);
  mocks.nftDeployment.mockReset().mockResolvedValue({ ready: true, address: PKG });
  mocks.fetchPublicResource.mockReset().mockRejectedValue(new Error('Unexpected external metadata fetch'));
  collectionView = mockCollectionView(draftFixture());
  transactions = new Map();
  mocks.chainFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/view') {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toEqual({
        function: `${PKG}::nft_launch::get_collection`, type_arguments: [], arguments: [COLLECTION],
      });
      return [collectionView];
    }
    const transaction = transactions.get(path.replace('/transactions/by_hash/', ''));
    if (!transaction) throw new Error(`Unexpected fullnode request: ${path}`);
    return transaction;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Delete only the direct child allocated by this test, after checking its absolute path.
  const target = resolve(temporaryDirectory);
  if (dirname(target) !== TEST_ROOT || !basename(target).startsWith('b20-transactions-test-')) {
    throw new Error('Unexpected regression-test cleanup path');
  }
  await rm(target, { recursive: true, force: true });
});

describe('contract transaction confirmation and immutable draft binding', () => {
  it('confirms configure_mint without events and links its authenticated creator draft', async () => {
    const draft = draftFixture({ collectionId: COLLECTION, status: 'created' });
    await putRecord('drafts', draft.id, draft);
    collectionView = mockCollectionView(draft, { configured: true });
    transactions.set(HASH, committedTransaction('101', [], {
      payload: { function: `${PKG}::nft_launch::configure_mint`, arguments: [COLLECTION] },
    }));

    await expect(confirmTransaction(HASH, draft.id, OWNER)).resolves.toEqual({
      success: true, transactionHash: HASH, version: '101', collectionId: COLLECTION, action: 'configure_mint',
    });
    expect(await getRecord('collection_drafts', COLLECTION)).toEqual({ draftId: draft.id, owner: OWNER });
    expect(await getRecord('drafts', draft.id)).toMatchObject({ status: 'configured', collectionId: COLLECTION });
    expect(await getRecord('receipts', HASH)).toMatchObject({ packageAddress: PKG, collectionCreator: OWNER });
  });

  it('does not accept an eventless configure transaction sent by another wallet', async () => {
    const draft = draftFixture({ collectionId: COLLECTION, status: 'created' });
    await putRecord('drafts', draft.id, draft);
    transactions.set(HASH, committedTransaction('101', [], {
      sender: BUYER, payload: { function: `${PKG}::nft_launch::configure_mint`, arguments: [COLLECTION] },
    }));

    await expect(confirmTransaction(HASH, draft.id, OWNER)).rejects.toMatchObject({ code: 'UNRELATED_TRANSACTION' });
    expect(await getRecord('collection_drafts', COLLECTION)).toBeNull();
  });

  it('binds a creator draft even when a public request already cached the create receipt', async () => {
    const draft = draftFixture();
    await putRecord('drafts', draft.id, draft);
    collectionView = mockCollectionView(draft);
    transactions.set(HASH, createdTransaction(draft));

    const publicReceipt = await confirmTransaction(HASH);
    expect(await getRecord('collection_drafts', COLLECTION)).toBeNull();
    await expect(confirmTransaction(HASH, draft.id, OWNER)).resolves.toEqual(publicReceipt);
    expect(await getRecord('collection_drafts', COLLECTION)).toEqual({ draftId: draft.id, owner: OWNER });
    expect(await getRecord('drafts', draft.id)).toMatchObject({ status: 'created', collectionId: COLLECTION });
    expect(await getRecord('collections', COLLECTION)).toMatchObject({
      manifestHash: MANIFEST_HASH, description: draft.description, imageUrl: draft.imageUrl,
    });
  });

  it('keeps an existing collection link when another matching draft has a different allowlist', async () => {
    const first = draftFixture({ allowlistAddresses: [OWNER] });
    const second = draftFixture({ id: 'other-draft', allowlistAddresses: [BUYER] });
    await putRecord('drafts', first.id, first);
    await putRecord('drafts', second.id, second);
    collectionView = mockCollectionView(first);
    transactions.set(HASH, createdTransaction(first));
    await confirmTransaction(HASH, first.id, OWNER);

    await expect(confirmTransaction(HASH, second.id, OWNER)).rejects.toMatchObject({ code: 'COLLECTION_ALREADY_BOUND' });
    expect(await getRecord('collection_drafts', COLLECTION)).toEqual({ draftId: first.id, owner: OWNER });
    expect(await getRecord('drafts', second.id)).toEqual(second);
  });

  it('rejects a different allowlist against the configured on-chain root before binding it', async () => {
    const first = draftFixture({ allowlistAddresses: [OWNER, BUYER] });
    const second = draftFixture({ id: 'wrong-root-draft', allowlistAddresses: [BUYER] });
    await putRecord('drafts', first.id, first);
    await putRecord('drafts', second.id, second);
    collectionView = mockCollectionView(first, { configured: true, opened: true });
    transactions.set(HASH, createdTransaction(first));
    await confirmTransaction(HASH, first.id, OWNER);

    await expect(confirmTransaction(HASH, second.id, OWNER)).rejects.toMatchObject({ code: 'MINT_TERMS_MISMATCH' });
    expect(await getRecord('collection_drafts', COLLECTION)).toEqual({ draftId: first.id, owner: OWNER });
    expect(await getRecord('drafts', first.id)).toMatchObject({ status: 'open' });
    expect(await getRecord('drafts', second.id)).toEqual(second);
  });

  it('builds allowlist proofs from the collection link after the draft leaves the global 200-record page', async () => {
    const draft = draftFixture({
      status: 'open', collectionId: COLLECTION, allowlistAddresses: [OWNER, BUYER, '0xf'],
      allowlistStart: iso(-60_000), allowlistEnd: iso(3_600_000),
    });
    await putRecord('drafts', draft.id, draft);
    await putRecord('collection_drafts', COLLECTION, { draftId: draft.id, owner: OWNER });
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      putRecord('drafts', `later-draft-${index}`, draftFixture({ id: `later-draft-${index}`, owner: BUYER }))));
    expect((await listRecords<Draft>('drafts')).some(item => item.id === draft.id)).toBe(false);
    collectionView = mockCollectionView(draft, { opened: true, configured: true });

    const result = await buildTransaction({ action: 'mint', sender: OWNER, collectionId: COLLECTION, quantity: 2 });
    expect(result.payload).toEqual({
      function: `${PKG}::nft_launch::mint_nft`, typeArguments: [],
      functionArguments: [COLLECTION, '2', allowlistTree(COLLECTION, draft.allowlistAddresses, OWNER).proof, '100000000'],
    });
    expect(result.review).toMatchObject({ phase: 'allowlist', quantity: 2, totalPriceOctas: '100000000' });
  });
});

describe('versioned NFT ownership projections', () => {
  it('does not resurrect a listing when an older confirmation finishes after its sale', async () => {
    await putVersionedRecord('nfts', TOKEN, {
      id: TOKEN, collectionId: COLLECTION, serial: 1, owner: OWNER,
    }, '90071992547409930');
    const listed = committedTransaction('90071992547409931', [{
      type: `${PKG}::marketplace::Listed`, data: {
        listing: LISTING, token: TOKEN, collection: COLLECTION, seller: OWNER, price_octas: '100000000',
      },
    }]);
    const sold = committedTransaction('90071992547409932', [{
      type: `${PKG}::marketplace::Sold`, data: {
        listing: LISTING, token: TOKEN, collection: COLLECTION, seller: OWNER, buyer: BUYER,
        price_octas: '100000000', platform_fee_octas: '2000000', royalty_octas: '5000000',
        seller_proceeds_octas: '93000000',
      },
    }]);
    const oldRequestEntered = deferred<void>();
    const oldResponse = deferred<ReturnType<typeof committedTransaction>>();
    const defaultFetch = mocks.chainFetch.getMockImplementation()!;
    mocks.chainFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === `/transactions/by_hash/${OLD_HASH}`) {
        oldRequestEntered.resolve();
        return oldResponse.promise;
      }
      return defaultFetch(path, init);
    });
    transactions.set(HASH, sold);

    const staleConfirmation = confirmTransaction(OLD_HASH);
    await oldRequestEntered.promise;
    await confirmTransaction(HASH);
    oldResponse.resolve(listed);
    await staleConfirmation;

    expect(await getRecord('nfts', TOKEN)).toMatchObject({
      owner: BUYER, listingId: null, seller: null, priceApt: null, serial: 1,
      lastVersion: '90071992547409932',
    });
    expect(await getRecord('activity', '90071992547409931:0')).toMatchObject({ type: 'Listed' });
    expect(await getRecord('activity', '90071992547409932:0')).toMatchObject({ type: 'Sold' });
  });

  it('atomically rejects a stale projection built before a concurrent newer update', async () => {
    await putVersionedRecord('nfts', TOKEN, { id: TOKEN, owner: OWNER, serial: 1 }, '100');
    const staleSnapshot = await getRecord('nfts', TOKEN);
    const releaseStaleWrite = deferred<void>();
    const staleWrite = releaseStaleWrite.promise.then(() => putVersionedRecord('nfts', TOKEN, {
      ...staleSnapshot, owner: LISTING, listingId: LISTING, seller: OWNER, priceApt: '1',
    }, '101'));
    await putVersionedRecord('nfts', TOKEN, {
      owner: BUYER, listingId: null, seller: null, priceApt: null,
    }, '102');
    releaseStaleWrite.resolve();
    await staleWrite;

    expect(await getRecord('nfts', TOKEN)).toEqual({
      id: TOKEN, serial: 1, owner: BUYER, listingId: null, seller: null, priceApt: null, lastVersion: '102',
    });
  });
});

describe('metadata preparation cannot rewind a collection', () => {
  it.each(['created', 'open'] as const)('preserves %s state when an older preparation finishes', async status => {
    const draft = draftFixture({
      status: 'draft', maxSupply: 1, perWalletLimit: 1,
      baseUri: undefined, collectionUri: undefined, manifestHash: undefined,
    });
    await putRecord('drafts', draft.id, draft);
    const entered = deferred<void>();
    const response = deferred<{ buffer: Buffer; contentType: string }>();
    mocks.fetchPublicResource.mockImplementation(() => { entered.resolve(); return response.promise; });
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();

    const preparation = prepareDraft(draft.id, OWNER, ORIGIN);
    await entered.promise;
    const advanced = { ...draft, status, collectionId: COLLECTION,
      baseUri: BASE_URI, collectionUri: COLLECTION_URI, manifestHash: MANIFEST_HASH };
    await putRecord('drafts', draft.id, advanced);
    response.resolve({ buffer: image, contentType: 'image/png' });

    await expect(preparation).resolves.toEqual(advanced);
    expect(await getRecord('drafts', draft.id)).toEqual(advanced);
  });

  it('requires an HTTPS metadata origin before fetching or preparing immutable snapshots', async () => {
    const draft = draftFixture({ status: 'draft' });
    await putRecord('drafts', draft.id, draft);

    await expect(prepareDraft(draft.id, OWNER, 'http://localhost:3000')).rejects.toMatchObject({
      status: 409, code: 'HTTPS_METADATA_REQUIRED',
    });
    expect(mocks.fetchPublicResource).not.toHaveBeenCalled();
    expect(await getRecord('drafts', draft.id)).toEqual(draft);
  });

  it.each(['not-a-date', iso(3_600_000), iso(3_599_000)])('rejects invalid or non-increasing public mint end %s', async publicEnd => {
    await expect(saveDraft({
      name: 'Bad schedule', maxSupply: 1, publicStart: iso(3_600_000), publicEnd,
    }, OWNER)).rejects.toMatchObject({ status: 400, code: 'INVALID_SCHEDULE' });
    expect(await listRecords('drafts')).toEqual([]);
  });
});
