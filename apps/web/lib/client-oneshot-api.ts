import { serviceMessage } from './service-message';
import { oneshotDraftSchema, type OneshotDraft, type OneshotDraftInput } from './oneshot-draft-schema';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { accountWalletProfileSchema, profileWallet, walletProfileDetailsSchema, type AccountWalletProfile, type WalletProfileDetails } from './wallet-profile';
import { walletFollowingSchema, type WalletFollowing } from './wallet-following';
import { tokenAccountDraftId, tokenAccountDraftListSchema, tokenAccountDraftSchema, type TokenAccountDraft } from './token-account-draft';
import { tokenDraftSchema, tokenDraftsEqual, type TokenDraft } from './token-drafts';

export type LocalCollectionDraft = {
  pricingNetwork?: 'zero' | 'base-sepolia';
  id: string; name: string; symbol?: string; description: string; supply: string; royalty: string; price: string; limit: string;
  metadataMode: 'upload' | 'url'; metadataUrl: string; fileNames: string[]; publicStart: string; publicEnd?: string;
  allowlist: boolean; allowlistStart: string; allowlistEnd?: string; allowlistPrice: string; addresses: string; savedAt: string;
};
export type UploadedArt = { url: string; reference?: string; hash: string; size: number };
export type PrivyAccountSession = { userId: string; linkedAddresses: string[]; expiresAt: number };

/** Older browser drafts need creator-supplied launch fields; never invent them while resuming. */
export function normalizeLocalCollectionDraft(draft: LocalCollectionDraft): LocalCollectionDraft {
  return { ...draft, symbol: draft.symbol ?? '', publicEnd: draft.publicEnd ?? '', allowlistEnd: draft.allowlistEnd ?? '' };
}

function scheduleIso(value: string | undefined, label: string): string {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))?$/);
  if (!parts) throw new Error(`Choose a valid ${label} date and time.`);
  const [, year, month, day, hour, minute, second, fraction, offsetHour, offsetMinute] = parts;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1];
  const parsed = new Date(value!);
  if (!days || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59 || Number(offsetHour || 0) > 23 || Number(offsetMinute || 0) > 59 || !Number.isFinite(parsed.getTime())) throw new Error(`Choose a valid ${label} date and time.`);
  // Date only retains milliseconds; carry the original fractional precision through account edits.
  return parsed.toISOString().slice(0, 19) + (fraction || '.000') + 'Z';
}

function metadataName(name: string, serial: number) {
  const suffix = ` #${serial}`; const letters = Array.from(name);
  while (new TextEncoder().encode(letters.join('') + suffix).length > 100) letters.pop();
  return letters.join('') + suffix;
}

export function accountCollectionLocalDraft(record: OneshotDraft): LocalCollectionDraft {
  const localTime = (value?: string) => value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 19) + (value.match(/\.\d+/)?.[0] || '') : '';
  const artNames = record.manifest?.items.map(item => `Saved art: ${item.name}`) || (record.imageUrl ? ['Saved artwork'] : record.snapshot ? ['Saved collection metadata'] : []);
  return {
    ...(record.pricingNetwork !== undefined ? { pricingNetwork: record.pricingNetwork } : {}),
    id: `account:${record.id}`, name: record.name, symbol: record.symbol ?? '', description: record.description,
    supply: String(record.maxSupply), royalty: String(record.royaltyBps / 100), price: record.publicPrice, limit: String(record.perWalletLimit),
    metadataMode: record.metadataMode, metadataUrl: record.metadataUrl || '', fileNames: artNames,
    publicStart: localTime(record.publicStart), publicEnd: localTime(record.publicEnd), allowlist: record.allowlistAddresses.length > 0,
    allowlistStart: localTime(record.allowlistStart), allowlistEnd: localTime(record.allowlistEnd), allowlistPrice: record.allowlistPrice,
    addresses: record.allowlistAddresses.join('\n'), savedAt: record.updatedAt,
  };
}

export function accountCollectionInput(record: OneshotDraft): OneshotDraftInput {
  const { id, ownerUserId, revision, status, createdAt, updatedAt, snapshot, ...fields } = record;
  return oneshotDraftSchema.parse(fields);
}

/** Validate and derive all editable terms before replacing an open working copy. */
export function prepareAccountCollectionEditor(record: OneshotDraft) {
  try {
    if (!record || typeof record.id !== 'string' || !record.id || typeof record.ownerUserId !== 'string' || !record.ownerUserId
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || !['draft', 'prepared'].includes(record.status)
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error();
    const input = accountCollectionInput(record);
    const local = accountCollectionLocalDraft({ ...record, ...input });
    return { input, local };
  } catch { throw new Error('This account draft could not be opened. Refresh your saved drafts and try again. Your current working copy has not changed.'); }
}

/** A decimal text policy is deliberately separate from any native base-unit precision. */
export function collectionAccountInput(draft: LocalCollectionDraft, creatorWallet?: string, uploads: readonly UploadedArt[] = []): OneshotDraftInput {
  const publicStart = scheduleIso(draft.publicStart, 'public mint start');
  const image = (art: UploadedArt) => art.reference || art.url;
  const fields = {
    ...(draft.pricingNetwork !== undefined ? { pricingNetwork: draft.pricingNetwork } : {}),
    name: draft.name, description: draft.description, maxSupply: Number(draft.supply), royaltyBps: Math.round(Number(draft.royalty) * 100),
    ...(draft.symbol !== undefined ? { symbol: draft.symbol } : {}),
    publicPrice: draft.price, allowlistPrice: draft.allowlist ? draft.allowlistPrice : '0', perWalletLimit: Number(draft.limit),
    publicStart, publicEnd: scheduleIso(draft.publicEnd, 'public mint end'),
    ...(draft.allowlist ? { allowlistStart: scheduleIso(draft.allowlistStart, 'allowlist start'), allowlistEnd: scheduleIso(draft.allowlistEnd, 'allowlist end') } : {}),
    allowlistAddresses: draft.allowlist ? [...new Set(draft.addresses.split(/[\s,]+/).filter(Boolean).map(address => address.toLowerCase()))] : [],
    ...(creatorWallet ? { creatorWallet } : {}), metadataMode: draft.metadataMode,
    ...(draft.metadataMode === 'url' ? { metadataUrl: draft.metadataUrl } : {}),
    ...(draft.metadataMode === 'upload' && uploads.length === 1 ? { imageUrl: image(uploads[0]) } : {}),
    ...(draft.metadataMode === 'upload' && uploads.length > 1 ? { manifest: { items: uploads.map((art, index) => ({ name: metadataName(draft.name, index + 1), description: draft.description, image: image(art) })) } } : {}),
  };
  const result = oneshotDraftSchema.safeParse(fields);
  if (!result.success) throw new Error(result.error.issues[0]?.message || 'Check the account draft fields.');
  return result.data;
}

/** Obtain a fresh Privy token per request; never cache one in browser draft storage. */
export function createOneshotAccountApi(options: {
  getAccessToken(): Promise<string | null>;
  identityScope(): string | null;
  fetcher?: typeof fetch;
}) {
  const fetcher = options.fetcher || fetch;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // This helper must never forward a bearer token to an arbitrary destination.
    if (!path.startsWith('/api/oneshot/') || path.includes('\\')) throw new Error('Unsupported account API destination.');
    const scope = options.identityScope();
    if (!scope) throw new Error('Sign in before saving to your account.');
    const token = await options.getAccessToken();
    if (!token) throw new Error('Your session expired. Sign in again.');
    if (options.identityScope() !== scope) throw new Error('Your account or wallet changed. Please try again.');
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
    if (init.body instanceof FormData) headers.delete('Content-Type');
    else if (init.body) headers.set('Content-Type', 'application/json');
    const response = await customerFetch(apiUrl(path), { ...init, headers, credentials: 'omit', redirect: 'error' }, fetcher);
    const body = await customerResponseJson(response, { signal: init.signal });
    if (options.identityScope() !== scope) throw new Error('Your account or wallet changed. Please try again.');
    const error = customerErrorDetails(body);
    if (!response.ok) throw new Error(serviceMessage(error.code, error.message, 'Could not complete this account request. Please try again.'));
    return body as T;
  }
  return {
    async getWalletProfile(walletInput: string) {
      const wallet = profileWallet(walletInput);
      const parsed = accountWalletProfileSchema.safeParse(await request<unknown>(`/api/oneshot/profiles/me?wallet=${wallet}`));
      if (!parsed.success || parsed.data.wallet !== wallet) throw new Error('Your saved profile could not be verified. Try loading it again.');
      return parsed.data;
    },
    async getWalletFollowing() {
      const parsed = walletFollowingSchema.safeParse(await request<unknown>('/api/oneshot/following'));
      if (!parsed.success) throw new Error('Your following list could not be verified. Reload it and try again.');
      return parsed.data;
    },
    async changeWalletFollowing(previous: WalletFollowing, walletInput: string, following: boolean) {
      const selected = walletFollowingSchema.parse(previous), wallet = profileWallet(walletInput), expected = new Set(selected.wallets);
      if (following) expected.add(wallet); else expected.delete(wallet);
      const parsed = walletFollowingSchema.safeParse(await request<unknown>('/api/oneshot/following', { method: 'PUT', body: JSON.stringify({ wallet, following, expectedRevision: selected.revision }) }));
      if (!parsed.success || parsed.data.revision !== selected.revision + 1 || JSON.stringify(parsed.data.wallets) !== JSON.stringify([...expected].sort())) throw new Error('The following change could not be verified. Reload your following list before trying again.');
      return parsed.data;
    },
    async changeWalletProfile(action: 'save' | 'publish' | 'unpublish', previous: AccountWalletProfile, input?: WalletProfileDetails) {
      const selected = accountWalletProfileSchema.parse(previous), profile = action === 'save' ? walletProfileDetailsSchema.parse(input) : null;
      const body = { wallet: selected.wallet, expectedRevision: selected.revision, ...(profile ? { profile } : {}) };
      const result = await request<unknown>(`/api/oneshot/profiles/me${action === 'save' ? '' : '/publish'}`, { method: action === 'save' ? 'PUT' : action === 'publish' ? 'POST' : 'DELETE', body: JSON.stringify(body) });
      const parsed = accountWalletProfileSchema.safeParse(result);
      if (!parsed.success || parsed.data.wallet !== selected.wallet || parsed.data.revision !== selected.revision + 1
        || JSON.stringify(parsed.data.draft) !== JSON.stringify(profile ?? selected.draft)
        || action === 'unpublish' && parsed.data.published !== null
        || action === 'save' && JSON.stringify(parsed.data.published) !== JSON.stringify(selected.published)
        || action === 'publish' && (!parsed.data.published || JSON.stringify(walletProfileDetailsSchema.parse({ displayName: parsed.data.published.displayName, bio: parsed.data.published.bio, website: parsed.data.published.website, avatarPath: parsed.data.published.avatarPath, bannerPath: parsed.data.published.bannerPath })) !== JSON.stringify(selected.draft)))
        throw new Error('The profile change could not be verified. Reload the saved profile before trying again.');
      return parsed.data;
    },
    async listTokenDrafts() {
      const parsed = tokenAccountDraftListSchema.safeParse(await request<unknown>('/api/oneshot/token-drafts'));
      if (!parsed.success) throw new Error('Account drafts could not be loaded. Refresh and try again.');
      return parsed.data;
    },
    async getTokenDraft(id: string) {
      const selected = tokenAccountDraftId.parse(id);
      const parsed = tokenAccountDraftSchema.safeParse(await request<unknown>(`/api/oneshot/token-drafts/${selected}`));
      if (!parsed.success || parsed.data.id !== selected) throw new Error('This account draft could not be opened. Refresh and try again.');
      return parsed.data;
    },
    async saveTokenDraft(draft: TokenDraft, previous?: Pick<TokenAccountDraft, 'id' | 'revision'>) {
      const terms = tokenDraftSchema.parse(draft), id = previous ? tokenAccountDraftId.parse(previous.id) : null;
      const parsed = tokenAccountDraftSchema.safeParse(await request<unknown>(id ? `/api/oneshot/token-drafts/${id}` : '/api/oneshot/token-drafts', {
        method: id ? 'PUT' : 'POST', body: JSON.stringify(previous ? { expectedRevision: previous.revision, draft: terms } : terms),
      }));
      if (!parsed.success || !tokenDraftsEqual(parsed.data.draft, terms) || (id ? parsed.data.id !== id || parsed.data.revision !== previous!.revision + 1 : parsed.data.revision !== 1)) throw new Error('The saved account copy could not be verified. Refresh account drafts before retrying.');
      return parsed.data;
    },
    async archiveTokenDraft(previous: Pick<TokenAccountDraft, 'id' | 'revision'>) {
      const id = tokenAccountDraftId.parse(previous.id);
      const body = await request<unknown>(`/api/oneshot/token-drafts/${id}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: previous.revision }) });
      if (!body || typeof body !== 'object' || !('id' in body) || body.id !== id || !('archived' in body) || body.archived !== true) throw new Error('The archive result could not be verified. Refresh account drafts before retrying.');
      return { id, archived: true as const };
    },
    session: () => request<PrivyAccountSession>('/api/oneshot/session'),
    listDrafts: () => request<{ items: OneshotDraft[] }>('/api/oneshot/drafts'),
    getDraft: (id: string) => {
      if (!/^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) throw new Error('Choose a valid saved account draft.');
      return request<OneshotDraft>(`/api/oneshot/drafts/${id.toLowerCase()}`);
    },
    saveDraft: (draft: OneshotDraftInput, previous?: Pick<OneshotDraft, 'id' | 'revision'>) => request<OneshotDraft>(previous ? `/api/oneshot/drafts/${encodeURIComponent(previous.id)}` : '/api/oneshot/drafts', { method: previous ? 'PUT' : 'POST', body: JSON.stringify(previous ? { expectedRevision: previous.revision, draft } : draft) }),
    archiveDraft: (draft: Pick<OneshotDraft, 'id' | 'revision'>) => request<{ id: string; archived: boolean }>(`/api/oneshot/drafts/${encodeURIComponent(draft.id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision: draft.revision }) }),
    prepareDraft: (draft: Pick<OneshotDraft, 'id' | 'revision'>) => request<OneshotDraft>(`/api/oneshot/drafts/${encodeURIComponent(draft.id)}/prepare`, { method: 'POST', body: JSON.stringify({ expectedRevision: draft.revision }) }),
    uploadArt: (file: File) => { const body = new FormData(); body.append('file', file); return request<UploadedArt>('/api/oneshot/media', { method: 'POST', body }); },
  };
}
