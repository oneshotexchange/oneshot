import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createWalletFollowing, createWalletFollowingApi } from './wallet-following';
import { api } from './http';
import type { OneshotSession } from './oneshot-auth';
const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const alice: OneshotSession = { provider: 'privy', userId: 'did:privy:alice', sessionId: 'a', expiresAt: 9999999999, linkedAddresses: [] };
function fixture() {
  const records = new Map<string, unknown>();
  const service = createWalletFollowing({ get: async id => records.get(id) ?? null, create: async (id, value) => { if (!records.has(id)) records.set(id, structuredClone(value)); return records.get(id); }, compare: async (id, previous, next) => { if (JSON.stringify(records.get(id)) !== JSON.stringify(previous)) return false; records.set(id, structuredClone(next)); return true; }, now: () => '2026-11-19T00:00:00.000Z' });
  return { service, records };
}
describe('private wallet following', () => {
  it('supports accounts without wallets, isolates account lists and exposes no account IDs', async () => {
    const { service } = fixture(), bob = { ...alice, userId: 'did:privy:bob' };
    expect(await service.read(alice)).toEqual({ revision: 0, wallets: [], updatedAt: null });
    const followed = await service.change(wallet, true, 0, alice);
    expect(followed.wallets).toEqual([wallet]); expect(JSON.stringify(followed)).not.toContain('did:privy');
    expect((await service.read(bob)).wallets).toEqual([]);
    expect((await service.change(wallet, false, 1, alice)).wallets).toEqual([]);
  });
  it('prevents stale and concurrent writes from overwriting newer follows', async () => {
    const { service } = fixture();
    const claims = await Promise.allSettled([service.change(wallet, true, 0, alice), service.change(other, true, 0, alice)]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await service.read(alice)).wallets).toHaveLength(1);
    await expect(service.change(other, true, 0, alice)).rejects.toMatchObject({ code: 'FOLLOWING_CHANGED' });
    const edits = await Promise.allSettled([service.change(wallet, true, 1, alice), service.change(other, true, 1, alice)]);
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('enforces 50 unique canonical wallets and keeps removal available at capacity', async () => {
    const { service } = fixture();
    for (let index = 1; index <= 50; index++) await service.change(`0x${index.toString(16).padStart(40, '0')}`, true, index - 1, alice);
    await expect(service.change(other, true, 50, alice)).rejects.toMatchObject({ code: 'FOLLOWING_LIMIT' });
    expect((await service.change(`0x${'1'.padStart(40, '0')}`, false, 50, alice)).wallets).toHaveLength(49);
    expect((await service.change(other.toUpperCase(), true, 51, alice)).wallets).toHaveLength(50);
  });
  it('fails unreadable records instead of turning a failed load into an empty list', async () => {
    const { service, records } = fixture(); await service.change(wallet, true, 0, alice);
    for (const key of records.keys()) records.set(key, { ownerUserId: alice.userId, following: { revision: 2, wallets: [wallet, wallet] } });
    await expect(service.read(alice)).rejects.toMatchObject({ code: 'FOLLOWING_UNAVAILABLE' });
  });
  it('authenticates reads/writes and rejects query/owner injection', async () => {
    const { service } = fixture(), auth = vi.fn(async () => alice), handler = api(createWalletFollowingApi(service, auth));
    const send = (method: string, body?: unknown, query = '') => handler(new NextRequest(`http://localhost/api/oneshot/following${query}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), {});
    expect((await send('GET')).status).toBe(200);
    expect((await send('PUT', { wallet, following: true, expectedRevision: 0 })).status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(2);
    expect((await send('PUT', { wallet, following: false, expectedRevision: 1, ownerUserId: 'other' })).status).toBe(400);
    expect((await send('GET', undefined, '?user=other')).status).toBe(404);
    expect((await send('POST', {})).status).toBe(405);
  });
});
