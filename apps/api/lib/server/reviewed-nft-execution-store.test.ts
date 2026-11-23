import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionReviewSchema } from '../../../web/lib/reviewed-nft-execution';
import { createReviewedNftExecutionStore, reviewedNftReviewHash, REVIEWED_NFT_EXECUTION_NAMESPACE, type StoredReviewedNftExecution } from './reviewed-nft-execution-store';
import { putRecord, withLocalNamespace } from './store';

const root = path.resolve('.local/reviewed-nft-execution-store-tests'), start = 1_800_000_000_000;
let directory: string, now: number;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const txHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
function makeRecord(owner = 'did:privy:alice', wallet = address(3), deployment = 'a'.repeat(64)): StoredReviewedNftExecution {
  const recipient = address(9), marketplace = address(2);
  const unsigned = { schemaVersion: 1 as const, kind: 'reviewed-external-nft-execution' as const, id: randomUUID(), deploymentId: deployment, chainId: 31337 as const,
    network: { mode: 'local' as const, chainId: 31337 as const, name: 'Local Anvil', nativeSymbol: 'ETH' as const, nativeDecimals: 18 as const }, marketplace, registry: address(1),
    from: wallet, to: marketplace, data: encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'claimTo', args: [recipient] }), value: '0', nonce: '0', action: 'claim' as const,
    expiresAt: new Date(now + 120000).toISOString(), simulation: { blockNumber: '10', blockHash: txHash(10), blockTimestamp: '1800000000', gasEstimate: '30000' },
    terms: { account: wallet, recipient, amountRaw: '1000', allPending: true as const },
  };
  return { schemaVersion: 1, owner, session: 'session', createdAt: now, review: reviewedNftExecutionReviewSchema.parse({ ...unsigned, reviewHash: reviewedNftReviewHash(unsigned) }),
    input: { action: 'claim', from: wallet, expectedChainId: 31337, expectedDeploymentId: deployment, testEthAcknowledged: true, recipient },
    transactionHash: null, outcome: 'review', updatedAt: new Date(now).toISOString(), canonicalReceipt: null };
}
const store = (options: Parameters<typeof createReviewedNftExecutionStore>[0] = {}) => createReviewedNftExecutionStore({ pool: () => null, now: () => now, ...options });
beforeEach(async () => { await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, 'case-')); now = start; vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('ONESHOT_DATA_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); const target = path.resolve(directory); if (!target.startsWith(root + path.sep)) throw new Error('Unsafe local recovery test cleanup.'); await rm(target, { recursive: true, force: true }); });

describe('reviewed NFT private execution recovery', () => {
  it('persists exact immutable wire data across instances and isolates returned objects and accounts', async () => {
    const record = makeRecord(), originalData = record.review.data; await store().save(record);
    const first = await store().get(record.review.id, record.owner); first.review.data = '0x1234'; record.input.from = address(8);
    expect((await store().get(record.review.id, record.owner)).review.data).toBe(originalData);
    await expect(store().get(record.review.id, 'did:privy:bob')).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
    expect((await store().list('did:privy:bob')).items).toEqual([]);
    const persisted = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    expect(persisted[REVIEWED_NFT_EXECUTION_NAMESPACE][record.review.id].review.data).toBe(originalData);
  });
  it('rejects modified hashes, mismatched input identity, invalid lifetimes and previously submitted saves', async () => {
    const record = makeRecord();
    for (const changed of [
      { ...record, review: { ...record.review, value: '1' } }, { ...record, input: { ...record.input, expectedDeploymentId: 'b'.repeat(64) } },
      { ...record, input: { ...record.input, from: address(8) } }, { ...record, review: { ...record.review, expiresAt: new Date(now + 120001).toISOString() } },
      { ...record, transactionHash: txHash(1), outcome: 'submitted' },
    ]) await expect(store().save(changed as StoredReviewedNftExecution)).rejects.toBeDefined();
    expect((await store().list(record.owner)).items).toEqual([]);
    await store().save(record); await expect(store().save(record)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_EXISTS' });
  });
  it('hashes canonical nested JSON independently of object insertion order', () => {
    const { reviewHash: _hash, ...unsigned } = makeRecord().review;
    expect(reviewedNftReviewHash(unsigned)).toBe(reviewedNftReviewHash(Object.fromEntries(Object.entries(unsigned).reverse()) as typeof unsigned));
  });
  it('keeps the marketplace listing intent nonce independent of the EOA transaction nonce', async () => {
    const base = makeRecord(), collection = address(5), unsigned = { ...base.review, action: 'list' as const, nonce: '17', to: collection,
      terms: { collection, tokenId: '0', seller: base.review.from, totalPriceRaw: '1000000000000000000', platformFeeRaw: '20000000000000000',
        royaltyRecipient: address(7), royaltyRaw: '10000000000000000', sellerProceedsRaw: '970000000000000000', reviewVersion: '1', runtimeCodeHash: txHash(50), intentHash: txHash(51),
        intent: { seller: base.review.from, collection, tokenId: '0', totalPrice: '1000000000000000000', royaltyRecipient: address(7), royaltyAmount: '10000000000000000', reviewVersion: '1',
          nonce: '3', deadline: '1800000120', chainId: 31337 as const, marketplace: base.review.marketplace, deploymentSalt: txHash(52) } },
    };
    const { reviewHash: _old, ...withoutHash } = unsigned;
    const record: StoredReviewedNftExecution = { ...base, review: reviewedNftExecutionReviewSchema.parse({ ...withoutHash, reviewHash: reviewedNftReviewHash(withoutHash) }),
      input: { action: 'list', from: base.review.from, expectedChainId: 31337, expectedDeploymentId: base.review.deploymentId, testEthAcknowledged: true, collection, tokenId: '0', price: '1' } };
    await store().save(record); const saved = await store().get(record.review.id, record.owner);
    expect(saved.review.nonce).toBe('17'); if (saved.review.action !== 'list') throw new Error('Expected listing review'); expect(saved.review.terms.intent.nonce).toBe('3');
  });
  it('attaches one transaction atomically and rejects using one hash for another review in the same account/deployment', async () => {
    const first = makeRecord(), second = makeRecord(); await store().save(first); await store().save(second);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store().attach(first.review.id, first.owner, txHash(index % 2 + 1))));
    const success = attempts.flatMap(value => value.status === 'fulfilled' ? [value.value.transactionHash] : []); expect(new Set(success).size).toBe(1);
    const saved = await store().get(first.review.id, first.owner); expect(saved.outcome).toBe('submitted');
    await expect(store().attach(second.review.id, second.owner, saved.transactionHash!)).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_CHANGED' });
    await expect(store().attach(first.review.id, 'did:privy:bob', saved.transactionHash!)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
    expect((await store().get(second.review.id, second.owner)).transactionHash).toBeNull();
    const differentDeployment = makeRecord(first.owner, address(3), 'b'.repeat(64)); await store().save(differentDeployment);
    expect((await store().attach(differentDeployment.review.id, first.owner, saved.transactionHash!)).transactionHash).toBe(saved.transactionHash);
  });
  it('has exactly one reservation winner when two reviews attach the same hash concurrently', async () => {
    const first = makeRecord(), second = makeRecord(); await store().save(first); await store().save(second);
    const results = await Promise.allSettled([store().attach(first.review.id, first.owner, txHash(1)), store().attach(second.review.id, second.owner, txHash(1))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store().list(first.owner)).items.filter(value => value.transactionHash)).toHaveLength(1);
  });
  it('requires canonical terminal receipts, preserves terminals against stale pending/attach and supports an explicit reorg reset', async () => {
    const record = makeRecord(), repo = store(); await repo.save(record); await repo.attach(record.review.id, record.owner, txHash(1));
    await expect(repo.settle(record.review.id, record.owner, txHash(1), 'confirmed')).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INVALID' });
    const receipt = { blockNumber: '11', blockHash: txHash(11) }, confirmed = await repo.settle(record.review.id, record.owner, txHash(1), 'confirmed', undefined, receipt);
    expect((await repo.attach(record.review.id, record.owner, txHash(1))).outcome).toBe('confirmed');
    expect(await repo.settle(record.review.id, record.owner, txHash(1), 'submitted')).toEqual(confirmed);
    await expect(repo.settle(record.review.id, record.owner, txHash(1), 'reverted', undefined, receipt)).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_CHANGED' });
    expect((await repo.settle(record.review.id, record.owner, txHash(1), 'submitted', undefined, null)).canonicalReceipt).toBeNull();
    expect((await repo.settle(record.review.id, record.owner, txHash(1), 'reverted', undefined, { blockNumber: '12', blockHash: txHash(12) })).outcome).toBe('reverted');
  });
  it('counts all submitted rows for new-review capacity but preserves recovery after a signing expiry', async () => {
    const repo = store({ activeLimit: 2 }), first = makeRecord(), second = makeRecord(); await repo.save(first); await repo.attach(first.review.id, first.owner, txHash(1)); await repo.save(second);
    await expect(repo.save(makeRecord())).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_LIMIT' });
    now += 120001; await repo.save(makeRecord());
    expect((await repo.attach(second.review.id, second.owner, txHash(2))).outcome).toBe('submitted');
    await expect(repo.save(makeRecord())).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_LIMIT' });
  });
  it('retains pending submissions past 30 days and reserves hashes after terminal-history cleanup', async () => {
    const repo = store(), pending = makeRecord(), terminal = makeRecord(), unused = makeRecord();
    await repo.save(pending); await repo.attach(pending.review.id, pending.owner, txHash(1)); await repo.save(terminal); await repo.attach(terminal.review.id, terminal.owner, txHash(2));
    await repo.settle(terminal.review.id, terminal.owner, txHash(2), 'confirmed', undefined, { blockNumber: '11', blockHash: txHash(11) }); await repo.save(unused);
    now += 31 * 86400000; const fresh = makeRecord(); await repo.save(fresh);
    expect((await store().get(pending.review.id, pending.owner)).outcome).toBe('submitted');
    for (const record of [terminal, unused]) await expect(repo.get(record.review.id, record.owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_NOT_FOUND' });
    expect((await repo.list(pending.owner)).items).toHaveLength(2);
    await expect(repo.attach(fresh.review.id, fresh.owner, txHash(2))).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_CHANGED' });
  });
  it('paginates exact account/wallet/limit-bound history while keeping reservations out of pages', async () => {
    const repo = store(), own = [];
    for (let index = 0; index < 6; index++) { const record = makeRecord(); await repo.save(record); own.push(record); }
    await repo.save(makeRecord('did:privy:alice', address(4))); await repo.save(makeRecord('did:privy:bob')); await repo.attach(own[0].review.id, own[0].owner, txHash(1));
    const first = await repo.list(own[0].owner, { wallet: address(3), limit: 2 }), second = await repo.list(own[0].owner, { wallet: address(3), limit: 2, cursor: first.nextCursor! }), third = await repo.list(own[0].owner, { wallet: address(3), limit: 2, cursor: second.nextCursor! });
    expect([...first.items, ...second.items, ...third.items].map(value => value.review.id)).toEqual(own.map(value => value.review.id).sort().reverse()); expect(third.nextCursor).toBeNull();
    for (const [owner, wallet, size] of [['did:privy:bob', address(3), 2], ['did:privy:alice', address(4), 2], ['did:privy:alice', address(3), 3]] as const)
      await expect(repo.list(owner, { wallet, limit: size, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INVALID' });
    expect(Buffer.from(first.nextCursor!, 'base64url').toString()).not.toContain('did:privy');
  });
  it('fails altered immutable data and never treats broken storage as an empty list', async () => {
    const record = makeRecord(); await store().save(record); await putRecord(REVIEWED_NFT_EXECUTION_NAMESPACE, record.review.id, { ...record, review: { ...record.review, nonce: '99' } });
    await expect(store().get(record.review.id, record.owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INTEGRITY' });
    await expect(store().list(record.owner)).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INTEGRITY' });
    expect((await store().list('did:privy:bob')).items).toEqual([]);
  });
  it('fails a missing hash reservation without silently creating a replacement or changing the saved status', async () => {
    const record = makeRecord(); await store().save(record); await store().attach(record.review.id, record.owner, txHash(1));
    await withLocalNamespace<unknown, void>(REVIEWED_NFT_EXECUTION_NAMESPACE, records => { for (const key of Object.keys(records)) if (key.startsWith('tx:')) delete records[key]; }, true);
    await expect(store().attach(record.review.id, record.owner, txHash(1))).rejects.toMatchObject({ code: 'REVIEWED_NFT_REVIEW_INTEGRITY' });
    expect((await store().get(record.review.id, record.owner)).outcome).toBe('submitted');
  });
  it('does not create a production file fallback', async () => {
    vi.stubEnv('NODE_ENV', 'production'); const record = makeRecord();
    await expect(store().save(record)).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
    await expect(store().list(record.owner)).rejects.toMatchObject({ code: 'DATABASE_REQUIRED' });
  });
});
