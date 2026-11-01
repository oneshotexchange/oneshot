import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNftLaunchProgressRepository, NFT_LAUNCH_NAMESPACE, type NftLaunchAssociation } from './nft-launch-progress-store';
import { putRecord, getRecord } from './store';
import { NFT_REVIEW_NAMESPACE } from './nft-launch-store';

const root = path.resolve('.local/nft-launch-progress-tests');
const owner = 'did:privy:creator', from = `0x${'12'.repeat(20)}`, deploymentId = 'ab'.repeat(32), draftId = randomUUID();
const selection = { draftId, revision: 2, deploymentId, from };
const now = 1_800_000_000_000;
let directory = '';
const association = (changes: Partial<NftLaunchAssociation> = {}): NftLaunchAssociation => ({ version: 1, id: randomUUID(), owner, ...selection,
  collection: `0x${'34'.repeat(20)}`, createHash: `0x${'56'.repeat(32)}`, blockNumber: '12', blockHash: `0x${'78'.repeat(32)}`, createdAt: now, ...changes });
beforeEach(async () => {
  await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, 'case-'));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('ONESHOT_DATA_DIR', directory);
});
afterEach(async () => {
  vi.unstubAllEnvs(); const target = path.resolve(directory); if (!target.startsWith(root + path.sep)) throw new Error('Unsafe launch-progress cleanup.');
  await rm(target, { recursive: true, force: true });
});

describe('permanent account/draft/creator launch associations', () => {
  it('survives repository restart, separates transaction retention and returns isolated objects', async () => {
    const item = association(), repo = createNftLaunchProgressRepository(); await repo.save(item);
    const stored = await createNftLaunchProgressRepository().get(item.id); expect(stored).toEqual(item);
    stored!.collection = `0x${'99'.repeat(20)}`;
    expect(await repo.get(item.id)).toEqual(item);
    expect((await repo.list(owner, { ...selection, limit: 10 })).items).toEqual([item]);
    expect(await getRecord(NFT_REVIEW_NAMESPACE, item.id)).toBeNull();
    expect((await getRecord(NFT_LAUNCH_NAMESPACE, item.id)).owner).toBe(owner);
  });
  it('makes repeated proofs idempotent and allows only compare-and-swap provenance repair', async () => {
    const item = association(), repo = createNftLaunchProgressRepository(); await repo.save(item); await repo.save({ ...item });
    const replacement = { ...item, blockNumber: '14', blockHash: `0x${'90'.repeat(32)}` };
    await expect(repo.save(replacement)).rejects.toMatchObject({ code: 'LAUNCH_ASSOCIATION_CHANGED' });
    await repo.save(replacement, item); expect(await repo.get(item.id)).toEqual(replacement);
    await expect(repo.save({ ...replacement, blockNumber: '15' }, item)).rejects.toMatchObject({ code: 'LAUNCH_ASSOCIATION_CHANGED' });
    await expect(repo.save({ ...replacement, owner: 'did:privy:other' }, replacement)).rejects.toMatchObject({ code: 'LAUNCH_ASSOCIATION_CHANGED' });
  });
  it('admits one immutable association under contending first writes', async () => {
    const item = association();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => createNftLaunchProgressRepository().save({ ...item, collection: `0x${(index % 2 ? '34' : '35').repeat(20)}` })));
    expect(results.some(result => result.status === 'fulfilled')).toBe(true); expect(results.some(result => result.status === 'rejected')).toBe(true);
    const page = await createNftLaunchProgressRepository().list(owner, { ...selection, limit: 10 }); expect(page.items).toHaveLength(1);
  });
  it('filters all identity dimensions before the bounded page and rejects cross-scope cursors', async () => {
    const repo = createNftLaunchProgressRepository();
    const own = Array.from({ length: 5 }, (_, index) => association({ createdAt: now + index }));
    for (const item of own) await repo.save(item);
    for (const changes of [{ owner: 'foreign' }, { draftId: randomUUID() }, { revision: 3 }, { from: `0x${'22'.repeat(20)}` }, { deploymentId: 'cd'.repeat(32) }]) await repo.save(association({ createdAt: now + 100, ...changes }));
    const first = await repo.list(owner, { ...selection, limit: 2 }); expect(first.items.map(item => item.id)).toEqual(own.slice(3).reverse().map(item => item.id));
    const second = await repo.list(owner, { ...selection, limit: 2, cursor: first.nextCursor! }); expect(second.items.map(item => item.id)).toEqual(own.slice(1, 3).reverse().map(item => item.id));
    const last = await repo.list(owner, { ...selection, limit: 2, cursor: second.nextCursor! }); expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
    await expect(repo.list('foreign', { ...selection, limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await expect(repo.list(owner, { ...selection, revision: 3, limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
  });
  it('offers only unassociated retained creator broadcasts for this exact draft', async () => {
    const repo = createNftLaunchProgressRepository(), item = association(); await repo.save(item);
    const saved = (id: string, changes: Record<string, unknown> = {}) => ({ owner, createdAt: now, outcome: 'submitted', transactionHash: item.createHash,
      review: { id, draftId, revision: 2, deploymentId, from, scope: 'draft', action: 'create' }, ...changes });
    const pendingId = randomUUID(); await putRecord(NFT_REVIEW_NAMESPACE, pendingId, saved(pendingId));
    await putRecord(NFT_REVIEW_NAMESPACE, item.id, saved(item.id));
    const expiredId = randomUUID(); await putRecord(NFT_REVIEW_NAMESPACE, expiredId, saved(expiredId, { createdAt: now - 31 * 86_400_000 }));
    const unsignedId = randomUUID(); await putRecord(NFT_REVIEW_NAMESPACE, unsignedId, saved(unsignedId, { transactionHash: undefined }));
    const foreignId = randomUUID(); await putRecord(NFT_REVIEW_NAMESPACE, foreignId, saved(foreignId, { owner: 'foreign' }));
    expect(await repo.pending(owner, selection, now)).toEqual([{ reviewId: pendingId, hash: item.createHash }]);
  });
  it.each(['cursor with spaces', '', 'e30=', Buffer.from('{}').toString('base64url')])('rejects malformed cursors without exposing saved content: %s', async cursor => {
    await expect(createNftLaunchProgressRepository().list(owner, { ...selection, limit: 2, cursor })).rejects.toMatchObject({ status: 400 });
  });
  it('fails closed on corrupt or key-swapped permanent data', async () => {
    const item = association(), repo = createNftLaunchProgressRepository(); await putRecord(NFT_LAUNCH_NAMESPACE, item.id, { ...item, id: randomUUID() });
    await expect(repo.get(item.id)).rejects.toMatchObject({ code: 'LAUNCH_PROGRESS_INTEGRITY' });
    await expect(repo.save({ ...item, blockNumber: '-1' })).rejects.toMatchObject({ code: 'LAUNCH_PROGRESS_INTEGRITY' });
  });
  it('isolates unrelated corrupt local records while rejecting corruption in the selected account scope', async () => {
    const item = association(), repo = createNftLaunchProgressRepository(); await repo.save(item);
    await putRecord(NFT_LAUNCH_NAMESPACE, randomUUID(), { owner: 'unrelated', corrupt: true });
    expect((await repo.list(owner, { ...selection, limit: 10 })).items).toEqual([item]);
    await putRecord(NFT_REVIEW_NAMESPACE, randomUUID(), { owner: 'unrelated', corrupt: true });
    expect(await repo.pending(owner, selection, now)).toEqual([]);
    await putRecord(NFT_REVIEW_NAMESPACE, randomUUID(), { owner, createdAt: now, review: null });
    await expect(repo.pending(owner, selection, now)).rejects.toMatchObject({ code: 'LAUNCH_PROGRESS_INTEGRITY' });
  });
});
