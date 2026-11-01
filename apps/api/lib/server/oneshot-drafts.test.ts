import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { lookup } from 'node:dns/promises';
import { createOneshotDraft, getOneshotDraft, listOneshotDrafts, updateOneshotDraft, archiveOneshotDraft, prepareOneshotDraft, readOneshotMetadata, verifyPreparedOneshotSnapshot } from './oneshot-drafts';
import { oneshotDraftSchema } from '../../../web/lib/oneshot-draft-schema';
import { storeImage, storeBlob } from './media';
import { putRecord, getRecord, listRecords } from './store';
import { fetchPublicResource } from './public-fetch';
import type { OneshotSession } from './oneshot-auth';

vi.mock('./public-fetch', async importOriginal => ({ ...await importOriginal<typeof import('./public-fetch')>(), fetchPublicResource: vi.fn() }));
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => dns);
const alice: OneshotSession = { provider: 'privy', userId: 'did:privy:alice', sessionId: 'alice-session', expiresAt: 9999999999, linkedAddresses: ['0x1111111111111111111111111111111111111111'] };
const bob: OneshotSession = { ...alice, userId: 'did:privy:bob', linkedAddresses: ['0x2222222222222222222222222222222222222222'] };
const base = path.resolve('.local/oneshot-draft-tests');
let directory: string;
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 87, g: 230, b: 193, alpha: 1 } } }).png().toBuffer();
const input = () => ({ name: 'oneshot originals', description: 'A real local draft', maxSupply: 2, royaltyBps: 500, publicPrice: '0.123456789012345678', allowlistPrice: '0', perWalletLimit: 2, publicStart: '2030-01-01T00:00:00Z', publicEnd: '2030-01-02T00:00:00Z', allowlistAddresses: [], metadataMode: 'upload' as const, creatorWallet: alice.linkedAddresses[0] });
beforeEach(async () => {
  await mkdir(base, { recursive: true }); directory = await mkdtemp(path.join(base, 'case-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('S3_BUCKET', ''); vi.stubEnv('ONESHOT_DATA_DIR', directory); vi.stubEnv('ONESHOT_MEDIA_QUOTA_BYTES', '10485760');
  vi.mocked(fetchPublicResource).mockReset();
  dns.lookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const target = path.resolve(directory); if (!target.startsWith(base + path.sep)) throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
});

describe('Privy-owned account drafts', () => {
  it('preserves native price text and verifies selected creator against the identity', async () => {
    const draft = await createOneshotDraft(input(), alice);
    expect(draft.publicPrice).toBe('0.123456789012345678'); expect(draft.ownerUserId).toBe(alice.userId);
    await expect(createOneshotDraft(input(), bob)).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    expect(() => oneshotDraftSchema.parse({ ...input(), ownerUserId: bob.userId })).toThrow();
    expect(() => oneshotDraftSchema.parse({ ...input(), name: '界'.repeat(34) })).toThrow();
  });
  it('hides other users IDs and rejects lost updates atomically', async () => {
    const draft = await createOneshotDraft(input(), alice);
    await expect(getOneshotDraft(draft.id, bob)).rejects.toMatchObject({ status: 404 });
    await expect(updateOneshotDraft(draft.id, input(), 1, bob)).rejects.toMatchObject({ status: 404 });
    const writes = await Promise.allSettled([updateOneshotDraft(draft.id, { ...input(), name: 'First edit' }, 1, alice), updateOneshotDraft(draft.id, { ...input(), name: 'Other edit' }, 1, alice)]);
    expect(writes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(value => value.status === 'rejected')).toHaveLength(1);
    expect((await getOneshotDraft(draft.id, alice)).revision).toBe(2);
  });
  it('enforces the account limit under concurrent creation and frees archived slots', async () => {
    const values = await Promise.allSettled(Array.from({ length: 21 }, () => createOneshotDraft(input(), alice)));
    expect(values.filter(value => value.status === 'fulfilled')).toHaveLength(20);
    const drafts = await listOneshotDrafts(alice); expect(drafts).toHaveLength(20);
    await archiveOneshotDraft(drafts[0]!.id, 1, alice);
    await expect(getOneshotDraft(drafts[0]!.id, alice)).rejects.toMatchObject({ status: 404 });
    await createOneshotDraft(input(), alice); expect(await listOneshotDrafts(alice)).toHaveLength(20);
  });
  it('filters ownership before the old global 200-record page boundary', async () => {
    const own = await createOneshotDraft(input(), alice);
    for (let index = 0; index < 205; index++) await putRecord('oneshot_drafts', `foreign-${index}`, { ...own, id: `foreign-${index}`, ownerUserId: bob.userId, updatedAt: new Date(Date.now() + index).toISOString() });
    expect((await listOneshotDrafts(alice)).map(value => value.id)).toEqual([own.id]);
  });
});

describe('content commitments for the new ERC721 URI layout', () => {
  it('prepares immutable sanitized content and serves serial IDs without .json', async () => {
    const uploaded = await storeImage(png, alice.userId, 'http://localhost');
    const reference = `/api/media/${uploaded.hash}.webp`;
    const draft = await createOneshotDraft({ ...input(), imageUrl: reference }, alice);
    const prepared = await prepareOneshotDraft(draft.id, 1, alice, 'https://api.oneshot.app');
    expect(prepared.status).toBe('prepared'); expect(prepared.revision).toBe(2); expect(prepared.snapshot?.itemCount).toBe(2);
    expect(prepared.snapshot?.baseUri).toBe(`https://api.oneshot.app/api/oneshot/metadata/${prepared.snapshot?.manifestHash}/`);
    const asset = await readOneshotMetadata(prepared.snapshot!.manifestHash, '1');
    const json = JSON.parse(asset.buffer.toString()); expect(json.name).toBe('oneshot originals #1'); expect(json.image).toBe(`https://api.oneshot.app${reference}`);
    await expect(readOneshotMetadata(prepared.snapshot!.manifestHash, '1.json')).rejects.toMatchObject({ status: 404 });
    await expect(updateOneshotDraft(draft.id, input(), 2, alice)).rejects.toMatchObject({ code: 'SNAPSHOT_FROZEN' });
    await archiveOneshotDraft(draft.id, 2, alice);
    expect((await readOneshotMetadata(prepared.snapshot!.manifestHash, '1')).buffer).toEqual(asset.buffer);
  });
  it('rejects HTTP publication and bad manifests without changing the draft', async () => {
    const draft = await createOneshotDraft(input(), alice);
    await expect(prepareOneshotDraft(draft.id, 1, alice, 'http://localhost')).rejects.toMatchObject({ code: 'HTTPS_METADATA_REQUIRED' });
    await expect(prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app')).rejects.toMatchObject({ code: 'MANIFEST_SUPPLY_MISMATCH' });
    expect((await getOneshotDraft(draft.id, alice)).revision).toBe(1); expect(fetchPublicResource).not.toHaveBeenCalled();
  });
  it('never overwrites an edit made while remote content is being prepared', async () => {
    const uploaded = await storeImage(png, alice.userId, 'https://oneshot.app');
    const draft = await createOneshotDraft({ ...input(), metadataMode: 'url', metadataUrl: 'https://art.oneshot.app/manifest.json' }, alice);
    vi.mocked(fetchPublicResource).mockImplementationOnce(async () => {
      await updateOneshotDraft(draft.id, { ...input(), name: 'Newer accepted edit' }, 1, alice);
      return { buffer: Buffer.from(JSON.stringify({ items: [1,2].map(index => ({ name: `Art ${index}`, image: `/api/media/${uploaded.hash}.webp` })) })), contentType: 'application/json' };
    });
    await expect(prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app')).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    const result = await getOneshotDraft(draft.id, alice); expect(result.status).toBe('draft'); expect(result.name).toBe('Newer accepted edit');
  });
  it('detects changed bytes behind a content-addressed image reference', async () => {
    const uploaded = await storeImage(png, alice.userId, 'https://oneshot.app');
    const draft = await createOneshotDraft({ ...input(), imageUrl: `/api/media/${uploaded.hash}.webp` }, alice);
    await writeFile(path.join(directory, 'media', `${uploaded.hash}.webp`), Buffer.from('corrupted art'));
    await expect(prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app')).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
    expect((await getOneshotDraft(draft.id, alice)).revision).toBe(1);
  });
  it('rejects a publication hostname resolving to private addresses before storing any snapshot', async () => {
    const uploaded = await storeImage(png, alice.userId, 'http://localhost');
    const draft = await createOneshotDraft({ ...input(), imageUrl: `/api/media/${uploaded.hash}.webp` }, alice);
    const before = await listRecords('media');
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '172.20.0.1', family: 4 }]);
    await expect(prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app')).rejects.toMatchObject({ code: 'HTTPS_METADATA_REQUIRED' });
    expect(await listRecords('media')).toEqual(before);
    expect((await getOneshotDraft(draft.id, alice)).revision).toBe(1);
    expect(fetchPublicResource).not.toHaveBeenCalled();
  });
  it.each(['https://172.20.0.1', 'https://100.64.1.1', 'https://oneshot.app:8443', 'https://oneshot.example'])('rejects an unsafe publication origin %s before DNS', async origin => {
    const draft = await createOneshotDraft(input(), alice);
    await expect(prepareOneshotDraft(draft.id, 1, alice, origin)).rejects.toMatchObject({ code: 'HTTPS_METADATA_REQUIRED' });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('checks the selected creator is still linked before preparation', async () => {
    const draft = await createOneshotDraft(input(), alice);
    await expect(prepareOneshotDraft(draft.id, 1, { ...alice, linkedAddresses: [] }, 'https://oneshot.app')).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects a changed manifest mapping even when the substituted metadata bytes have a valid hash', async () => {
    const uploaded = await storeImage(png, alice.userId, 'https://oneshot.app');
    const draft = await createOneshotDraft({ ...input(), imageUrl: `/api/media/${uploaded.hash}.webp` }, alice);
    const prepared = await prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app');
    const hash = prepared.snapshot!.manifestHash;
    const snapshot = await getRecord('oneshot_snapshots', hash);
    const replacement = await storeBlob(Buffer.from(JSON.stringify({ name: 'Altered after commitment' })), 'json', alice.userId, 'https://oneshot.app');
    snapshot.items[0].metadataHash = replacement.hash;
    snapshot.items[0].metadataId = `${replacement.hash}.json`;
    await putRecord('oneshot_snapshots', hash, snapshot);
    await expect(readOneshotMetadata(hash, '1')).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
    await expect(verifyPreparedOneshotSnapshot(prepared)).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
  });
  it('rejects unsafe content sources and zero allowlist wallets when saving', () => {
    expect(() => oneshotDraftSchema.parse({ ...input(), imageUrl: 'https://172.20.0.1/art.png' })).toThrow();
    expect(() => oneshotDraftSchema.parse({ ...input(), metadataMode: 'url', metadataUrl: 'https://user:password@oneshot.app/manifest' })).toThrow();
    expect(() => oneshotDraftSchema.parse({ ...input(), metadataMode: 'url', metadataUrl: 'ipfs://' })).toThrow();
    expect(() => oneshotDraftSchema.parse({ ...input(), allowlistAddresses: [`0x${'0'.repeat(40)}`], allowlistStart: '2029-12-31T00:00:00Z', allowlistEnd: '2030-01-01T00:00:00Z' })).toThrow();
  });
  it('enforces the remaining snapshot output budget before storing sanitized art', async () => {
    await expect(storeImage(png, alice.userId, 'https://oneshot.app', 1)).rejects.toMatchObject({ code: 'SNAPSHOT_TOO_LARGE' });
    expect(await listRecords('media')).toEqual([]);
  });
  it('checks hosted object storage before reserving any quota', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(storeBlob(Buffer.from('{}'), 'json', alice.userId, 'https://oneshot.app')).rejects.toMatchObject({ code: 'STORAGE_REQUIRED' });
    vi.stubEnv('NODE_ENV', 'test');
    expect(await listRecords('media')).toEqual([]);
  });
  it('bounds the whole preparation batch and propagates cancellation to pending imports', async () => {
    const draft = await createOneshotDraft({ ...input(), metadataMode: 'url', metadataUrl: 'https://art.oneshot.app/manifest.json' }, alice);
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(fetchPublicResource).mockImplementationOnce(async () => { entered(); return await new Promise<never>(() => {}); });
    vi.useFakeTimers();
    const result = prepareOneshotDraft(draft.id, 1, alice, 'https://oneshot.app');
    const assertion = expect(result).rejects.toMatchObject({ status: 504, code: 'SNAPSHOT_TIMEOUT' });
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(vi.mocked(fetchPublicResource).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
    expect((await getOneshotDraft(draft.id, alice)).revision).toBe(1);
  });
});

describe('prepared snapshot verification before local execution', () => {
  async function preparedCollection() {
    const uploaded = await storeImage(png, alice.userId, 'http://localhost');
    const draft = await createOneshotDraft({ ...input(), symbol: 'SHOT', imageUrl: `/api/media/${uploaded.hash}.webp` }, alice);
    return prepareOneshotDraft(draft.id, 1, alice, 'https://api.oneshot.app');
  }
  it('accepts actual preparation output without changing the draft, media or public metadata', async () => {
    const prepared = await preparedCollection();
    const metadata = await readOneshotMetadata(prepared.snapshot!.manifestHash, '1');
    const media = await listRecords('media');
    await expect(verifyPreparedOneshotSnapshot(prepared)).resolves.toBeUndefined();
    expect(await getOneshotDraft(prepared.id, alice)).toEqual(prepared);
    expect(await listRecords('media')).toEqual(media);
    expect((await readOneshotMetadata(prepared.snapshot!.manifestHash, '1')).buffer).toEqual(metadata.buffer);
    expect(fetchPublicResource).not.toHaveBeenCalled();
  });
  it('requires a prepared revision and its exact declared content commitment', async () => {
    const prepared = await preparedCollection();
    for (const changed of [
      { ...prepared, status: 'draft' as const },
      { ...prepared, snapshot: undefined },
      { ...prepared, snapshot: { ...prepared.snapshot!, contentHash: `0x${'aa'.repeat(32)}` as `0x${string}` } },
      { ...prepared, snapshot: { ...prepared.snapshot!, manifestHash: 'not-a-content-hash' } },
    ]) await expect(verifyPreparedOneshotSnapshot(changed)).rejects.toMatchObject({ code: 'SNAPSHOT_REQUIRED' });
    const missingHash = 'ef'.repeat(32);
    await expect(verifyPreparedOneshotSnapshot({ ...prepared, snapshot: { ...prepared.snapshot!, manifestHash: missingHash, contentHash: `0x${missingHash}` } })).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
  });
  it('rejects changed supply, item count and collection name against the stored snapshot', async () => {
    const prepared = await preparedCollection();
    for (const changed of [
      { ...prepared, maxSupply: prepared.maxSupply + 1 },
      { ...prepared, snapshot: { ...prepared.snapshot!, itemCount: prepared.maxSupply - 1 } },
      { ...prepared, name: 'A different collection' },
    ]) await expect(verifyPreparedOneshotSnapshot(changed)).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
  });
  it('rejects metadata URLs that leave the prepared HTTPS origin or content paths', async () => {
    const prepared = await preparedCollection();
    for (const snapshot of [
      { ...prepared.snapshot!, baseUri: prepared.snapshot!.baseUri.replace('https:', 'http:') },
      { ...prepared.snapshot!, baseUri: 'https://api.oneshot.app/api/oneshot/metadata/other/' },
      { ...prepared.snapshot!, baseUri: `${prepared.snapshot!.baseUri}?version=2` },
      { ...prepared.snapshot!, collectionUri: prepared.snapshot!.collectionUri.replace('api.oneshot.app', 'other.oneshot.app') },
      { ...prepared.snapshot!, collectionUri: 'https://api.oneshot.app/collection.json' },
      { ...prepared.snapshot!, collectionUri: `${prepared.snapshot!.collectionUri}#different` },
    ]) await expect(verifyPreparedOneshotSnapshot({ ...prepared, snapshot })).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
    await expect(verifyPreparedOneshotSnapshot(prepared)).resolves.toBeUndefined();
  });
  it('rejects replacement collection metadata even when its new bytes have a valid content hash', async () => {
    const prepared = await preparedCollection();
    for (const fields of [
      { name: 'Substituted collection', manifest_hash: prepared.snapshot!.manifestHash },
      { name: prepared.name, manifest_hash: 'aa'.repeat(32) },
    ]) {
      const replacement = await storeBlob(Buffer.from(JSON.stringify(fields)), 'json', alice.userId, 'https://api.oneshot.app');
      await expect(verifyPreparedOneshotSnapshot({ ...prepared, snapshot: { ...prepared.snapshot!, collectionUri: replacement.url } })).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
    }
  });
  it('rejects collection metadata bytes corrupted after preparation', async () => {
    const prepared = await preparedCollection();
    const id = new URL(prepared.snapshot!.collectionUri).pathname.split('/').at(-1)!;
    await writeFile(path.join(directory, 'media', id), Buffer.from(JSON.stringify({ name: prepared.name, manifest_hash: prepared.snapshot!.manifestHash, changed: true })));
    await expect(verifyPreparedOneshotSnapshot(prepared)).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
  });
});
