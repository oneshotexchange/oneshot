import { z } from 'zod';
import { readDraftStorage } from './draft-storage-migration';

export const LEGACY_TOKEN_DRAFT_STORAGE_KEY = 'oneshot.zero.tokenDraft.v1';
export const LEGACY_TOKEN_DRAFTS_STORAGE_KEY = 'oneshot.zero.tokenDrafts.v1';
export const TOKEN_DRAFTS_STORAGE_KEY = 'oneshot.tokenDrafts.v2';
export const MAX_SAVED_TOKEN_DRAFTS = 20;
const maximumBytes = 256 * 1024;
const plainLine = (maximum: number) => z.string().max(maximum).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use plain text without control characters.');

// A working draft may be incomplete. Publication/readiness validation is separate;
// in particular, typing an unfinished website must not discard the working copy.
export const tokenDraftSchema = z.object({
  pricingNetwork: z.enum(['zero', 'base-sepolia']).optional(),
  name: plainLine(32),
  symbol: z.string().regex(/^[A-Z0-9]{0,10}$/, 'Use up to 10 uppercase letters or numbers.'),
  description: z.string().max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Use plain text for the description.'),
  website: plainLine(2048),
  fee: z.number().finite().min(1).max(5).refine(value => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8, 'Choose a fee in steps of 0.1%.'),
  mode: z.enum(['creator', 'liquidity_burn']),
  openingValuation: z.string().max(60).regex(/^[0-9]*(?:\.[0-9]*)?$/, 'Use a decimal amount.'),
}).strict();
export type TokenDraft = z.infer<typeof tokenDraftSchema>;

export const tokenDraftReviewSchema = tokenDraftSchema.superRefine((draft, context) => {
  if (!draft.name.trim()) context.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'Enter a token name.' });
  if (!/^[A-Z0-9]{2,10}$/.test(draft.symbol)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['symbol'], message: 'Use a symbol of 2–10 letters or numbers.' });
  if (draft.openingValuation && !/^[0-9]+(?:\.[0-9]+)?$/.test(draft.openingValuation)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['openingValuation'], message: 'Enter a complete decimal valuation or leave it blank.' });
  if (draft.website) {
    try {
      const website = new URL(draft.website);
      if (!['https:', 'http:'].includes(website.protocol) || website.username || website.password || draft.website.trim() !== draft.website) throw new Error();
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ['website'], message: 'Enter an HTTP or HTTPS website without login details, or leave it blank.' }); }
  }
});

const idSchema = z.string().uuid().refine(value => value === value.toLowerCase());
const savedTokenDraftSchema = z.object({ id: idSchema, savedAt: z.string().max(32).datetime(), draft: tokenDraftSchema }).strict();
export type SavedTokenDraft = z.infer<typeof savedTokenDraftSchema>;
const tokenDraftWorkspaceSchema = z.object({
  version: z.literal(1),
  working: z.object({ draft: tokenDraftSchema, savedId: idSchema.nullable() }).strict(),
  saved: z.array(savedTokenDraftSchema).max(MAX_SAVED_TOKEN_DRAFTS),
}).strict().superRefine((workspace, context) => {
  const ids = workspace.saved.map(record => record.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['saved'], message: 'Saved draft identifiers must be unique.' });
  if (workspace.working.savedId && !ids.includes(workspace.working.savedId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['working'], message: 'The selected saved draft is missing.' });
});
export type TokenDraftWorkspace = z.infer<typeof tokenDraftWorkspaceSchema>;
export type TokenDraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Clock = { createId?: () => string; now?: () => string };
export class TokenDraftStorageError extends Error {
  constructor(public readonly reason: 'unreadable' | 'unavailable' | 'conflict' | 'full' | 'missing' | 'invalid', message: string) { super(message); }
}

export function emptyTokenDraft(): TokenDraft { return { pricingNetwork: 'base-sepolia', name: '', symbol: '', description: '', website: '', fee: 1, mode: 'creator', openingValuation: '' }; }
export function emptyTokenDraftWorkspace(): TokenDraftWorkspace { return { version: 1, working: { draft: emptyTokenDraft(), savedId: null }, saved: [] }; }
export function tokenDraftHasContent(draft: TokenDraft): boolean {
  const baseline = { ...emptyTokenDraft(), pricingNetwork: draft.pricingNetwork };
  return JSON.stringify(tokenDraftSchema.parse(draft)) !== JSON.stringify(tokenDraftSchema.parse(baseline));
}
export function tokenDraftsEqual(left: TokenDraft, right: TokenDraft): boolean { return JSON.stringify(tokenDraftSchema.parse(left)) === JSON.stringify(tokenDraftSchema.parse(right)); }
function clone(workspace: TokenDraftWorkspace) { return tokenDraftWorkspaceSchema.parse(workspace); }
function parsedWorkspace(raw: string): TokenDraftWorkspace {
  try {
    if (new TextEncoder().encode(raw).length > maximumBytes) throw new Error();
    return tokenDraftWorkspaceSchema.parse(JSON.parse(raw));
  } catch { throw new TokenDraftStorageError('unreadable', 'Your saved token drafts could not be read. They have not been changed. Export your open draft before reloading saved drafts.'); }
}
function makeRecord(draft: TokenDraft, clock: Clock): SavedTokenDraft {
  return savedTokenDraftSchema.parse({ id: (clock.createId || (() => crypto.randomUUID()))(), savedAt: (clock.now || (() => new Date().toISOString()))(), draft });
}
function parsedLegacy(raw: string): TokenDraft {
  try {
    if (new TextEncoder().encode(raw).length > maximumBytes) throw new Error();
    const previous = tokenDraftSchema.partial().extend({ name: tokenDraftSchema.shape.name, symbol: tokenDraftSchema.shape.symbol }).strict().parse(JSON.parse(raw));
    return tokenDraftSchema.parse({ ...emptyTokenDraft(), ...previous, pricingNetwork: undefined });
  } catch { throw new TokenDraftStorageError('unreadable', 'Your previous token draft could not be read. It has not been changed. You can prepare and export a new draft here.'); }
}

/** Reading and migration are side-effect free. The legacy key is never removed or rewritten. */
export function readTokenDrafts(storage: Pick<Storage, 'getItem'>, clock: Clock = {}): { workspace: TokenDraftWorkspace; snapshot: string | null; source: 'workspace' | 'legacy-workspace' | 'legacy' | 'empty' } {
  let selected: ReturnType<typeof readDraftStorage>;
  try {
    selected = readDraftStorage(storage, TOKEN_DRAFTS_STORAGE_KEY, [LEGACY_TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFT_STORAGE_KEY]);
    if (selected.raw !== null && selected.sourceKey !== LEGACY_TOKEN_DRAFT_STORAGE_KEY) {
      const workspace = parsedWorkspace(selected.raw);
      const source = selected.sourceKey === TOKEN_DRAFTS_STORAGE_KEY ? 'workspace' : 'legacy-workspace';
      if (source === 'legacy-workspace') { delete workspace.working.draft.pricingNetwork; for (const item of workspace.saved) delete item.draft.pricingNetwork; }
      return { workspace, snapshot: selected.snapshot, source };
    }
  } catch (error) {
    if (error instanceof TokenDraftStorageError) throw error;
    throw new TokenDraftStorageError('unavailable', 'Browser storage could not be opened. Keep this page open and export your draft before leaving.');
  }
  const workspace = emptyTokenDraftWorkspace();
  if (selected.raw === null) return { workspace, snapshot: selected.snapshot, source: 'empty' };
  try {
    workspace.working.draft = parsedLegacy(selected.raw);
    if (tokenDraftHasContent(workspace.working.draft)) {
      const recovered = makeRecord(workspace.working.draft, clock);
      workspace.saved = [recovered]; workspace.working.savedId = recovered.id;
    }
    return { workspace, snapshot: selected.snapshot, source: 'legacy' };
  } catch { throw new TokenDraftStorageError('unreadable', 'Your previous token draft could not be read. It has not been changed. You can prepare and export a new draft here.'); }
}

/** Compare the exact last-read snapshot before replacing this single atomic storage value. */
export function writeTokenDrafts(storage: TokenDraftStorage, workspace: TokenDraftWorkspace, expectedSnapshot: string | null): string {
  let selected: ReturnType<typeof readDraftStorage>;
  try { selected = readDraftStorage(storage, TOKEN_DRAFTS_STORAGE_KEY, [LEGACY_TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFT_STORAGE_KEY]); }
  catch { throw new TokenDraftStorageError('unavailable', 'Browser storage could not be checked. Your open draft is still here; export a backup before leaving.'); }
  if (selected.raw !== null) selected.sourceKey === LEGACY_TOKEN_DRAFT_STORAGE_KEY ? parsedLegacy(selected.raw) : parsedWorkspace(selected.raw);
  if (selected.snapshot !== expectedSnapshot) throw new TokenDraftStorageError('conflict', 'Your token drafts changed in another tab. Export your open draft, then reload saved drafts before saving here.');
  let serialized: string;
  try {
    serialized = JSON.stringify(clone(workspace));
    if (new TextEncoder().encode(serialized).length > maximumBytes) throw new Error();
  } catch { throw new TokenDraftStorageError('invalid', 'This draft could not be saved. Check its fields and keep an exported backup.'); }
  if (serialized === selected.raw && selected.sourceKey === TOKEN_DRAFTS_STORAGE_KEY) return serialized;
  try { storage.setItem(TOKEN_DRAFTS_STORAGE_KEY, serialized); }
  catch { throw new TokenDraftStorageError('unavailable', 'Browser storage could not save your token drafts. Keep this page open or export a backup.'); }
  return serialized;
}

export function listTokenDrafts(workspace: TokenDraftWorkspace): SavedTokenDraft[] { return clone(workspace).saved; }
export function workingTokenDraft(workspace: TokenDraftWorkspace, draft: TokenDraft, savedId: string | null = workspace.working.savedId): TokenDraftWorkspace {
  return clone({ ...workspace, working: { draft: tokenDraftSchema.parse(draft), savedId } });
}
export function newTokenDraft(workspace: TokenDraftWorkspace, draft: TokenDraft = emptyTokenDraft()): TokenDraftWorkspace { return workingTokenDraft(workspace, draft, null); }
export function saveTokenDraft(workspace: TokenDraftWorkspace, draft: TokenDraft, options: Clock & { id?: string | null } = {}): TokenDraftWorkspace {
  const current = clone(workspace), terms = tokenDraftSchema.parse(draft);
  const id = options.id ?? null;
  const previous = id ? current.saved.find(record => record.id === id) : null;
  if (id && !previous) throw new TokenDraftStorageError('missing', 'That saved token draft is no longer available. Reload saved drafts.');
  if (!previous && current.saved.length >= MAX_SAVED_TOKEN_DRAFTS) throw new TokenDraftStorageError('full', 'You have 20 saved token drafts. Export or remove one before saving another.');
  const record = previous ? savedTokenDraftSchema.parse({ ...previous, draft: terms, savedAt: (options.now || (() => new Date().toISOString()))() }) : makeRecord(terms, options);
  if (!previous && current.saved.some(item => item.id === record.id)) throw new TokenDraftStorageError('invalid', 'A new saved draft could not be created. Your existing drafts have not changed.');
  return clone({ version: 1, working: { draft: terms, savedId: record.id }, saved: [record, ...current.saved.filter(item => item.id !== record.id)] });
}
export function resumeTokenDraft(workspace: TokenDraftWorkspace, id: string): TokenDraftWorkspace {
  // Replacing the working copy remains possible after an incomplete field edit.
  const current = clone({ ...workspace, working: { draft: emptyTokenDraft(), savedId: null } }), selected = current.saved.find(record => record.id === id);
  if (!selected) throw new TokenDraftStorageError('missing', 'That saved token draft is no longer available. Reload saved drafts.');
  return workingTokenDraft(current, selected.draft, id);
}
export function removeTokenDraft(workspace: TokenDraftWorkspace, id: string): TokenDraftWorkspace {
  const current = clone(workspace);
  if (!current.saved.some(record => record.id === id)) throw new TokenDraftStorageError('missing', 'That saved token draft is no longer available. Reload saved drafts.');
  return clone({ ...current, working: { ...current.working, savedId: current.working.savedId === id ? null : current.working.savedId }, saved: current.saved.filter(record => record.id !== id) });
}

/** Read current editor state when flushing, including during navigation/unload. */
export function createTokenDraftAutosave(flush: (notify: boolean) => void, delay = 350) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  return {
    cancel,
    schedule() {
      if (disposed) return;
      cancel();
      timer = setTimeout(() => { timer = null; if (!disposed) flush(true); }, delay);
    },
    flush() { if (!disposed) { cancel(); flush(true); } },
    dispose() {
      if (disposed) return;
      cancel(); disposed = true;
      // Unmount must persist the latest edit without updating an unmounted UI.
      flush(false);
    },
  };
}
