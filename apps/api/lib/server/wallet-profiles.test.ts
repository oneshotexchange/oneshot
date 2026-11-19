import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createWalletProfiles, createWalletProfilesApi } from './wallet-profiles';
import { api } from './http';
import { emptyWalletProfile } from '../../../web/lib/wallet-profile';
import type { OneshotSession } from './oneshot-auth';

const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const session: OneshotSession = { provider: 'privy', userId: 'did:privy:alice', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [wallet] };
const details = { ...emptyWalletProfile(), displayName: 'Nebula studio', bio: 'Art from orbit', website: 'https://example.com' };
function fixture() {
  const records = new Map<string, unknown>();
  const media = vi.fn(async () => null as unknown);
  const service = createWalletProfiles({
    get: async key => records.get(key) ?? null,
    create: async record => { if (records.has(record.account.wallet)) throw new Error('CONFLICT'); records.set(record.account.wallet, structuredClone(record)); },
    compare: async (key, previous, next) => { if (JSON.stringify(records.get(key)) !== JSON.stringify(previous)) return false; records.set(key, structuredClone(next)); return true; },
    media, now: () => '2026-11-19T00:00:00.000Z',
  });
  return { service, records, media };
}
describe('wallet profile publication', () => {
  it('keeps an unsaved and privately saved profile out of public reads', async () => {
    const { service } = fixture();
    expect(await service.public(wallet)).toEqual({ wallet, profile: null });
    expect((await service.account(wallet, session)).revision).toBe(0);
    const saved = await service.save(wallet, 0, details, session);
    expect(saved).toMatchObject({ revision: 1, draft: details, published: null });
    expect(await service.public(wallet)).toEqual({ wallet, profile: null });
  });
  it('publishes an allowlisted snapshot and preserves it through later private edits', async () => {
    const { service } = fixture();
    await service.save(wallet, 0, details, session);
    await service.publish(wallet, 1, session);
    const published = await service.public(wallet);
    expect(published.profile).toMatchObject({ ...details, wallet });
    for (const key of ['ownerUserId', 'sessionId', 'draft', 'revision', 'linkedAddresses']) expect(JSON.stringify(published)).not.toContain(key);
    await service.save(wallet, 2, { ...details, bio: 'Private changes' }, session);
    expect(await service.public(wallet)).toEqual(published);
    await service.publish(wallet, 3, session);
    expect((await service.public(wallet)).profile?.bio).toBe('Private changes');
    const unpublished = await service.unpublish(wallet, 4, session);
    expect(unpublished.draft.bio).toBe('Private changes');
    expect(await service.public(wallet)).toEqual({ wallet, profile: null });
  });
  it('requires a current linked wallet for reads and writes, and the original owning account', async () => {
    const { service } = fixture();
    await expect(service.save(other, 0, details, session)).rejects.toMatchObject({ status: 403, code: 'WALLET_NOT_LINKED' });
    await service.save(wallet, 0, details, session);
    await expect(service.account(wallet, { ...session, linkedAddresses: [] })).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    const impostor = { ...session, userId: 'did:privy:bob' };
    for (const action of [() => service.account(wallet, impostor), () => service.save(wallet, 1, details, impostor), () => service.publish(wallet, 1, impostor), () => service.unpublish(wallet, 1, impostor)])
      await expect(action()).rejects.toMatchObject({ status: 403, code: 'PROFILE_ACCOUNT_MISMATCH' });
  });
  it('rejects stale revisions and concurrent overwrites without changing the winning edit', async () => {
    const { service } = fixture();
    await service.save(wallet, 0, details, session);
    const results = await Promise.allSettled([service.save(wallet, 1, { ...details, bio: 'One' }, session), service.save(wallet, 1, { ...details, bio: 'Two' }, session)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await service.account(wallet, session)).revision).toBe(2);
    await expect(service.unpublish(wallet, 1, session)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
  });
  it('requires a saved nonblank name and rejects arbitrary fields, control text and unsafe websites', async () => {
    const { service } = fixture();
    await expect(service.publish(wallet, 0, session)).rejects.toMatchObject({ code: 'PROFILE_NAME_REQUIRED' });
    for (const input of [{ ...details, userId: 'hidden' }, { ...details, displayName: 'x\u202ey' }, { ...details, website: 'javascript:alert(1)' }, { ...details, website: 'https://user:secret@example.com' }, { ...details, website: 'https://127.0.0.1' }, { ...details, avatarPath: 'https://example.com/avatar.png' }])
      await expect(service.save(wallet, 0, input, session)).rejects.toMatchObject({ code: 'PROFILE_INPUT_INVALID' });
    expect((await service.account(wallet, session)).revision).toBe(0);
  });
  it('accepts only published sanitized local images and rechecks them at publication', async () => {
    const { service, media } = fixture(), hash = 'a'.repeat(64), path = `/api/media/${hash}.webp`;
    await expect(service.save(wallet, 0, { ...details, avatarPath: path }, session)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_UNAVAILABLE' });
    media.mockResolvedValue({ hash, mimeType: 'image/webp', size: 100 });
    await service.save(wallet, 0, { ...details, avatarPath: path, bannerPath: path }, session);
    media.mockClear(); media.mockResolvedValue(null);
    await expect(service.publish(wallet, 1, session)).rejects.toMatchObject({ code: 'PROFILE_IMAGE_UNAVAILABLE' });
    expect(media).toHaveBeenCalledTimes(1);
    expect((await service.account(wallet, session)).revision).toBe(1);
  });
  it('fails unreadable records instead of returning an empty profile or private fields', async () => {
    const { service, records } = fixture();
    records.set(wallet, { ownerUserId: 'did:privy:secret', draft: details });
    await expect(service.public(wallet)).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
    await expect(service.account(wallet, session)).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
  });
});
describe('wallet profile HTTP boundary', () => {
  const send = (handler: ReturnType<typeof api>, path: string, method = 'GET', body?: unknown) => handler(new NextRequest(`http://localhost/api/oneshot/profiles/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), {});
  it('serves public details without authenticating and protects every account path', async () => {
    const { service } = fixture(), auth = vi.fn(async () => session), handler = api(createWalletProfilesApi(service, auth));
    expect((await send(handler, wallet)).status).toBe(200); expect(auth).not.toHaveBeenCalled();
    expect((await send(handler, `me?wallet=${wallet}`)).status).toBe(200); expect(auth).toHaveBeenCalledTimes(1);
    expect((await send(handler, 'me', 'PUT', { wallet, expectedRevision: 0, profile: details })).status).toBe(200);
    expect((await send(handler, 'me/publish', 'POST', { wallet, expectedRevision: 1 })).status).toBe(200);
    expect((await send(handler, 'me/publish', 'DELETE', { wallet, expectedRevision: 2 })).status).toBe(200);
    expect(auth).toHaveBeenCalledTimes(4);
  });
  it('rejects ambiguous wallets, extra parameters/fields, oversized input and unsupported methods', async () => {
    const { service } = fixture(), handler = api(createWalletProfilesApi(service, async () => session));
    for (const path of [`me?wallet=${wallet}&wallet=${other}`, `me?wallet=${wallet}&private=true`, `${wallet}?private=true`]) expect((await send(handler, path)).status).toBe(400);
    expect((await send(handler, 'me', 'PUT', { wallet, expectedRevision: 0, profile: details, publish: true })).status).toBe(400);
    expect((await send(handler, 'me', 'PUT', { wallet, expectedRevision: 0, profile: { bio: 'x'.repeat(17000) } })).status).toBe(413);
    expect((await send(handler, 'me', 'POST', {})).status).toBe(405);
    expect((await send(handler, 'me/private')).status).toBe(404);
  });
});
