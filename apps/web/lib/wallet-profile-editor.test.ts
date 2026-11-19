import { describe, expect, it, vi } from 'vitest';
import { completeWalletProfileChange, restoreWalletProfileWorkingCopy, walletProfileEditConflict, walletProfileHasOpenEdits, type WalletProfileWorkingCopy } from './wallet-profile-editor';
import { emptyWalletProfile, type AccountWalletProfile } from './wallet-profile';
import { createOneshotAccountApi } from './client-oneshot-api';

const wallet = `0x${'1'.repeat(40)}`, time = '2026-11-19T00:00:00.000Z';
const saved = (): AccountWalletProfile => {
  const draft = { ...emptyWalletProfile(), displayName: 'Original name', bio: 'Saved bio' };
  return { wallet, revision: 3, draft, published: { ...draft, wallet, publishedAt: time }, updatedAt: time };
};
const openEdits = (account: AccountWalletProfile): WalletProfileWorkingCopy => ({ draft: { ...account.draft, bio: 'My unsaved bio' }, baseRevision: account.revision, conflicted: false });

describe('profile working-copy revisions and publication', () => {
  it('keeps unsaved edits and their cache after unpublishing, advancing only the known publication revision', () => {
    const account = saved(), copy = openEdits(account), unpublished = { ...account, revision: 4, published: null };
    const next = completeWalletProfileChange(account, copy, 'unpublish', unpublished);
    expect(next).toEqual({ ...copy, baseRevision: 4 });
    expect(walletProfileHasOpenEdits(unpublished, next)).toBe(true);
    expect(walletProfileEditConflict(unpublished, next)).toBe(false);
    expect(restoreWalletProfileWorkingCopy(unpublished, next)).toEqual(next);
    const savedEdits = { ...unpublished, revision: 5, draft: copy.draft };
    expect(completeWalletProfileChange(unpublished, next, 'save', savedEdits)).toEqual({ draft: copy.draft, baseRevision: 5, conflicted: false });
    expect(account.draft.bio).toBe('Saved bio'); expect(copy.draft.bio).toBe('My unsaved bio');
  });
  it('restores wallet-away edits against their original revision and detects another device’s newer saved version', () => {
    const account = saved(), cached = openEdits(account);
    const latest = { ...account, revision: 4, draft: { ...account.draft, displayName: 'Changed on another device' }, published: null };
    const restored = restoreWalletProfileWorkingCopy(latest, cached);
    expect(restored.draft).toEqual(cached.draft); expect(restored.baseRevision).toBe(3); expect(walletProfileEditConflict(latest, restored)).toBe(true);
    expect(latest.published).toBeNull();
    expect(() => completeWalletProfileChange(latest, restored, 'save', { ...latest, revision: 5, draft: restored.draft })).toThrow('Review');
    expect(() => completeWalletProfileChange(latest, restored, 'publish', { ...latest, revision: 5 })).toThrow('Review');
  });
  it('does not erase an unresolved private-draft conflict when the user unpublishes the latest public version', () => {
    const account = saved(), cached = openEdits(account), latest = { ...account, revision: 4, draft: { ...account.draft, bio: 'New saved bio' } };
    const restored = restoreWalletProfileWorkingCopy(latest, cached), unpublished = { ...latest, revision: 5, published: null };
    const next = completeWalletProfileChange(latest, restored, 'unpublish', unpublished);
    expect(next.draft).toEqual(cached.draft); expect(next.baseRevision).toBe(3); expect(next.conflicted).toBe(true);
    expect(restoreWalletProfileWorkingCopy(unpublished, next).conflicted).toBe(true);
  });
  it('clears conflict only after an explicit saved-version replacement or an exact reviewed save', () => {
    const account = saved(), latest = { ...account, revision: 4, draft: { ...account.draft, bio: 'Other saved bio' } };
    const restored = restoreWalletProfileWorkingCopy(latest, openEdits(account));
    expect(restoreWalletProfileWorkingCopy(latest)).toEqual({ draft: latest.draft, baseRevision: 4, conflicted: false });
    const result = { ...latest, revision: 5, draft: restored.draft };
    expect(() => completeWalletProfileChange(latest, restored, 'save', result, 3)).toThrow('Review');
    const replaced = completeWalletProfileChange(latest, restored, 'save', result, 4);
    expect(replaced).toEqual({ draft: restored.draft, baseRevision: 5, conflicted: false });
    expect(walletProfileHasOpenEdits(result, replaced)).toBe(false);
  });
  it('does not mistake a changed private draft or an unrelated mutation result for a publication-only revision', () => {
    const account = saved(), copy = openEdits(account);
    expect(() => completeWalletProfileChange(account, copy, 'unpublish', { ...account, revision: 4, published: null, draft: { ...account.draft, bio: 'Unexpected replacement' } })).toThrow('verified');
    expect(() => completeWalletProfileChange(account, copy, 'unpublish', { ...account, revision: 5, published: null })).toThrow('verified');
    expect(() => completeWalletProfileChange(account, copy, 'unpublish', { ...account, revision: 4, wallet: `0x${'2'.repeat(40)}`, published: null })).toThrow('verified');
  });
  it('keeps the reviewed revision after acknowledgement so another concurrent change still rejects the save', async () => {
    const original = saved(), copy = openEdits(original), reviewed = { ...original, revision: 4, draft: { ...original.draft, bio: 'Reviewed saved bio' } };
    const restored = restoreWalletProfileWorkingCopy(reviewed, copy);
    const external = { ...reviewed, revision: 5, draft: { ...reviewed.draft, bio: 'Changed again after review' } };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'PUT') return Response.json({ error: { code: 'PROFILE_CHANGED', message: 'This profile changed elsewhere. Reload the saved profile before trying again. Your edits are still open.' } }, { status: 409 });
      return Response.json(external);
    });
    const api = createOneshotAccountApi({ fetcher, identityScope: () => 'owner:wallet', getAccessToken: async () => 'fresh-token' });
    await expect(api.changeWalletProfile('save', reviewed, restored.draft)).rejects.toThrow('changed elsewhere');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ expectedRevision: 4, profile: copy.draft });
    const refreshed = await api.getWalletProfile(wallet), retained = restoreWalletProfileWorkingCopy(refreshed, restored);
    expect(retained.draft).toEqual(copy.draft); expect(retained.baseRevision).toBe(3); expect(retained.conflicted).toBe(true);
    expect(refreshed.draft.bio).toBe('Changed again after review');
  });
});
