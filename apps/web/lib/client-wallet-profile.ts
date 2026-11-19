import type { IndexedActivity, IndexedCollection, IndexedListing, IndexedNftContext, IndexedNftItem, IndexedPage } from '@oneshot/evm';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { publicWalletProfileResponseSchema, profileWallet, type PublicWalletProfileResponse } from './wallet-profile';
import { readNftNetwork } from './nft-network';

export async function readWalletProfile(walletInput: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<PublicWalletProfileResponse> {
  const wallet = profileWallet(walletInput);
  const response = await customerFetch(apiUrl(`/api/oneshot/profiles/${wallet}`), { credentials: 'omit', cache: 'no-store', redirect: 'error', signal }, fetcher);
  const body = await customerResponseJson(response, { signal });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(customerErrorDetails(body).message || 'Profile details could not be loaded. Please try again.');
  const parsed = publicWalletProfileResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.wallet !== wallet) throw new Error('Profile details could not be verified. Refresh this profile and try again.');
  return parsed.data;
}
export type ProfileTab = 'created' | 'collected' | 'listings' | 'activity';
export function profileAssetPath(walletInput: string, tab: ProfileTab) {
  const wallet = profileWallet(walletInput), base = '/api/oneshot/indexed';
  return tab === 'created' ? `${base}/collections?creator=${wallet}` : tab === 'collected' ? `${base}/wallets/${wallet}/items`
    : tab === 'listings' ? `${base}/listings?seller=${wallet}&status=active` : `${base}/activity?wallet=${wallet}`;
}
type ProfileAsset = IndexedCollection | IndexedNftItem | IndexedListing | IndexedActivity;
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/.test(value);
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A profile page must not attribute another wallet's records to this address. */
export function assertProfileAssetPage<T extends ProfileAsset>(page: IndexedPage<T>, walletInput: string, tab: ProfileTab) {
  const wallet = profileWallet(walletInput), fail = () => { throw new Error('These NFT records could not be verified for this wallet. Refresh and try again.'); };
  const context: IndexedNftContext = page.context;
  if (!context || context.readonly !== true || context.finalized !== false || typeof context.available !== 'boolean' || !Array.isArray(page.items) || page.items.length > 50
    || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 2048)) return fail();
  if (!context.available) { if (page.items.length || page.nextCursor !== null) return fail(); return page; }
  if (!context.deploymentId || !/^[a-f0-9]{64}$/.test(context.deploymentId) || !readNftNetwork(context.network) || !context.checkpoint
    || !uint(context.checkpoint.number) || !/^0x[a-f0-9]{64}$/.test(context.checkpoint.hash) || !uint(context.checkpoint.timestamp)) return fail();
  const ids = new Set<string>();
  for (const input of page.items) {
    if (!object(input)) return fail();
    const item = input as Record<string, unknown>;
    let id: string;
    if (tab === 'created') {
      if (!address(item.address) || item.creator !== wallet || typeof item.name !== 'string' || typeof item.symbol !== 'string' || typeof item.opened !== 'boolean' || !uint(item.totalMinted)) return fail();
      id = item.address;
    } else if (tab === 'collected') {
      if (!address(item.collection) || !uint(item.tokenId) || item.tokenId === '0' || item.id !== `${item.collection}:${item.tokenId}` || item.owner !== wallet || item.burned !== false
        || item.listing !== null && (!object(item.listing) || item.listing.collection !== item.collection || item.listing.tokenId !== item.tokenId || item.listing.status !== 'active' || !uint(item.listing.totalPriceRaw))) return fail();
      id = String(item.id);
    } else if (tab === 'listings') {
      if (!address(item.collection) || !uint(item.id) || !uint(item.tokenId) || item.id === '0' || item.tokenId === '0' || item.seller !== wallet || item.status !== 'active' || !uint(item.totalPriceRaw) || item.totalPriceRaw === '0') return fail();
      id = item.id;
    } else {
      if (typeof item.id !== 'string' || !item.id || typeof item.eventName !== 'string' || !address(item.source) || !uint(item.blockNumber)
        || BigInt(item.blockNumber) > BigInt(context.checkpoint.number)
        || typeof item.transactionHash !== 'string' || !/^0x[a-f0-9]{64}$/.test(item.transactionHash) || !Number.isSafeInteger(item.logIndex) || Number(item.logIndex) < 0 || Number(item.logIndex) > 2_147_483_647
        || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) || !object(item.args)
        || !Object.entries(item.args).some(([key, value]) => ['creator','payer','recipient','from','to','account','owner','approved','operator','buyer','seller','bidder','caller'].includes(key) && value === wallet)) return fail();
      id = item.id;
    }
    if (ids.has(id)) return fail(); ids.add(id);
  }
  return page;
}
