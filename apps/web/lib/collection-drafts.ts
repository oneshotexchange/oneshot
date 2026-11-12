import { z } from 'zod';
import type { LocalCollectionDraft } from './client-oneshot-api';
import { portableCollectionDraftSchema } from './draft-backup';

export const collectionDraftStorageKey = 'oneshot.zero.collectionDrafts.v1';
const storedDraft = portableCollectionDraftSchema.extend({ id: z.string().min(1).max(200), savedAt: z.string().datetime() }).passthrough();
const storedDrafts = z.array(storedDraft).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length);
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readCollectionDrafts(storage: Pick<Storage, 'getItem'>): { items: LocalCollectionDraft[]; snapshot: string | null } {
  try {
    const snapshot = storage.getItem(collectionDraftStorageKey);
    if (snapshot === null) return { items: [], snapshot };
    if (new TextEncoder().encode(snapshot).length > 8 * 1024 * 1024) throw new Error();
    return { items: storedDrafts.parse(JSON.parse(snapshot)), snapshot };
  } catch { throw new Error('Saved collection drafts could not be opened. They have not been changed. Download your open draft before trying again.'); }
}

export function writeCollectionDrafts(storage: DraftStorage, items: LocalCollectionDraft[], snapshot: string | null): string {
  const current = readCollectionDrafts(storage);
  if (current.snapshot !== snapshot) throw new Error('Collection drafts changed in another tab. Download your open draft, then reload saved drafts before saving here.');
  let next: string;
  try { next = JSON.stringify(storedDrafts.parse(items)); }
  catch { throw new Error('This collection draft could not be saved. Check its fields and download a backup.'); }
  try { storage.setItem(collectionDraftStorageKey, next); }
  catch { throw new Error('Browser storage could not save your collection draft. Keep this page open or download a backup.'); }
  return next;
}

export function saveCollectionDraft(items: LocalCollectionDraft[], draft: LocalCollectionDraft): LocalCollectionDraft[] {
  if (items.length >= 20 && !items.some(item => item.id === draft.id)) throw new Error('You have 20 saved collection drafts. Download and remove one before saving another.');
  return [draft, ...items.filter(item => item.id !== draft.id)];
}
