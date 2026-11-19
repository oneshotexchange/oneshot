import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { BASE_SEPOLIA_GENESIS_HASH } from '@oneshot/evm';
import { createExternalNftImports, createExternalNftImportsApi, type ExternalImportDeployment, type ExternalNftImportInspection, type ExternalNftImportStore, type StoredExternalNftImport } from './external-nft-imports';
import { api } from './http';
import type { OneshotSession } from './oneshot-auth';

const address = (index: number) => `0x${index.toString(16).padStart(40, '0')}` as `0x${string}`;
const owner: OneshotSession = { provider: 'privy', userId: 'did:privy:import-alice', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
const other = { ...owner, userId: 'did:privy:import-bob' };
const now = '2026-11-19T01:00:00.000Z';
const deployment: ExternalImportDeployment = { deploymentId: 'd'.repeat(64), chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, registry: address(1), marketplace: address(2) };
const input = { deploymentId: deployment.deploymentId, collection: address(3), note: 'Please review this ERC-721 collection.', reference: 'https://example.com/collection' };
const inspection = (): ExternalNftImportInspection => ({ deployment, collection: input.collection, runtimeCodeHash: `0x${'a'.repeat(64)}`, currentReviewVersion: '0', checkpoint: { number: '123', hash: `0x${'b'.repeat(64)}`, timestamp: '1795050000' }, inspectedAt: now });
function fixture() {
  const records = new Map<string, StoredExternalNftImport>(); let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => T) => { const work = tail.then(run); tail = work.catch(() => undefined); return work; };
  const store: ExternalNftImportStore = {
    get: async id => structuredClone(records.get(id) ?? null),
    list: async (user, limit, after) => [...records.values()].filter(value => (user === null || value.ownerUserId === user) && (!after || value.request.createdAt < after.createdAt || value.request.createdAt === after.createdAt && value.request.id < after.id))
      .sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt) || b.request.id.localeCompare(a.request.id)).slice(0, limit).map(value => structuredClone(value)),
    create: record => serial(() => { records.set(record.request.id, structuredClone(record)); }),
    replace: (previous, next) => serial(() => { if (JSON.stringify(records.get(previous.request.id)) !== JSON.stringify(previous)) return false; records.set(previous.request.id, structuredClone(next)); return true; }),
  };
  const selected = vi.fn(async () => deployment), inspect = vi.fn(async () => inspection());
  const service = createExternalNftImports({ store, deployment: selected, inspect, now: () => now });
  return { service, store, records, selected, inspect };
}
describe('private external collection import requests', () => {
  it('supports an account without a linked wallet and returns only its private allowlisted request', async () => {
    const { service } = fixture(), created = await service.create(input, owner);
    expect(created).toMatchObject({ ...input, status: 'submitted', revision: 1, admissionStatus: 'not-established' });
    expect((await service.list(owner)).items).toEqual([created]); expect((await service.list(other)).items).toEqual([]);
    await expect(service.read(created.id, other)).rejects.toMatchObject({ status: 404 });
    await expect(service.withdraw(created.id, 1, other)).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(created)).not.toContain('did:privy'); expect(JSON.stringify(created)).not.toContain('operatorEvidence');
  });
  it('refuses unverified deployment, mainnet, arbitrary verification/owner flags and oversized notes', async () => {
    const { service, selected, store } = fixture();
    for (const raw of [{ ...input, verified: true }, { ...input, ownerUserId: owner.userId }, { ...input, note: 'a'.repeat(1001) }, { ...input, collection: address(0) }])
      await expect(service.create(raw, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_INPUT_INVALID' });
    selected.mockResolvedValueOnce({ ...deployment, deploymentId: 'f'.repeat(64) });
    await expect(service.create(input, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    await expect(createExternalNftImports({ store }).create(input, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    selected.mockResolvedValueOnce({ ...deployment, chainId: 8453 } as unknown as ExternalImportDeployment);
    await expect(service.create(input, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    expect((await service.list(owner)).items).toHaveLength(0);
  });
  it('requires exact trusted inspection before review approval and keeps all operator evidence private', async () => {
    const { service, store, inspect } = fixture(), created = await service.create(input, owner);
    await expect(createExternalNftImports({ store, deployment: async () => deployment }).review(created.id, 1, { decision: 'review-approved' }, 'admin:one')).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    inspect.mockResolvedValueOnce({ ...inspection(), collection: address(4) });
    await expect(service.review(created.id, 1, { decision: 'review-approved' }, 'admin:one')).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    const approved = await service.review(created.id, 1, { decision: 'review-approved', customerNote: 'Reviewed for registry submission.', operatorEvidence: 'Private RPC/operator evidence.' }, 'admin:one');
    expect(approved.request).toMatchObject({ status: 'review-approved', revision: 2, admissionStatus: 'not-established' });
    expect(approved.review?.inspectionCommitment).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.review?.inspection).toEqual(inspection());
    const customer = JSON.stringify(await service.read(created.id, owner));
    for (const secret of ['Private RPC', 'runtimeCodeHash', 'inspection', 'admin:one', 'ownerUserId']) expect(customer).not.toContain(secret);
    expect(customer).toContain('Reviewed for registry submission.');
    await expect(service.review(created.id, 2, { decision: 'rejected' }, 'admin:two')).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
  });
  it('can reject without RPC and never accepts client-provided inspected evidence', async () => {
    const { service, inspect } = fixture(), created = await service.create(input, owner);
    await expect(service.review(created.id, 1, { decision: 'review-approved', runtimeCodeHash: inspection().runtimeCodeHash }, 'admin:one')).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_INPUT_INVALID' });
    const rejected = await service.review(created.id, 1, { decision: 'rejected', customerNote: 'This collection is not supported.' }, 'admin:one');
    expect(inspect).not.toHaveBeenCalled(); expect(rejected.review?.inspection).toBeNull(); expect(rejected.request.admissionStatus).toBe('not-established');
  });
  it('prevents an inspection resolving after withdrawal from approving the withdrawn request', async () => {
    const { service, inspect } = fixture(), created = await service.create(input, owner);
    let finish!: (value: ExternalNftImportInspection) => void;
    inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reviewing = service.review(created.id, 1, { decision: 'review-approved' }, 'admin:one');
    await vi.waitFor(() => expect(inspect).toHaveBeenCalled());
    const withdrawn = await service.withdraw(created.id, 1, owner); finish(inspection());
    await expect(reviewing).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
    expect(await service.read(created.id, owner)).toEqual(withdrawn);
  });
  it('preserves reviewed evidence on withdrawal, rejects stale revisions and detects corrupted records', async () => {
    const { service, records } = fixture(), created = await service.create(input, owner);
    await service.review(created.id, 1, { decision: 'review-approved', operatorEvidence: 'Original review' }, 'admin:one');
    await expect(service.withdraw(created.id, 1, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CHANGED' });
    const withdrawn = await service.withdraw(created.id, 2, owner); expect(withdrawn.status).toBe('withdrawn');
    expect((await service.adminRead(created.id)).review?.operatorEvidence).toBe('Original review');
    records.get(created.id)!.review!.inspection!.runtimeCodeHash = `0x${'c'.repeat(64)}`;
    await expect(service.read(created.id, owner)).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
  });
  it('paginates complete account history with account/limit-bound cursors without returning account IDs', async () => {
    const { service } = fixture();
    for (let index = 0; index < 4; index++) await service.create({ ...input, collection: address(index + 10) }, owner);
    const first = await service.list(owner, { limit: 2 }); expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeTypeOf('string');
    const next = await service.list(owner, { limit: 2, cursor: first.nextCursor! }); expect(next.items).toHaveLength(2); expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map(value => value.id)).size).toBe(4);
    expect(Buffer.from(first.nextCursor!, 'base64url').toString()).not.toContain(owner.userId);
    await expect(service.list(other, { limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CURSOR_INVALID' });
    await expect(service.list(owner, { limit: 3, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_CURSOR_INVALID' });
  });
});
describe('external import account HTTP boundary', () => {
  const send = (handler: ReturnType<typeof api>, suffix = '', method = 'GET', body?: unknown) => handler(new NextRequest(`http://localhost/api/oneshot/external-nfts/imports${suffix}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), {});
  it('authenticates every supported account operation and never dispatches an administrator operation', async () => {
    const { service } = fixture(), auth = vi.fn(async () => owner), handler = api(createExternalNftImportsApi(service, auth));
    const response = await send(handler, '', 'POST', input); expect(response.status).toBe(201); const created = await response.json();
    expect((await send(handler)).status).toBe(200); expect((await send(handler, `/${created.id}`)).status).toBe(200);
    expect((await send(handler, `/${created.id}`, 'DELETE', { expectedRevision: 1 })).status).toBe(200); expect(auth).toHaveBeenCalledTimes(4);
    expect((await send(handler, '/admin')).status).toBe(404); expect((await send(handler, `/${created.id}/review`, 'POST', {})).status).toBe(404);
    expect((await send(handler, '?ownerUserId=other')).status).toBe(400);
    expect((await send(handler, '', 'POST', { ...input, note: 'x'.repeat(9000) })).status).toBe(413);
    expect((await send(handler, '', 'PUT', {})).status).toBe(405);
  });
  it('redacts rejected storage/provider errors rather than returning empty history or accepting a request', async () => {
    const { store } = fixture(), secret = 'https://secret:credential@provider.example';
    const service = createExternalNftImports({ store, deployment: async () => { throw new Error(secret); } });
    const handler = api(createExternalNftImportsApi(service, async () => owner));
    const response = await send(handler, '', 'POST', input); expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
  });
});
