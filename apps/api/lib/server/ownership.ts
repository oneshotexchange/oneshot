import { formatUnits } from '@b20/sdk';
import { chainFetch, graphql, normalizeAddress } from './config';
import { ApiError } from './http';

export const OWNERSHIP_PAGE_SIZE = 20;

/** Beta bounds: 6 seconds of total refresh work and 60 fullnode requests.
 * Completed read responses may be reused for 5 seconds by read-model.ts. These
 * observed snapshots are never transaction authorization or a stale fallback.
 */
export class OwnershipBudget {
  readonly controller = new AbortController();
  private readonly until: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private calls = 0;
  private failure: unknown;
  constructor(milliseconds = 6000, private readonly maxCalls = 60) {
    this.until = Date.now() + milliseconds;
    this.timer = setTimeout(() => this.fail(this.exceeded()), milliseconds);
    this.timer.unref?.();
  }
  private exceeded() { return new ApiError(503, 'OWNERSHIP_REFRESH_BUDGET', 'This NFT inventory could not be refreshed within the beta request budget. Try an individual collection page or contact B20 support if it persists.'); }
  check() {
    if (this.failure) throw this.failure;
    if (Date.now() >= this.until) { this.fail(this.exceeded()); throw this.failure; }
  }
  reserveFullnodeCall() {
    this.check();
    if (this.calls >= this.maxCalls) { this.fail(this.exceeded()); throw this.failure; }
    this.calls++;
  }
  fail(error: unknown) { if (!this.failure) { this.failure = error; this.controller.abort(error); } }
  close() { clearTimeout(this.timer); }
  get signal() { return this.controller.signal; }
}
const QUERY = `query B20CurrentNftOwnership($where: current_token_ownerships_v2_bool_exp!, $limit: Int!) {
  current_token_ownerships_v2(where: $where, limit: $limit, order_by: {token_data_id: asc}) {
    token_data_id
    owner_address
    amount
    token_standard
    last_transaction_version
    current_token_data { collection_id }
  }
}`;

export type OwnershipRow = {
  token_data_id: string;
  owner_address: string;
  amount: string | number;
  token_standard: string;
  last_transaction_version: string | number;
  current_token_data?: { collection_id: string } | null;
};

/** Discover standard DA transfers; B20 event projections cannot discover them. */
export async function discoverOwnership(input: { collection?: string; owner?: string; knownTokens: string[]; cursor?: string }, budget?: OwnershipBudget): Promise<OwnershipRow[]> {
  const { collection, owner, knownTokens } = input;
  if (!collection && !owner && !knownTokens.length) return [];
  const result: OwnershipRow[] = [];
  let cursor = input.cursor;
  for (;;) {
    budget?.check();
    const conditions: Record<string, unknown>[] = [{ token_standard: { _eq: 'v2' } }, { amount: { _gt: '0' } }];
    if (collection) conditions.push({ current_token_data: { collection_id: { _eq: collection } } });
    if (owner) conditions.push({ owner_address: { _eq: owner } });
    if (!collection && !owner) conditions.push({ token_data_id: { _in: knownTokens } });
    if (cursor) conditions.push({ token_data_id: { _gt: cursor } });
    // One extra candidate proves that another bounded page may be requested.
    const limit = OWNERSHIP_PAGE_SIZE + 1;
    let payload: any;
    try {
      const key = process.env.APTOS_API_KEY || process.env.GEOMI_API_KEY;
      const response = await fetch(graphql(), {
        method: 'POST', cache: 'no-store', signal: budget ? AbortSignal.any([budget.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ query: QUERY, variables: { where: { _and: conditions }, limit } }),
      });
      if (!response.ok) throw new Error('Indexer HTTP failure');
      payload = await response.json();
      if (payload?.errors?.length || !Array.isArray(payload?.data?.current_token_ownerships_v2)) throw new Error('Indexer GraphQL failure');
    } catch {
      budget?.check();
      throw new ApiError(503, 'OWNERSHIP_INDEXER_UNAVAILABLE', 'Current NFT ownership could not be refreshed. Retry shortly; if this persists, check the Aptos indexer URL and server API-key permissions.');
    }
    const rows: OwnershipRow[] = payload.data.current_token_ownerships_v2;
    if (rows.length > limit) throw new ApiError(503, 'INVALID_OWNERSHIP_RESPONSE', 'The Aptos indexer returned an invalid ownership page. Retry shortly.');
    for (const row of rows) {
      try {
        const token = normalizeAddress(row.token_data_id);
        normalizeAddress(row.owner_address);
        if (row.token_standard !== 'v2' || !/^\d+$/.test(String(row.amount)) || BigInt(row.amount) <= 0n || (cursor && token <= cursor)) throw new Error('Invalid ownership row');
        // Use canonical addresses for both deduplication and keyset pagination.
        result.push({ ...row, token_data_id: token, owner_address: normalizeAddress(row.owner_address) });
        cursor = token;
      } catch {
        throw new ApiError(503, 'INVALID_OWNERSHIP_RESPONSE', 'The Aptos indexer returned inconsistent NFT ownership data. Retry after it catches up.');
      }
    }
    return result;
  }
}

function resourceData(resources: any[], packageAddress: string, module: string, name: string) {
  return resources.find(resource => {
    const parts = typeof resource?.type === 'string' ? resource.type.split('::') : [];
    if (parts.length !== 3 || parts[1] !== module || parts[2] !== name) return false;
    try { return normalizeAddress(parts[0]) === packageAddress; } catch { return false; }
  })?.data;
}

export type FreshNft = {
  id: string; collectionId: string; serial: number | string; owner: string;
  name?: string; seller?: string; listingId?: string; priceApt?: string;
  ownershipSource: 'aptos-fullnode';
};

/** Never use a cached mint/sale owner as current custody, including on failure. */
export async function readFreshB20Nft(token: string, packageAddress: string, budget?: OwnershipBudget): Promise<FreshNft | null> {
  let resources: any[];
  try {
    budget?.reserveFullnodeCall();
    resources = await chainFetch(`/accounts/${token}/resources`, budget ? { signal: budget.signal } : undefined);
    budget?.check();
  } catch (error) {
    budget?.check();
    if (error instanceof ApiError && error.status === 404) return null;
    throw new ApiError(503, 'OWNERSHIP_FULLNODE_UNAVAILABLE', 'Current NFT custody could not be verified on Aptos testnet. Retry after the fullnode service recovers.');
  }
  if (!Array.isArray(resources)) throw new ApiError(503, 'INVALID_OWNERSHIP_RESPONSE', 'Aptos testnet returned invalid NFT resources. Retry shortly.');
  const provenance = resourceData(resources, packageAddress, 'nft_launch', 'Provenance');
  // Indexer token/collection names are not proof of B20 origin. A foreign token
  // cannot create a resource defined by the configured immutable B20 module.
  if (!provenance) return null;
  const core = resourceData(resources, normalizeAddress('0x1'), 'object', 'ObjectCore');
  const tokenData = resourceData(resources, normalizeAddress('0x4'), 'token', 'Token');
  if (!core || !tokenData) return null;
  let item: FreshNft;
  try {
    if (!/^\d+$/.test(String(provenance.serial)) || BigInt(provenance.serial) <= 0n) throw new Error('Invalid serial');
    const serial = BigInt(provenance.serial);
    item = {
      id: token, collectionId: normalizeAddress(provenance.collection), owner: normalizeAddress(core.owner),
      serial: serial <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(serial) : serial.toString(),
      name: typeof tokenData.name === 'string' ? tokenData.name : undefined, ownershipSource: 'aptos-fullnode',
    };
  } catch { throw new ApiError(503, 'INVALID_OWNERSHIP_RESPONSE', 'The B20 NFT provenance or custody resource is invalid. Check the configured deployment.'); }

  try {
    const view = async (name: string) => {
      budget?.reserveFullnodeCall();
      const result = await chainFetch('/view', { method: 'POST', ...(budget ? { signal: budget.signal } : {}), body: JSON.stringify({ function: `${packageAddress}::marketplace::${name}`, type_arguments: [], arguments: [item.owner] }) });
      budget?.check();
      return result;
    };
    const active = await view('is_active');
    if (!Array.isArray(active) || typeof active[0] !== 'boolean') throw new Error('Invalid listing status');
    if (active[0]) {
      const [listing] = await view('get_listing');
      if (normalizeAddress(listing.listing) !== item.owner || normalizeAddress(listing.token) !== token || normalizeAddress(listing.collection) !== item.collectionId || !/^\d+$/.test(String(listing.price_octas)) || BigInt(listing.price_octas) <= 0n) throw new Error('Inconsistent escrow listing');
      item.listingId = item.owner;
      item.seller = normalizeAddress(listing.seller);
      item.priceApt = formatUnits(BigInt(listing.price_octas));
    }
    return item;
  } catch {
    budget?.check();
    throw new ApiError(503, 'NFT_LISTING_REFRESH_FAILED', 'Current NFT escrow status could not be verified. Retry after Aptos testnet catches up.');
  }
}

/** Keep public fullnode request concurrency bounded while refreshing a page. */
export async function mapOwnership<T, U>(values: T[], map: (value: T) => Promise<U>, onFailure?: (error: unknown) => void): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  let stopped = false;
  let failure: unknown;
  await Promise.allSettled(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (!stopped && next < values.length) {
      const index = next++;
      try { results[index] = await map(values[index]); }
      catch (error) { if (!stopped) { stopped = true; failure = error; onFailure?.(error); } throw error; }
    }
  }));
  if (stopped) throw failure;
  return results;
}
