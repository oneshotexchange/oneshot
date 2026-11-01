import { describe, expect, it, vi } from 'vitest';
import { createNftDraftHandoffLoader, nftDeployedCollectionHref, nftDraftResumeHref, parseNftDraftHandoff } from './client-nft-handoff';
import type { OneshotDraft } from './oneshot-draft-schema';

const draftId = 'c73de71c-6638-41cb-bcf2-40b4d1eb85bb', launchId = 'a4c55b64-a888-43dc-a09c-41558c8b00ae';
const prepared = { id: draftId, ownerUserId: 'owner', status: 'prepared', snapshot: { manifestHash: 'ab'.repeat(32) } } as OneshotDraft;
function pending<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe('private creator handoff', () => {
  it('only accepts explicit, single UUID targets and retains an optional exact launch selection', () => {
    expect(parseNftDraftHandoff('')).toBeNull();
    expect(parseNftDraftHandoff(`?draft=${draftId}&launch=${launchId}`)).toEqual({ draftId, launchId });
    expect(parseNftDraftHandoff(`?draft=${draftId}`)).toEqual({ draftId, launchId: null });
    for (const query of ['?draft=../private', `?draft=${draftId}&draft=${draftId}`, `?launch=${launchId}`, `?draft=${draftId}&launch=bad`, `?draft=${draftId}&launch=${launchId}&launch=${launchId}`]) expect(() => parseNftDraftHandoff(query)).toThrow('link is invalid');
  });
  it('constructs fixed internal draft and deployment-bound collection links', () => {
    expect(nftDraftResumeHref(draftId, launchId)).toBe(`/nfts/new?draft=${draftId}&launch=${launchId}`);
    expect(nftDraftResumeHref('https://other.example', launchId)).toBeNull();
    expect(nftDraftResumeHref(draftId, 'unsafe')).toBeNull();
    expect(nftDeployedCollectionHref(`0x${'AB'.repeat(20)}`, 'CD'.repeat(32))).toBe(`/nfts/0x${'ab'.repeat(20)}?deployment=${'cd'.repeat(32)}`);
    expect(nftDeployedCollectionHref(`0x${'ab'.repeat(20)}`, 'other-deployment')).toBeNull();
    expect(nftDeployedCollectionHref('//other.example', 'cd'.repeat(32))).toBeNull();
  });
  it('loads an owned prepared draft through a read without signing or uploading', async () => {
    const getDraft = vi.fn(async () => prepared);
    const loader = createNftDraftHandoffLoader({ identity: () => ({ userId: 'owner', scope: 'session:wallet' }), getDraft });
    expect(await loader.load(draftId)).toBe(prepared);
    expect(getDraft).toHaveBeenCalledExactlyOnceWith(draftId);
  });
  it.each([{ userId: null, scope: null }, { userId: 'owner', scope: null }])('does not read a draft before authentication: %j', async identity => {
    const getDraft = vi.fn();
    const loader = createNftDraftHandoffLoader({ identity: () => identity, getDraft });
    await expect(loader.load(draftId)).rejects.toThrow('Sign in');
    expect(getDraft).not.toHaveBeenCalled();
  });
  it.each([{ ...prepared, ownerUserId: 'another-account' }, { ...prepared, id: launchId }, { ...prepared, status: 'deleted' }, { ...prepared, status: 'draft' }, { ...prepared, snapshot: undefined }])('rejects a foreign, changed or unprepared response', async record => {
    const loader = createNftDraftHandoffLoader({ identity: () => ({ userId: 'owner', scope: 'session' }), getDraft: async () => record as OneshotDraft });
    await expect(loader.load(draftId)).rejects.toThrow('unavailable in your account');
  });
  it('discards both late data and late errors after logout, account or wallet changes', async () => {
    for (const identity of [{ userId: null, scope: null }, { userId: 'next-user', scope: 'new-session' }, { userId: 'owner', scope: 'new-wallet' }]) {
      let active: { userId: string | null; scope: string | null } = { userId: 'owner', scope: 'session' };
      const old = pending<OneshotDraft>();
      const loader = createNftDraftHandoffLoader({ identity: () => active, getDraft: () => old.promise });
      const loading = loader.load(draftId); active = identity; old.resolve(prepared);
      expect(await loading).toBeNull();
    }
    let active = { userId: 'owner', scope: 'session' }; const old = pending<OneshotDraft>();
    const loader = createNftDraftHandoffLoader({ identity: () => active, getDraft: () => old.promise });
    const loading = loader.load(draftId); active = { userId: 'another', scope: 'other' }; old.reject(new Error('private old response'));
    expect(await loading).toBeNull();
  });
  it('allows only the latest request generation to open content and supports explicit cancellation', async () => {
    const first = pending<OneshotDraft>(), second = pending<OneshotDraft>();
    const getDraft = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loader = createNftDraftHandoffLoader({ identity: () => ({ userId: 'owner', scope: 'session' }), getDraft });
    const before = loader.load(draftId), after = loader.load(draftId);
    second.resolve(prepared); expect(await after).toBe(prepared);
    first.resolve(prepared); expect(await before).toBeNull();
    const third = pending<OneshotDraft>(); getDraft.mockReturnValueOnce(third.promise);
    const canceled = loader.load(draftId); loader.cancel(); third.resolve(prepared);
    expect(await canceled).toBeNull();
  });
});
