type ReadStorage = Pick<Storage, 'getItem'>;
const marker = 'oneshot:draft-migration:v1:';

/** An opaque optimistic snapshot also binds the original bytes when first copying an older key. */
export function readDraftStorage(storage: ReadStorage, key: string, legacyKeys: readonly string[]) {
  const current = storage.getItem(key);
  if (current !== null) return { raw: current, snapshot: current, sourceKey: key };
  for (const legacyKey of legacyKeys) {
    const raw = storage.getItem(legacyKey);
    if (raw !== null) return { raw, snapshot: marker + JSON.stringify([legacyKey, raw]), sourceKey: legacyKey };
  }
  return { raw: null, snapshot: null, sourceKey: null };
}

/** Existing storage keys are never renamed, removed, or rewritten by the new editor. */
export function draftStorageUnchanged(storage: ReadStorage, key: string, legacyKeys: readonly string[], snapshot: string | null) {
  return readDraftStorage(storage, key, legacyKeys).snapshot === snapshot;
}
