import type { OneshotDraft } from './oneshot-draft-schema';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
export type NftDraftHandoff = { draftId: string; launchId: string | null };
export function parseNftDraftHandoff(search: string): NftDraftHandoff | null {
  const query = new URLSearchParams(search);
  if (!query.has('draft') && !query.has('launch')) return null;
  const draftId = query.get('draft'), launchId = query.get('launch');
  if (query.getAll('draft').length !== 1 || !draftId || !uuid.test(draftId)
    || query.getAll('launch').length > 1 || query.has('launch') && (!launchId || !uuid.test(launchId))) {
    throw new Error('This collection draft link is invalid. Open a saved draft from your account.');
  }
  return { draftId: draftId.toLowerCase(), launchId: launchId?.toLowerCase() ?? null };
}
export function nftDraftResumeHref(draftId: string, launchId?: string): string | null {
  if (!uuid.test(draftId) || launchId !== undefined && !uuid.test(launchId)) return null;
  const query = new URLSearchParams({ draft: draftId.toLowerCase() });
  if (launchId) query.set('launch', launchId.toLowerCase());
  return `/nfts/new?${query}`;
}
export function nftDeployedCollectionHref(collection: unknown, deploymentId: string): string | null {
  if (typeof collection !== 'string' || !/^0x[\da-f]{40}$/i.test(collection) || !/^[\da-f]{64}$/i.test(deploymentId)) return null;
  return `/nfts/${collection.toLowerCase()}?deployment=${deploymentId.toLowerCase()}`;
}

/** An account read only. Late responses never reopen content after identity changes. */
export function createNftDraftHandoffLoader(options: {
  identity(): { userId: string | null; scope: string | null };
  getDraft(id: string): Promise<OneshotDraft>;
}) {
  let generation = 0;
  return {
    cancel() { generation += 1; },
    async load(id: string): Promise<OneshotDraft | null> {
      if (!uuid.test(id)) throw new Error('Choose a saved collection draft from your account.');
      const ticket = ++generation, identity = options.identity();
      if (!identity.userId || !identity.scope) throw new Error('Sign in to resume this collection draft.');
      const current = () => ticket === generation && options.identity().userId === identity.userId && options.identity().scope === identity.scope;
      let record: OneshotDraft;
      try { record = await options.getDraft(id); }
      catch (error) { if (!current()) return null; throw error; }
      if (!current()) return null;
      if (record.id.toLowerCase() !== id.toLowerCase() || record.ownerUserId !== identity.userId || record.status !== 'prepared' || !record.snapshot) {
        throw new Error('This collection draft is unavailable in your account.');
      }
      return record;
    },
  };
}
