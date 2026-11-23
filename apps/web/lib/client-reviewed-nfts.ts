import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch } from './customer-http';
import { reviewedStatusSchema, reviewedCollectionsPageSchema, reviewedCollectionDetailSchema, reviewedItemsPageSchema, reviewedItemDetailSchema, reviewedListingsPageSchema, reviewedActivityPageSchema, reviewedClaimsPageSchema, type ReviewedNftContext, type ReviewedCollection, type ReviewedItem, type ReviewedListing, type ReviewedActivity, type ReviewedClaim } from './reviewed-nft-data';

const base = '/api/oneshot/reviewed-nfts';
const deployment = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const cursor = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^[\w-]+$/.test(value);
const invalid = () => new ReviewedNftReadError('Reviewed NFT records could not be verified. Refresh and try again.', 'INVALID_RESPONSE', 502);
export class ReviewedNftReadError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) { super(message); this.name = 'ReviewedNftReadError'; }
}
export function assertReviewedNftCheckpoint(actual: ReviewedNftContext, expected: ReviewedNftContext) {
  if (!actual.available || !expected.available || actual.deploymentId !== expected.deploymentId || JSON.stringify(actual.checkpoint) !== JSON.stringify(expected.checkpoint)
    || JSON.stringify(actual.source) !== JSON.stringify(expected.source) || actual.network?.chainId !== expected.network?.chainId)
    throw new ReviewedNftReadError('Collection records changed. Refresh the collection details to continue.', 'CHECKPOINT_CHANGED', 409);
}
export function reviewedNftAddress(value: string) {
  if (!address(value)) throw new ReviewedNftReadError('Enter a complete, nonzero Ethereum collection address.', 'INVALID_INPUT', 400);
  return value.toLowerCase();
}
export function reviewedNftTokenId(value: string) {
  if (!uint(value)) throw new ReviewedNftReadError('Use the NFT’s complete token ID, including 0 when applicable.', 'INVALID_INPUT', 400);
  return value;
}
export function reviewedNftDeployment(search: string): string | null {
  const values = new URLSearchParams(search).getAll('deployment');
  if (!values.length) return null;
  if (values.length !== 1 || !deployment(values[0])) throw new ReviewedNftReadError('This collection link has an invalid network reference. Open a current collection link.', 'INVALID_LINK', 400);
  return values[0];
}
function deploymentQuery(value: string) {
  if (!deployment(value)) throw new ReviewedNftReadError('The collection network could not be verified. Refresh before opening its records.', 'INVALID_LINK');
  return `?deployment=${value}`;
}
export const reviewedNftDiscoveryHref = (deploymentId?: string) => `/nfts/reviewed${deploymentId ? deploymentQuery(deploymentId) : ''}`;
export const reviewedNftCollectionHref = (collection: string, deploymentId: string) => `/nfts/reviewed/${reviewedNftAddress(collection)}${deploymentQuery(deploymentId)}`;
export const reviewedNftItemHref = (collection: string, tokenId: string, deploymentId: string) => `/nfts/reviewed/${reviewedNftAddress(collection)}/${reviewedNftTokenId(tokenId)}${deploymentQuery(deploymentId)}`;

export type ReviewedNftReadSelection =
  | { kind: 'status' }
  | { kind: 'collections' }
  | { kind: 'collection'; collection: string }
  | { kind: 'items'; collection: string }
  | { kind: 'item'; collection: string; tokenId: string }
  | { kind: 'listings'; collection: string; status?: 'active' | 'sold' | 'cancelled' }
  | { kind: 'activity'; collection: string }
  | { kind: 'wallet-items'; wallet: string }
  | { kind: 'wallet-claims'; wallet: string }
  | { kind: 'seller-listings'; seller: string; status?: 'active' | 'sold' | 'cancelled' }
  | { kind: 'global-activity'; wallet?: string };
export const reviewedNftIsPage = (selection: ReviewedNftReadSelection) =>
  ['collections', 'items', 'listings', 'activity', 'wallet-items', 'wallet-claims', 'seller-listings', 'global-activity'].includes(selection.kind);
export function reviewedNftReadPath(selection: ReviewedNftReadSelection, nextCursor?: string) {
  if (nextCursor !== undefined && (!reviewedNftIsPage(selection) || !cursor(nextCursor))) throw new ReviewedNftReadError('Refresh this list from the beginning.', 'INVALID_INPUT', 400);
  let path: string;
  const query = new URLSearchParams();
  if (selection.kind === 'status' || selection.kind === 'collections') path = `${base}/${selection.kind}`;
  else if (selection.kind === 'wallet-items' || selection.kind === 'wallet-claims') {
    const wallet = reviewedNftAddress(selection.wallet);
    path = `${base}/wallets/${wallet}/${selection.kind === 'wallet-items' ? 'items' : 'claims'}`;
  } else if (selection.kind === 'seller-listings') {
    path = `${base}/listings`;
    query.set('seller', reviewedNftAddress(selection.seller));
    const status = selection.status ?? 'active';
    if (!['active', 'sold', 'cancelled'].includes(status)) throw new ReviewedNftReadError('Check the listing selection and refresh.', 'INVALID_INPUT', 400);
    query.set('status', status);
  } else if (selection.kind === 'global-activity') {
    path = `${base}/activity`;
    if (selection.wallet !== undefined) query.set('wallet', reviewedNftAddress(selection.wallet));
  } else {
    const collection = reviewedNftAddress(selection.collection);
    path = selection.kind === 'collection' ? `${base}/collections/${collection}`
      : selection.kind === 'items' ? `${base}/collections/${collection}/items`
        : selection.kind === 'item' ? `${base}/collections/${collection}/items/${reviewedNftTokenId(selection.tokenId)}` : `${base}/${selection.kind}`;
    if (selection.kind === 'listings' || selection.kind === 'activity') query.set('collection', collection);
    if (selection.kind === 'listings') {
      const status = selection.status ?? 'active';
      if (!['active', 'sold', 'cancelled'].includes(status)) throw new ReviewedNftReadError('Check the listing selection and refresh.', 'INVALID_INPUT', 400);
      query.set('status', status);
    }
  }
  if (reviewedNftIsPage(selection)) query.set('limit', '20');
  if (nextCursor) query.set('cursor', nextCursor);
  return path + (query.size ? `?${query}` : '');
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = 2 * 1024 * 1024, length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maximum)) { void response.body?.cancel().catch(() => { }); throw invalid(); }
  const reader = (() => { try { return response.body?.getReader(); } catch { throw invalid(); } })();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let size = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => { }); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (; ;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) { complete = true; break; }
      size += part.value.byteLength; if (size > maximum) throw invalid(); chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { if (!response.ok) return null; throw invalid(); }
  } catch (error) { signal.throwIfAborted(); if (error instanceof ReviewedNftReadError) throw error; throw invalid(); }
  finally { signal.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock(); }
}

/** Every request is public GET-only, bounded and independent of account/metadata providers. */
export async function fetchReviewedNftRead(selection: ReviewedNftReadSelection, expectedDeployment: string | null = null, nextCursor?: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (expectedDeployment !== null && !deployment(expectedDeployment)) throw new ReviewedNftReadError('This collection link has an invalid network reference.', 'INVALID_LINK', 400);
  const path = reviewedNftReadPath(selection, nextCursor), timeout = AbortSignal.timeout(90_000), deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response | undefined;
  try {
    deadline.throwIfAborted();
    response = await customerFetch(apiUrl(path), { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: deadline }, fetcher);
    deadline.throwIfAborted(); const body = await responseJson(response, deadline); deadline.throwIfAborted();
    if (!response.ok) {
      const error = customerErrorDetails(body), code = error.code || 'READ_FAILED';
      throw new ReviewedNftReadError(code === 'CURSOR_STALE' ? 'Recent NFT records changed. Refresh this list from the beginning.'
        : response.status === 404 ? 'This collection or NFT has not been observed here. Check the address and token ID, or explore other collections.'
          : response.status === 409 ? 'NFT records changed after a network update. Refresh this page to continue.' : 'Reviewed NFT records are unavailable. Please try again later.', code, response.status);
    }
    return parseReviewedNftRead(body, selection, expectedDeployment);
  } catch (error) {
    void response?.body?.cancel().catch(() => { }); signal?.throwIfAborted();
    if (deadline.aborted) throw new ReviewedNftReadError('NFT records are taking too long to load. Refresh and try again.', 'READ_TIMEOUT');
    throw error;
  }
}

export function parseReviewedNftRead(raw: unknown, selection: ReviewedNftReadSelection, expectedDeployment: string | null = null) {
  const schema = selection.kind === 'status' ? reviewedStatusSchema
    : selection.kind === 'collections' ? reviewedCollectionsPageSchema
      : selection.kind === 'collection' ? reviewedCollectionDetailSchema
        : selection.kind === 'items' || selection.kind === 'wallet-items' ? reviewedItemsPageSchema
          : selection.kind === 'item' ? reviewedItemDetailSchema
            : selection.kind === 'listings' || selection.kind === 'seller-listings' ? reviewedListingsPageSchema
              : selection.kind === 'wallet-claims' ? reviewedClaimsPageSchema
                : reviewedActivityPageSchema;
  const parsed = schema.safeParse(raw); if (!parsed.success) throw invalid();
  type Entry = ReviewedCollection | ReviewedItem | ReviewedListing | ReviewedActivity | ReviewedClaim;
  // Each envelope was validated with its selection-specific strict schema above.
  const value = parsed.data as { context: ReviewedNftContext; items?: Entry[]; nextCursor?: string | null; collection?: ReviewedCollection | null; item?: ReviewedItem | null; listing?: ReviewedListing | null }, context = value.context;
  if (context.available && context.deploymentId !== expectedDeployment && expectedDeployment !== null) throw invalid();
  const entries: Entry[] = value.items ?? [value.item, value.listing, value.collection].filter((entry): entry is ReviewedCollection | ReviewedItem | ReviewedListing => entry !== null && entry !== undefined);
  if (!context.available && (entries.length || 'nextCursor' in value && value.nextCursor !== null)) throw invalid();
  if (context.available && (selection.kind === 'collection' && !value.collection || selection.kind === 'item' && !value.item)) throw invalid();
  const expectedWallet = selection.kind === 'wallet-items' || selection.kind === 'wallet-claims' || (selection.kind === 'global-activity' && selection.wallet !== undefined)
    ? reviewedNftAddress(selection.wallet!) : selection.kind === 'seller-listings' ? reviewedNftAddress(selection.seller) : null;
  const seen = new Set<string>(); let previous: typeof entries[number] | undefined;
  for (const entry of entries) {
    const at = 'lastBlockNumber' in entry ? entry.lastBlockNumber : entry.blockNumber;
    if (!context.checkpoint || BigInt(at) > BigInt(context.checkpoint.number)) throw invalid();
    const entryCollection = 'address' in entry ? entry.address : 'collection' in entry ? entry.collection : null;
    if ('collection' in selection && entryCollection !== reviewedNftAddress(selection.collection)) throw invalid();
    if ('marketplace' in entry && entry.marketplace !== context.source?.marketplace) throw invalid();
    if ('eventName' in entry && (entry.eventName === 'ReviewAdmitted' || entry.eventName === 'ReviewRevoked' ? entry.source !== context.source?.registry : entry.eventName === 'Transfer' ? entry.source !== entry.collection : entry.source !== context.source?.marketplace)) throw invalid();
    if (selection.kind === 'wallet-items' && 'burned' in entry && (entry.owner !== expectedWallet || entry.burned)) throw invalid();
    if (selection.kind === 'wallet-claims' && 'pendingRaw' in entry && entry.account !== expectedWallet) throw invalid();
    if (selection.kind === 'seller-listings' && 'listingId' in entry && (entry.seller !== expectedWallet || entry.status !== (selection.status ?? 'active'))) throw invalid();
    if (selection.kind === 'global-activity' && expectedWallet && 'eventName' in entry
      && !['seller', 'buyer', 'recipient', 'from', 'to', 'account', 'caller', 'royaltyRecipient'].some(field => entry.args[field] === expectedWallet)) throw invalid();
    const key = 'pendingRaw' in entry ? `claim:${entry.marketplace}:${entry.account}` : 'listingId' in entry ? `listing:${entry.listingId}` : 'tokenId' in entry ? `${entry.collection}:${entry.tokenId}` : 'address' in entry ? entry.address : entry.id;
    if (seen.has(key)) throw invalid(); seen.add(key);
    if (selection.kind === 'item' && 'tokenId' in entry && entry.tokenId !== selection.tokenId) throw invalid();
    if (previous && 'items' in value) {
      if ('pendingRaw' in entry && 'pendingRaw' in previous && previous.marketplace >= entry.marketplace
        || 'listingId' in entry && 'listingId' in previous && BigInt(previous.listingId) <= BigInt(entry.listingId)
        || 'tokenId' in entry && 'tokenId' in previous && (entry.collection < previous.collection || entry.collection === previous.collection && BigInt(previous.tokenId) >= BigInt(entry.tokenId))
        || 'address' in entry && 'address' in previous && previous.address >= entry.address
        || 'blockNumber' in entry && 'blockNumber' in previous && (BigInt(previous.blockNumber) < BigInt(entry.blockNumber) || previous.blockNumber === entry.blockNumber && previous.logIndex <= entry.logIndex)) throw invalid();
    }
    previous = entry;
  }
  if ('nextCursor' in value && value.nextCursor !== null && entries.length === 0) throw invalid();
  if ('item' in value && value.item && value.listing && (value.item.activeListingId !== value.listing.listingId || value.listing.status !== 'active' || value.item.owner !== context.source?.marketplace)) throw invalid();
  if ('item' in value && value.item && value.item.activeListingId !== null && value.listing === null) throw invalid();
  return value;
}
