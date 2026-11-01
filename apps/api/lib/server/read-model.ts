import { formatUnits } from '@b20/sdk';
import { chainFetch, fullnode, graphql, nftPackage, normalizeAddress } from './config';
import { ApiError } from './http';
import { database, getRecord, listRecords } from './store';
import { discoverOwnership, mapOwnership, OWNERSHIP_PAGE_SIZE, OwnershipBudget, readFreshB20Nft } from './ownership';

// Reuse only completed observed snapshots for five seconds, never stale-on-error.
// Transactions always recheck fullnode custody and simulate independently.
type NftPage = { items: any[]; nextCursor: string | null };
const ownershipResponses = new Map<string, { until: number; page: NftPage }>();
const pendingOwnership = new Map<string, Promise<NftPage>>();
const OWNERSHIP_CACHE_TTL_MS = 5000;

export async function contractView(module: string, name: string, args: unknown[]) {
  const address = nftPackage(); if (!address) throw new ApiError(503, 'CONTRACT_NOT_DEPLOYED', 'NFT contracts are awaiting testnet deployment.');
  return chainFetch('/view', { method: 'POST', body: JSON.stringify({ function: `${address}::${module}::${name}`, type_arguments: [], arguments: args }) });
}
export async function collectionIndex() {
  const cached = await listRecords<any>('collections').catch(() => []);
  const db = database();
  if (!db) return cached;
  const { rows } = await db.query('SELECT * FROM b20_collections WHERE chain_id=2 ORDER BY last_transaction_version DESC LIMIT 100');
  const indexed = rows.map(r => {const meta=cached.find(c=>c.id===r.collection_address);return { id: r.collection_address, address: r.collection_address, creator: r.creator_address, name: r.name, maxSupply: Number(r.max_supply), minted: Number(r.minted_supply), royaltyBps: r.royalty_bps, metadataFrozen: Boolean(r.metadata_base_uri), publicPriceApt: formatUnits(BigInt(r.mint_config?.public_price_octas || '0')),imageUrl:meta?.imageUrl,description:meta?.description,manifestHash:meta?.manifestHash };});
  return [...indexed, ...cached.filter(c => !indexed.some(i => i.id === c.id))];
}
export async function collectionDetail(id: string) {
  id = normalizeAddress(id);
  const [view] = await contractView('nft_launch', 'get_collection', [id]);
  const cache = await getRecord('collections', id) || {};
  const link = await getRecord('collection_drafts',id);
  const draft = link ? await getRecord('drafts',link.draftId) : null;
  const { items, nextCursor: itemsNextCursor } = await nftPage(id);
  return {
    ...cache, id, address: id, creator: view.creator, name: view.name, maxSupply: Number(view.max_supply), minted: Number(view.minted), royaltyBps: Number(view.royalty_bps),
    publicPriceApt: formatUnits(BigInt(view.public_price_octas)), allowlistPriceApt: formatUnits(BigInt(view.allowlist_price_octas)),
    publicStart: new Date(Number(view.public_start) * 1000).toISOString(), publicEnd: new Date(Number(view.public_end) * 1000).toISOString(),
    allowlistStart: Number(view.allowlist_end)>0 ? new Date(Number(view.allowlist_start) * 1000).toISOString() : undefined,
    allowlistEndsAt: Number(view.allowlist_end)>0 ? new Date(Number(view.allowlist_end) * 1000).toISOString() : undefined,
    perWalletLimit: Number(view.public_wallet_limit), metadataFrozen: view.opened, status: view.opened ? 'open' : view.configured ? 'configured' : 'created',
    imageUrl: draft?.imageUrl || cache.imageUrl, description: draft?.description || cache.description, items, itemsNextCursor,
  };
}
export async function nftIndex(collection?: string, owner?: string) {
  return (await nftPage(collection, owner)).items;
}

/** Twenty candidates per page; nextCursor advances even across non-B20 assets.
 * Reads have a 6-second / 60-fullnode-call budget and a 5-second observed cache.
 * Current transaction authorization never uses these display snapshots.
 */
export async function nftPage(collection?: string, owner?: string, cursor?: string): Promise<NftPage> {
  if (collection) collection = normalizeAddress(collection);
  if (owner) owner = normalizeAddress(owner);
  if (cursor) cursor = normalizeAddress(cursor);
  const packageAddress = nftPackage();
  // Native APT portfolio reads remain useful before any B20 NFT package exists.
  if (!packageAddress && owner && !collection) return { items: [], nextCursor: null };
  if (!packageAddress) throw new ApiError(503, 'CONTRACT_NOT_DEPLOYED', 'NFT contracts are awaiting testnet deployment.');
  const key = JSON.stringify([packageAddress, fullnode(), graphql(), collection, owner, cursor]);
  const cached = ownershipResponses.get(key);
  if (cached && cached.until > Date.now()) return structuredClone(cached.page);
  ownershipResponses.delete(key);
  let pending = pendingOwnership.get(key);
  if (!pending) {
    if (pendingOwnership.size >= 4) throw new ApiError(503, 'OWNERSHIP_REFRESH_BUSY', 'NFT ownership refresh is busy. Retry shortly.');
    pending = refreshNftPage(collection, owner, cursor, packageAddress).then(page => {
      const now = Date.now();
      for (const [cacheKey, entry] of ownershipResponses) if (entry.until <= now) ownershipResponses.delete(cacheKey);
      if (ownershipResponses.size >= 128) ownershipResponses.delete(ownershipResponses.keys().next().value!);
      ownershipResponses.set(key, { until: now + OWNERSHIP_CACHE_TTL_MS, page });
      return page;
    }).finally(() => { pendingOwnership.delete(key); });
    pendingOwnership.set(key, pending);
  }
  return structuredClone(await pending);
}

async function refreshNftPage(collection: string | undefined, owner: string | undefined, cursor: string | undefined, packageAddress: string): Promise<NftPage> {
  const budget = new OwnershipBudget();
  try {
  const db = database();
  let candidates: any[];
  if (db) {
    const values: unknown[] = []; let where = 'n.chain_id=2';
    if (collection) { values.push(collection); where += ` AND n.collection_address=$${values.length}`; }
    if (owner) { values.push(owner); where += ` AND (n.owner_address=$${values.length} OR l.seller_address=$${values.length})`; }
    if (cursor) { values.push(cursor); where += ` AND n.token_address>$${values.length}`; }
    const { rows } = await db.query(`SELECT DISTINCT n.token_address FROM b20_nfts n LEFT JOIN b20_listings l ON l.chain_id=n.chain_id AND l.token_address=n.token_address AND l.status='active' WHERE ${where} ORDER BY n.token_address ASC LIMIT ${OWNERSHIP_PAGE_SIZE + 1}`, values);
    candidates = rows.map(r => ({ id: r.token_address }));
  } else {
    const all: any[] = await listRecords('nfts');
    candidates = all.filter(n => (!collection || n.collectionId === collection) && (!owner || n.owner === owner || n.seller === owner)).map(n => ({ id: normalizeAddress(n.id) })).filter(n => !cursor || n.id > cursor).sort((a, b) => a.id.localeCompare(b.id)).slice(0, OWNERSHIP_PAGE_SIZE + 1);
  }
  const knownTokens = candidates.map(item => normalizeAddress(item.id));
  // Standard DA transfers emit no B20 events. Hosted ownership discovers incoming
  // tokens, while current ObjectCore custody removes outgoing/stale projections.
  const discovered = await discoverOwnership({ collection, owner, knownTokens, cursor }, budget);
  const candidatesSorted = [...new Set([...knownTokens, ...discovered.map(row => row.token_data_id)])].filter(token => !cursor || token > cursor).sort();
  const tokens = candidatesSorted.slice(0, OWNERSHIP_PAGE_SIZE);
  const refreshed = await mapOwnership(tokens, token => readFreshB20Nft(token, packageAddress, budget), error => budget.fail(error));
  budget.check();
  const items = refreshed.filter(item => item && (!collection || item.collectionId === collection) && (!owner || item.owner === owner || item.seller === owner));
  const observedAt = new Date().toISOString();
  const hydrated = await Promise.all(items.map(item => hydrateItem({ ...item, ownershipObservedAt: observedAt, ownershipCacheMaxAgeSeconds: 5 })));
  budget.check();
  return { items: hydrated, nextCursor: candidatesSorted.length > OWNERSHIP_PAGE_SIZE ? tokens[tokens.length - 1] : null };
  } finally { budget.close(); }
}
async function hydrateItem(item: any) {
  const collection = await getRecord('collections', item.collectionId).catch(() => null);
  const snapshot = collection?.manifestHash ? await getRecord('snapshots', collection.manifestHash) : null;
  const meta = snapshot?.items?.find((i: any) => i.serial === item.serial);
  return { ...item, name: meta?.name || item.name || `${collection?.name || 'NFT'} #${item.serial}`, imageUrl: meta?.image, description: collection?.description };
}
export async function itemDetail(collection: string, token: string) {
  collection = normalizeAddress(collection); token = normalizeAddress(token);
  const resources: any[] = await chainFetch(`/accounts/${token}/resources`);
  const provenance = resources.find(r => r.type === `${nftPackage()}::nft_launch::Provenance`)?.data;
  if (!provenance || normalizeAddress(provenance.collection) !== collection) throw new ApiError(404, 'NOT_B20_NFT', 'This item does not belong to the requested B20 collection.');
  const core = resources.find(r => r.type === '0x1::object::ObjectCore')?.data;
  const listing = await contractView('marketplace', 'is_active', [core.owner]);
  let sale: any;
  if (listing[0]) [sale] = await contractView('marketplace', 'get_listing', [core.owner]);
  const tokenData = resources.find(r => r.type === '0x4::token::Token')?.data;
  return hydrateItem({ id: token, collectionId: collection, serial: Number(provenance.serial), name: tokenData?.name, owner: core.owner, seller: sale?.seller, listingId: sale?.listing, priceApt: sale ? formatUnits(BigInt(sale.price_octas)) : undefined });
}
export async function activityIndex() {
  const db = database();
  if (!db) return listRecords<any>('activity').catch(() => []);
  const { rows } = await db.query('SELECT transaction_version,event_index,event_type,payload,transaction_hash,timestamp_micros FROM b20_chain_events WHERE chain_id=2 ORDER BY transaction_version DESC,event_index DESC LIMIT 100');
  return rows.map(r => ({ id: `${r.transaction_version}:${r.event_index}`, type: r.event_type.split('::').pop(), wallet: r.payload.creator || r.payload.minter || r.payload.buyer || r.payload.seller, collectionId: r.payload.collection, amountApt: r.payload.price_octas ? formatUnits(BigInt(r.payload.price_octas)) : undefined, transactionVersion: r.transaction_version, transactionHash:r.transaction_hash, timestamp:new Date(Number(BigInt(r.timestamp_micros)/1000n)).toISOString() }));
}
