import { randomUUID } from 'node:crypto';
import { tokenDraftSchema } from '../../../web/lib/token-drafts';
import { tokenAccountDraftId, tokenAccountDraftSchema, type TokenAccountDraft } from '../../../web/lib/token-account-draft';
import type { OneshotSession } from './oneshot-auth';
import { compareAndSetRecord, createOwnedRecord, getRecord, listOwnedRecords } from './store';
import { ApiError } from './errors';

const namespace = 'oneshot_token_drafts';
const changed = () => new ApiError(409, 'DRAFT_CHANGED', 'This draft changed elsewhere. Reload account drafts before saving. Your open draft has not changed.');
function stored(value: unknown): TokenAccountDraft {
  const parsed = tokenAccountDraftSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(503, 'TOKEN_DRAFT_UNAVAILABLE', 'This saved draft could not be opened. Refresh account drafts and try again.');
  return parsed.data;
}
export async function createTokenAccountDraft(input: unknown, session: OneshotSession) {
  const now = new Date().toISOString();
  const record = tokenAccountDraftSchema.parse({ id: randomUUID(), ownerUserId: session.userId, revision: 1, status: 'draft', draft: tokenDraftSchema.parse(input), createdAt: now, updatedAt: now });
  await createOwnedRecord(namespace, record.id, session.userId, record);
  return record;
}
export async function listTokenAccountDrafts(session: OneshotSession) {
  return (await listOwnedRecords<unknown>(namespace, session.userId, 20)).map(stored);
}
export async function getTokenAccountDraft(id: string, session: OneshotSession) {
  tokenAccountDraftId.parse(id);
  const record = await getRecord<{ ownerUserId?: unknown; status?: unknown }>(namespace, id);
  if (!record || record.ownerUserId !== session.userId || record.status === 'deleted') throw new ApiError(404, 'DRAFT_NOT_FOUND', 'Saved draft not found.');
  return stored(record);
}
function assertRevision(record: TokenAccountDraft, revision: number) {
  if (!Number.isSafeInteger(revision) || revision !== record.revision || revision >= Number.MAX_SAFE_INTEGER) throw changed();
}
export async function updateTokenAccountDraft(id: string, input: unknown, revision: number, session: OneshotSession) {
  const previous = await getTokenAccountDraft(id, session); assertRevision(previous, revision);
  const draft = tokenDraftSchema.parse(input);
  if ((draft.pricingNetwork ?? 'zero') !== (previous.draft.pricingNetwork ?? 'zero')) throw new ApiError(409, 'DRAFT_PRICING_NETWORK_MISMATCH', 'Save a new account copy for this network and review its valuation.');
  const updated = { ...previous, draft, revision: revision + 1, updatedAt: new Date().toISOString() };
  if (!await compareAndSetRecord(namespace, id, previous, updated)) throw changed();
  return updated;
}
export async function archiveTokenAccountDraft(id: string, revision: number, session: OneshotSession) {
  const previous = await getTokenAccountDraft(id, session); assertRevision(previous, revision);
  if (!await compareAndSetRecord(namespace, id, previous, { ...previous, status: 'deleted', revision: revision + 1, updatedAt: new Date().toISOString() })) throw changed();
  return { id, archived: true as const };
}
