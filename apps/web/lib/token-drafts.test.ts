import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_TOKEN_DRAFT_STORAGE_KEY, MAX_SAVED_TOKEN_DRAFTS, TOKEN_DRAFTS_STORAGE_KEY,
  createTokenDraftAutosave, emptyTokenDraft, emptyTokenDraftWorkspace, listTokenDrafts, newTokenDraft, readTokenDrafts,
  removeTokenDraft, resumeTokenDraft, saveTokenDraft, tokenDraftReviewSchema, tokenDraftSchema,
  workingTokenDraft, writeTokenDrafts, type TokenDraft,
} from './token-drafts';

const date = '2026-11-10T10:00:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const terms = (name = 'Orbit'): TokenDraft => ({ ...emptyTokenDraft(), name, symbol: 'ORBIT', description: 'Our community', website: 'https://example.com', fee: 2.3, openingValuation: '123.000000000000000001' });
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
const clock = (number: number) => ({ createId: () => id(number), now: () => date });

describe('token browser drafts', () => {
  it('recovers a legacy single draft as its own saved plan without rewriting the original key', () => {
    const legacy = { ...terms(), pricingNetwork: undefined };
    const raw = JSON.stringify(legacy);
    const storage = memory({ [LEGACY_TOKEN_DRAFT_STORAGE_KEY]: raw });
    const loaded = readTokenDrafts(storage, clock(1));
    expect(loaded.source).toBe('legacy'); expect(loaded.snapshot).toContain('oneshot:draft-migration:');
    expect(loaded.workspace.working).toEqual({ draft: legacy, savedId: id(1) });
    expect(loaded.workspace.saved).toEqual([{ id: id(1), savedAt: date, draft: legacy }]);
    expect(storage.setItem).not.toHaveBeenCalled();
    const snapshot = writeTokenDrafts(storage, loaded.workspace, loaded.snapshot);
    expect(storage.values.get(LEGACY_TOKEN_DRAFT_STORAGE_KEY)).toBe(raw);
    expect(readTokenDrafts(storage).workspace).toEqual(loaded.workspace);
    expect(readTokenDrafts(storage).snapshot).toBe(snapshot);
  });

  it('retains older partial legacy fields with the original defaults, but does not save an empty default plan', () => {
    const older = memory({ [LEGACY_TOKEN_DRAFT_STORAGE_KEY]: JSON.stringify({ name: 'Older plan', symbol: 'OLD' }) });
    expect(readTokenDrafts(older, clock(1)).workspace.working.draft).toEqual({ ...emptyTokenDraft(), pricingNetwork: undefined, name: 'Older plan', symbol: 'OLD' });
    const empty = memory({ [LEGACY_TOKEN_DRAFT_STORAGE_KEY]: JSON.stringify(emptyTokenDraft()) });
    expect(readTokenDrafts(empty).workspace.saved).toEqual([]);
  });

  it('rejects unreadable legacy values without clamping financial terms or creating a replacement workspace', () => {
    for (const value of ['{', JSON.stringify({ ...terms(), fee: 9 }), JSON.stringify({ ...terms(), mode: 'unknown' }), JSON.stringify({ ...terms(), accessToken: 'private' })]) {
      const storage = memory({ [LEGACY_TOKEN_DRAFT_STORAGE_KEY]: value });
      expect(() => readTokenDrafts(storage)).toThrow('previous token draft');
      expect(() => writeTokenDrafts(storage, emptyTokenDraftWorkspace(), null)).toThrow('previous token draft');
      expect(storage.values.get(LEGACY_TOKEN_DRAFT_STORAGE_KEY)).toBe(value);
      expect(storage.values.has(TOKEN_DRAFTS_STORAGE_KEY)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });

  it('rejects unknown account fields, wrong types, oversized terms and fees that disagree with displayed precision', () => {
    for (const invalid of [
      { ...terms(), ownerUserId: 'another-account' }, { ...terms(), id: id(1) }, { ...terms(), name: 4 },
      { ...terms(), name: 'a'.repeat(33) }, { ...terms(), description: 'a'.repeat(501) },
      { ...terms(), website: 'x'.repeat(2049) }, { ...terms(), symbol: 'lowercase' },
      { ...terms(), fee: Number.NaN }, { ...terms(), fee: Number.POSITIVE_INFINITY }, { ...terms(), fee: 1.25 },
      { ...terms(), mode: 'other' }, { ...terms(), openingValuation: '1e9' }, { ...terms(), openingValuation: '1'.repeat(61) },
    ]) expect(tokenDraftSchema.safeParse(invalid).success).toBe(false);
    expect(tokenDraftSchema.parse(terms()).openingValuation).toBe('123.000000000000000001');
  });

  it('autosaves incomplete working fields without claiming the draft is ready for review', () => {
    const draft = { ...emptyTokenDraft(), name: 'In progress', symbol: 'O', website: 'https://', openingValuation: '0.' };
    expect(tokenDraftSchema.parse(draft)).toEqual(draft);
    expect(tokenDraftReviewSchema.safeParse(draft).success).toBe(false);
    expect(tokenDraftReviewSchema.safeParse({ ...terms(), website: 'javascript:alert(1)' }).success).toBe(false);
    expect(tokenDraftReviewSchema.safeParse({ ...terms(), website: 'https://user:pass@example.com' }).success).toBe(false);
    expect(tokenDraftReviewSchema.safeParse(terms()).success).toBe(true);
  });

  it('keeps a distinct working copy, saves multiple plans and edits only the explicitly selected saved version', () => {
    const first = saveTokenDraft(emptyTokenDraftWorkspace(), terms('First'), clock(1));
    const edited = workingTokenDraft(first, terms('Changed but not saved'));
    expect(listTokenDrafts(edited)[0].draft.name).toBe('First');
    const second = saveTokenDraft(newTokenDraft(edited, terms('Second')), terms('Second'), clock(2));
    expect(second.saved.map(record => record.draft.name)).toEqual(['Second', 'First']);
    const resumed = resumeTokenDraft(second, id(1));
    expect(resumed.working.draft.name).toBe('First');
    const updated = saveTokenDraft(resumed, terms('First revised'), { id: id(1), now: () => date });
    expect(updated.saved.map(record => record.draft.name)).toEqual(['First revised', 'Second']);
    expect(first.saved[0].draft.name).toBe('First');
  });

  it('loads an imported draft as a new working copy without replacing any saved plan', () => {
    const previous = saveTokenDraft(emptyTokenDraftWorkspace(), terms('Stored'), clock(1));
    const restored = newTokenDraft(previous, terms('Imported'));
    expect(restored.working.savedId).toBeNull();
    expect(restored.working.draft.name).toBe('Imported');
    expect(restored.saved).toEqual(previous.saved);
  });

  it('can explicitly resume a saved plan while discarding an invalid in-progress field', () => {
    const saved = saveTokenDraft(emptyTokenDraftWorkspace(), terms('Stored'), clock(1));
    const working = { ...saved, working: { ...saved.working, draft: { ...saved.working.draft, openingValuation: '1e' } } };
    expect(resumeTokenDraft(working, id(1)).working.draft).toEqual(terms('Stored'));
    expect(working.working.draft.openingValuation).toBe('1e');
  });

  it('refuses the twenty-first saved plan and identifier collisions without evicting any saved draft', () => {
    let workspace = emptyTokenDraftWorkspace();
    for (let number = 1; number <= MAX_SAVED_TOKEN_DRAFTS; number++) workspace = saveTokenDraft(workspace, terms('Plan ' + number), clock(number));
    const before = JSON.stringify(workspace);
    expect(() => saveTokenDraft(workspace, terms('Another'), clock(21))).toThrow('20 saved token drafts');
    expect(JSON.stringify(workspace)).toBe(before);
    expect(saveTokenDraft(workspace, terms('Edited at capacity'), { id: id(1), now: () => date }).saved).toHaveLength(20);
    const one = saveTokenDraft(emptyTokenDraftWorkspace(), terms(), clock(1));
    expect(() => saveTokenDraft(one, terms('Collision'), clock(1))).toThrow('existing drafts have not changed');
    expect(one.saved[0].draft.name).toBe('Orbit');
  });

  it('removes only the chosen saved copy and preserves the open working draft', () => {
    let workspace = saveTokenDraft(emptyTokenDraftWorkspace(), terms('First'), clock(1));
    workspace = saveTokenDraft(workspace, terms('Second'), clock(2));
    const removed = removeTokenDraft(workspace, id(2));
    expect(removed.saved.map(record => record.id)).toEqual([id(1)]);
    expect(removed.working).toEqual({ draft: terms('Second'), savedId: null });
    expect(() => resumeTokenDraft(removed, id(2))).toThrow('no longer available');
  });

  it('round-trips the working copy and saved records as one atomic value', () => {
    const storage = memory();
    let workspace = saveTokenDraft(emptyTokenDraftWorkspace(), terms(), clock(1));
    workspace = workingTokenDraft(workspace, { ...terms(), description: 'Unsaved edit' });
    const snapshot = writeTokenDrafts(storage, workspace, null);
    expect(readTokenDrafts(storage).workspace).toEqual(workspace);
    expect(writeTokenDrafts(storage, workspace, snapshot)).toBe(snapshot);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it('never overwrites unreadable workspace data, including data corrupted after it was loaded', () => {
    for (const raw of ['{', ' '.repeat(300000), JSON.stringify({ version: 2 }), JSON.stringify({ ...emptyTokenDraftWorkspace(), accessToken: 'private' })]) {
      const storage = memory({ [TOKEN_DRAFTS_STORAGE_KEY]: raw });
      expect(() => readTokenDrafts(storage)).toThrow('could not be read');
      expect(() => writeTokenDrafts(storage, emptyTokenDraftWorkspace(), raw)).toThrow('could not be read');
      expect(storage.values.get(TOKEN_DRAFTS_STORAGE_KEY)).toBe(raw);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
    const storage = memory(), snapshot = writeTokenDrafts(storage, emptyTokenDraftWorkspace(), null);
    storage.values.set(TOKEN_DRAFTS_STORAGE_KEY, '{');
    expect(() => writeTokenDrafts(storage, newTokenDraft(emptyTokenDraftWorkspace(), terms()), snapshot)).toThrow('could not be read');
    expect(storage.values.get(TOKEN_DRAFTS_STORAGE_KEY)).toBe('{');
  });

  it('detects another tab changing or deleting the workspace instead of replacing that tab’s saved work', () => {
    const storage = memory(), snapshot = writeTokenDrafts(storage, emptyTokenDraftWorkspace(), null);
    const other = saveTokenDraft(emptyTokenDraftWorkspace(), terms('Other tab'), clock(1));
    const otherSnapshot = writeTokenDrafts(storage, other, snapshot);
    expect(() => writeTokenDrafts(storage, newTokenDraft(emptyTokenDraftWorkspace(), terms()), snapshot)).toThrow('another tab');
    expect(storage.values.get(TOKEN_DRAFTS_STORAGE_KEY)).toBe(otherSnapshot);
    storage.values.delete(TOKEN_DRAFTS_STORAGE_KEY);
    expect(() => writeTokenDrafts(storage, other, otherSnapshot)).toThrow('another tab');
  });

  it('rejects duplicate saved IDs, dangling selections and unknown persisted ownership fields', () => {
    const one = saveTokenDraft(emptyTokenDraftWorkspace(), terms(), clock(1));
    for (const invalid of [{ ...one, saved: [one.saved[0], one.saved[0]] }, { ...one, working: { ...one.working, savedId: id(2) } }, { ...one, saved: [{ ...one.saved[0], ownerUserId: 'private' }] }]) {
      expect(() => readTokenDrafts(memory({ [TOKEN_DRAFTS_STORAGE_KEY]: JSON.stringify(invalid) }))).toThrow('could not be read');
    }
  });

  it('preserves the prior value when browser access or quota checks fail', () => {
    const storage = memory(), original = writeTokenDrafts(storage, emptyTokenDraftWorkspace(), null);
    storage.setItem.mockImplementation(() => { throw new Error('Quota exceeded: private browser detail'); });
    expect(() => writeTokenDrafts(storage, newTokenDraft(emptyTokenDraftWorkspace(), terms()), original)).toThrow('Keep this page open or export a backup');
    expect(storage.values.get(TOKEN_DRAFTS_STORAGE_KEY)).toBe(original);
    const denied = { getItem: () => { throw new Error('Private browser detail'); } };
    expect(() => readTokenDrafts(denied)).toThrow('Browser storage could not be opened');
    expect(() => readTokenDrafts(denied)).not.toThrow('Private browser detail');
  });

  it('flushes the latest working copy on quick unmount instead of dropping the debounce', () => {
    vi.useFakeTimers();
    try {
      const storage = memory(); let snapshot: string | null = null;
      let current = newTokenDraft(emptyTokenDraftWorkspace(), terms('First input'));
      const feedback: boolean[] = [];
      const autosave = createTokenDraftAutosave(notify => { snapshot = writeTokenDrafts(storage, current, snapshot); feedback.push(notify); });
      autosave.schedule(); vi.advanceTimersByTime(100);
      current = newTokenDraft(current, terms('Latest input')); autosave.schedule();
      autosave.dispose();
      expect(readTokenDrafts(storage).workspace.working.draft.name).toBe('Latest input');
      expect(feedback).toEqual([false]);
      autosave.dispose(); autosave.schedule(); autosave.flush(); vi.runAllTimers();
      expect(storage.setItem).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('flushes a page-hide request synchronously and cancels the obsolete timer', () => {
    vi.useFakeTimers();
    try {
      const storage = memory(); let snapshot: string | null = null;
      const current = newTokenDraft(emptyTokenDraftWorkspace(), terms());
      const feedback: boolean[] = [];
      const autosave = createTokenDraftAutosave(notify => { snapshot = writeTokenDrafts(storage, current, snapshot); feedback.push(notify); });
      autosave.schedule(); autosave.flush();
      expect(readTokenDrafts(storage).workspace.working.draft).toEqual(terms());
      expect(feedback).toEqual([true]);
      vi.advanceTimersByTime(1000); expect(feedback).toEqual([true]);
      autosave.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('persists a legacy recovery before the first debounce and never duplicates it on remount', () => {
    vi.useFakeTimers();
    try {
      const raw = JSON.stringify(terms('Legacy original'));
      const storage = memory({ [LEGACY_TOKEN_DRAFT_STORAGE_KEY]: raw });
      const loaded = readTokenDrafts(storage, clock(1));
      let snapshot = loaded.snapshot, current = loaded.workspace;
      const autosave = createTokenDraftAutosave(() => { snapshot = writeTokenDrafts(storage, current, snapshot); });
      autosave.flush();
      expect(storage.values.has(TOKEN_DRAFTS_STORAGE_KEY)).toBe(true);
      current = workingTokenDraft(current, terms('Quick edit')); autosave.schedule(); autosave.dispose();
      const nextId = vi.fn(() => id(2));
      const reopened = readTokenDrafts(storage, { createId: nextId });
      expect(nextId).not.toHaveBeenCalled();
      expect(reopened.workspace.saved.map(record => record.draft.name)).toEqual(['Legacy original']);
      expect(reopened.workspace.working.draft.name).toBe('Quick edit');
      expect(storage.values.get(LEGACY_TOKEN_DRAFT_STORAGE_KEY)).toBe(raw);
    } finally { vi.useRealTimers(); }
  });

  it('keeps cross-tab conflict protection when an unmount flush runs', () => {
    vi.useFakeTimers();
    try {
      const storage = memory(); let snapshot = writeTokenDrafts(storage, emptyTokenDraftWorkspace(), null);
      const working = newTokenDraft(emptyTokenDraftWorkspace(), terms('This tab'));
      const errors: unknown[] = [];
      const autosave = createTokenDraftAutosave(() => {
        try { snapshot = writeTokenDrafts(storage, working, snapshot); }
        catch (error) { errors.push(error); }
      });
      autosave.schedule();
      const other = saveTokenDraft(emptyTokenDraftWorkspace(), terms('Other tab'), clock(1));
      const otherSnapshot = writeTokenDrafts(storage, other, snapshot);
      autosave.dispose(); vi.runAllTimers();
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('another tab');
      expect(storage.values.get(TOKEN_DRAFTS_STORAGE_KEY)).toBe(otherSnapshot);
    } finally { vi.useRealTimers(); }
  });
});
