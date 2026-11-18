import { formatIndexedAmount, parseAssetAmount, type IndexedNftItem, type IndexedNftContext, type NftItemDiscoveryTrait, type NftItemDiscoveryFacet, type NftItemDiscoverySummary, type NftItemDiscoveryResponse } from '@oneshot/evm';
import { IndexedPageLoader, IndexedReadError, indexedApi } from './client-indexed-api';
import { readNftNetwork } from './nft-network';
import { indexedPresentation } from './client-indexed-presentation';

export type NftItemTraitFilter = NftItemDiscoveryTrait;
export type NftItemFilters = {
  query: string; availability: 'all' | 'listed' | 'unlisted'; owner: string;
  minPrice: string; maxPrice: string;
  sort: 'serial-asc' | 'serial-desc' | 'price-asc' | 'price-desc'; traits: NftItemTraitFilter[];
};
export type NftCollectionFacet = NftItemDiscoveryFacet;
export type NftCollectionDiscovery = NftItemDiscoverySummary;
export type NftCollectionExploreResponse = NftItemDiscoveryResponse;
export const emptyNftItemFilters = (): NftItemFilters => ({ query: '', availability: 'all', owner: '', minPrice: '', maxPrice: '', sort: 'serial-asc', traits: [] });
const keys = ['q', 'availability', 'owner', 'minPrice', 'maxPrice', 'sort', 'traits'] as const;
const fail = (message = 'Check the item filters, or clear them to browse this collection.') => new IndexedReadError(400, 'NFT_ITEM_FILTER_INVALID', message);
const safeText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const traitText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum;

function price(text: string): string {
  if (!text) return '';
  if (text.length > 100 || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) throw fail('Use a non-negative ETH amount with up to 18 decimal places.');
  try { return formatIndexedAmount(parseAssetAmount(text, 18).toString(), 18); } catch { throw fail('This ETH amount is too large. Enter a smaller amount.'); }
}

export function nftTraitFilterKey(trait: NftItemTraitFilter) { return JSON.stringify([trait.trait_type, trait.value]); }
/** Native trait names may be empty; the select placeholder keeps the separate empty option value. */
export function nftTraitNameOptionValue(name: string) { return JSON.stringify(name); }

function decimalIdentity(text: string) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,4}))?$/.exec(text);
  if (!match) return null;
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, ''), exponent = Number(match[4] || '0') - (match[3]?.length || 0);
  if (!digits) return '0';
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  return `${match[1]}${digits}e${exponent}`;
}

/** Manual input cannot silently round a numeric metadata value into another trait. */
export function nftManualTraitValue(text: string, type: 'string' | 'number'): string | number {
  if (type === 'string') { if (!traitText(text, 200)) throw fail('Use a trait value of up to 200 characters.'); return text; }
  const candidate = text.trim();
  if (!candidate || candidate.length > 100 || decimalIdentity(candidate) === null) throw fail('Enter a JSON number, such as 7, -2.5 or 1e3.');
  const value = Number(candidate);
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value) || decimalIdentity(JSON.stringify(value)) !== decimalIdentity(candidate)) throw fail('This number cannot be entered exactly. Choose it from the collection’s trait values.');
  return Object.is(value, -0) ? 0 : value;
}

/** Applied filters always describe the server result set; prices never pass through Number. */
export function normalizeNftItemFilters(input: NftItemFilters): NftItemFilters {
  if (!safeText(input.query, 100) || !['all', 'listed', 'unlisted'].includes(input.availability)
    || !['serial-asc', 'serial-desc', 'price-asc', 'price-desc'].includes(input.sort) || typeof input.owner !== 'string'
    || typeof input.minPrice !== 'string' || typeof input.maxPrice !== 'string' || !Array.isArray(input.traits) || input.traits.length > 10) throw fail();
  const owner = input.owner.trim().toLowerCase();
  if (owner && (!/^0x[\da-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner))) throw fail('Enter a complete, nonzero Ethereum wallet address, or clear the owner filter.');
  const minPrice = price(input.minPrice.trim()), maxPrice = price(input.maxPrice.trim());
  if (minPrice && maxPrice && parseAssetAmount(minPrice, 18) > parseAssetAmount(maxPrice, 18)) throw fail('The minimum price must not exceed the maximum price.');
  if (input.availability === 'unlisted' && (minPrice || maxPrice || input.sort.startsWith('price-'))) throw fail('Price filters and price sorting apply to NFTs listed for sale. Choose For sale or clear the prices.');
  const traits: NftItemTraitFilter[] = input.traits.map(trait => {
    if (!trait || !traitText(trait.trait_type, 100) || !(traitText(trait.value, 200) || typeof trait.value === 'number' && Number.isFinite(trait.value))) throw fail('Choose valid collection traits, or clear the trait filters.');
    return { trait_type: trait.trait_type, value: Object.is(trait.value, -0) ? 0 : trait.value };
  });
  if (new Set(traits.map(nftTraitFilterKey)).size !== traits.length) throw fail('A trait was selected more than once. Clear the repeated filter.');
  traits.sort((a, b) => nftTraitFilterKey(a) < nftTraitFilterKey(b) ? -1 : nftTraitFilterKey(a) > nftTraitFilterKey(b) ? 1 : 0);
  if (JSON.stringify(traits).length > 3000) throw fail('Select fewer traits and try again.');
  return { query: input.query.trim(), availability: minPrice || maxPrice || input.sort.startsWith('price-') ? 'listed' : input.availability, owner, minPrice, maxPrice, sort: input.sort, traits };
}

export function encodeNftTraitFilters(traits: NftItemTraitFilter[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(traits));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeTraits(encoded: string): NftItemTraitFilter[] {
  try {
    if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw fail();
    const raw = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw, char => char.charCodeAt(0))));
    const normalized = normalizeNftItemFilters({ ...emptyNftItemFilters(), traits: decoded }).traits;
    if (encodeNftTraitFilters(normalized) !== encoded) throw fail();
    return normalized;
  } catch { throw fail('The trait filters in this link could not be read. Clear filters to continue.'); }
}

export function nftItemFiltersFromSearch(search: string): NftItemFilters {
  const params = new URLSearchParams(search), filters = emptyNftItemFilters();
  for (const key of keys) if (params.getAll(key).length > 1) throw fail();
  let traits: NftItemTraitFilter[] = [];
  const encoded = params.get('traits');
  if (encoded) traits = decodeTraits(encoded);
  return normalizeNftItemFilters({ ...filters, query: params.get('q') ?? '', availability: (params.get('availability') ?? 'all') as NftItemFilters['availability'],
    owner: params.get('owner') ?? '', minPrice: params.get('minPrice') ?? '', maxPrice: params.get('maxPrice') ?? '', sort: (params.get('sort') ?? 'serial-asc') as NftItemFilters['sort'], traits });
}

/** Preserve collection authority and unrelated link parameters; old cursor state is always removed. */
export function nftItemFiltersSearch(previous: string, input: NftItemFilters, expectedDeployment?: string): URLSearchParams {
  const filters = normalizeNftItemFilters(input), params = new URLSearchParams(previous);
  if (expectedDeployment !== undefined) {
    if (!/^[a-f\d]{64}$/.test(expectedDeployment)) throw fail('This collection’s network is unavailable. Refresh the collection before sharing item filters.');
    const supplied = params.getAll('deployment');
    if (supplied.length > 1 || supplied.length === 1 && supplied[0] !== expectedDeployment) throw fail('This collection’s network changed. Refresh the collection before changing its filters.');
    if (!supplied.length) params.set('deployment', expectedDeployment);
  }
  for (const key of [...keys, 'cursor']) params.delete(key);
  if (filters.query) params.set('q', filters.query);
  if (filters.availability !== 'all') params.set('availability', filters.availability);
  if (filters.owner) params.set('owner', filters.owner);
  if (filters.minPrice) params.set('minPrice', filters.minPrice);
  if (filters.maxPrice) params.set('maxPrice', filters.maxPrice);
  if (filters.sort !== 'serial-asc') params.set('sort', filters.sort);
  if (filters.traits.length) params.set('traits', encodeNftTraitFilters(filters.traits));
  return params;
}
export function nftCollectionExplorePath(collection: string, filters: NftItemFilters) {
  if (!/^0x[\da-f]{40}$/i.test(collection) || /^0x0{40}$/i.test(collection)) throw fail('Choose a valid collection to browse its NFTs.');
  const params = nftItemFiltersSearch('', filters);
  params.set('limit', '20');
  const path = `/api/oneshot/indexed/collections/${collection.toLowerCase()}/explore?${params}`;
  if (path.length > 4096) throw fail('Select fewer traits or a shorter search and try again.');
  return path;
}
export function nftItemFiltersActive(filters: NftItemFilters) {
  return Boolean(filters.query || filters.availability !== 'all' || filters.owner || filters.minPrice || filters.maxPrice || filters.sort !== 'serial-asc' || filters.traits.length);
}

const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
const raw = (input: unknown): input is string => typeof input === 'string' && /^(0|[1-9]\d{0,77})$/.test(input) && BigInt(input) < 2n ** 256n;
const positive = (input: unknown): input is string => raw(input) && input !== '0';
const evmAddress = (input: unknown): input is string => typeof input === 'string' && /^0x[\da-f]{40}$/i.test(input) && !/^0x0{40}$/i.test(input);
const hash = (input: unknown): input is string => typeof input === 'string' && /^0x[\da-f]{64}$/i.test(input) && !/^0x0{64}$/i.test(input);
// Match the API's bounded serial syntax; longer numeric names remain literal name searches.
const querySerial = (query: string) => /^#?[1-9]\d{0,77}$/.test(query) ? query.replace(/^#/, '') : null;

/** Validate the new endpoint independently; legacy /items responses cannot masquerade as complete filtered results. */
export function validateNftCollectionExplore(value: unknown, expected: { collection: string; deploymentId: string; chainId: number; filters: NftItemFilters; firstPage?: boolean }): NftCollectionExploreResponse {
  const invalid = (): never => { throw new IndexedReadError(502, 'NFT_EXPLORE_INVALID', 'The collection items could not be verified. Refresh items and try again.'); };
  const body = object(value), context = object(body?.context), filters = normalizeNftItemFilters(expected.filters), serial = querySerial(filters.query);
  if (!body || !context || typeof context.enabled !== 'boolean' || typeof context.available !== 'boolean' || context.readonly !== true || context.finalized !== false
    || !evmAddress(body.collection) || body.collection.toLowerCase() !== expected.collection.toLowerCase()
    || !Array.isArray(body.items) || body.items.length > 20 || !(body.nextCursor === null || typeof body.nextCursor === 'string' && body.nextCursor.length > 0 && body.nextCursor.length <= 4096)) return invalid();
  const network = readNftNetwork(context.network);
  if (context.deploymentId !== null && context.deploymentId !== expected.deploymentId || context.network !== null && (!network || network.chainId !== expected.chainId)) {
    throw new IndexedReadError(409, 'NFT_EXPLORE_NETWORK_CHANGED', 'This collection’s network changed. Refresh the collection before browsing its items.');
  }
  if (!context.available) {
    if (body.items.length || body.nextCursor !== null || body.discovery !== null) return invalid();
    return body as unknown as NftCollectionExploreResponse;
  }
  const checkpoint = object(context.checkpoint), discovery = object(body.discovery), metadata = object(discovery?.metadataFilters);
  if (!context.enabled || !/^[a-f\d]{64}$/.test(expected.deploymentId) || context.deploymentId !== expected.deploymentId || !network || !checkpoint
    || !raw(checkpoint.number) || !hash(checkpoint.hash) || !raw(checkpoint.timestamp)
    || !discovery || !raw(discovery.totalItems) || BigInt(discovery.totalItems)>1000n || !raw(discovery.matchingItems) || BigInt(discovery.matchingItems) > BigInt(discovery.totalItems)
    || BigInt(discovery.matchingItems) < BigInt(body.items.length) || !metadata || typeof metadata.available !== 'boolean'
    || !(metadata.reason === null || typeof metadata.reason === 'string') || metadata.available && metadata.reason !== null
    || discovery.facetScope !== 'minted-unburned-collection' || typeof discovery.facetsTruncated !== 'boolean' || !Array.isArray(discovery.facets) || discovery.facets.length > 960
    || body.nextCursor !== null && (!body.items.length || BigInt(discovery.matchingItems) <= BigInt(body.items.length))
    || expected.firstPage !== false && discovery.matchingItems !== '0' && body.items.length === 0
    || expected.firstPage !== false && body.nextCursor===null && discovery.matchingItems!==String(body.items.length)) return invalid();
  if (!metadata.available && (discovery.facets.length || discovery.facetsTruncated || filters.traits.length || filters.query && serial === null)) return invalid();
  const facetKeys = new Set<string>(), facetTypes = new Map<string, number>();
  for (const candidate of discovery.facets) {
    const facet = object(candidate);
    if (!facet || !traitText(facet.trait_type, 100) || !(traitText(facet.value, 200) || typeof facet.value === 'number' && Number.isFinite(facet.value))
      || !positive(facet.count) || BigInt(facet.count) > BigInt(discovery.totalItems)) return invalid();
    const key = nftTraitFilterKey(facet as unknown as NftItemTraitFilter), count = (facetTypes.get(facet.trait_type) || 0) + 1;
    if (facetKeys.has(key) || count > 30) return invalid();
    facetKeys.add(key); facetTypes.set(facet.trait_type, count);
  }
  if (facetTypes.size > 32) return invalid();
  const seen = new Set<string>(); let previous: IndexedNftItem | null = null;
  for (const candidate of body.items) {
    const item = object(candidate), listing = item?.listing === null ? null : object(item?.listing);
    if (!item || !positive(item.tokenId) || !evmAddress(item.collection) || item.collection.toLowerCase() !== expected.collection.toLowerCase()
      || item.id !== `${item.collection.toLowerCase()}:${item.tokenId}` || seen.has(item.tokenId) || item.burned !== false || !evmAddress(item.owner)
      || item.listing !== null && (!listing || !positive(listing.id) || !evmAddress(listing.collection) || listing.collection.toLowerCase() !== expected.collection.toLowerCase()
        || listing.tokenId !== item.tokenId || listing.status !== 'active' || !positive(listing.totalPriceRaw) || !evmAddress(listing.seller))) return invalid();
    if (filters.availability === 'listed' && !listing || filters.availability === 'unlisted' && listing) return invalid();
    if (filters.owner && String(listing?.seller || item.owner).toLowerCase() !== filters.owner) return invalid();
    if (listing && (filters.minPrice && BigInt(String(listing.totalPriceRaw)) < parseAssetAmount(filters.minPrice, 18) || filters.maxPrice && BigInt(String(listing.totalPriceRaw)) > parseAssetAmount(filters.maxPrice, 18))) return invalid();
    if (serial !== null && item.tokenId !== serial) return invalid();
    const presentation=indexedPresentation(item.presentation as IndexedNftItem['presentation'],item.tokenId);
    if(metadata.available&&!presentation)return invalid();
    if(presentation){
      if(filters.query&&serial===null&&!presentation.name.toLowerCase().includes(filters.query.toLowerCase()))return invalid();
      const groups=new Map<string,Set<string>>();
      for(const trait of filters.traits){if(!groups.has(trait.trait_type))groups.set(trait.trait_type,new Set());groups.get(trait.trait_type)!.add(nftTraitFilterKey(trait));}
      const attributes=new Set(presentation.attributes.map(nftTraitFilterKey));
      for(const group of groups.values())if(![...group].some(value=>attributes.has(value)))return invalid();
    }
    const current = item as unknown as IndexedNftItem;
    if (previous) {
      const serialOrder = BigInt(current.tokenId) > BigInt(previous.tokenId) ? 1 : -1;
      if (filters.sort === 'serial-asc' && serialOrder < 0 || filters.sort === 'serial-desc' && serialOrder > 0) return invalid();
      if (filters.sort.startsWith('price-')) {
        if (!previous.listing || !current.listing) return invalid();
        const priceOrder = BigInt(current.listing.totalPriceRaw) - BigInt(previous.listing.totalPriceRaw);
        if (priceOrder === 0n ? serialOrder < 0 : filters.sort === 'price-asc' ? priceOrder < 0n : priceOrder > 0n) return invalid();
      }
    }
    seen.add(item.tokenId); previous = current;
  }
  return body as unknown as NftCollectionExploreResponse;
}

export function sameNftCollectionExploreSnapshot(left: IndexedNftContext, right: IndexedNftContext) {
  return left.deploymentId === right.deploymentId && left.network?.chainId === right.network?.chainId
    && left.checkpoint?.number === right.checkpoint?.number && left.checkpoint?.hash === right.checkpoint?.hash;
}

/** Continuations must add new, ordered results and finish at the verified total. */
export function createNftCollectionExploreLoader(expected:{collection:string;deploymentId:string;chainId:number;filters:NftItemFilters},fetcher= indexedApi){
  let signature:string|null=null,seen=new Set<string>(),last:IndexedNftItem|null=null;
  return new IndexedPageLoader<IndexedNftItem>(item=>item.id,async<T,>(request:string,signal?:AbortSignal):Promise<T>=>{
    const firstPage=!new URL(request,'https://oneshot.invalid').searchParams.has('cursor');
    const value=await fetcher<unknown>(request,signal);
    // A canceled transport can still resolve. It must not replace the active continuation guard.
    signal?.throwIfAborted();
    const response=validateNftCollectionExplore(value,{...expected,firstPage});
    if(firstPage){signature=JSON.stringify(response.discovery);seen=new Set();last=null;}
    else if(signature!==JSON.stringify(response.discovery))throw new IndexedReadError(409,'CURSOR_STALE','Collection items changed. Refresh items to continue.');
    const next=new Set(seen);let previous=last;
    const invalid=():never=>{throw new IndexedReadError(502,'NFT_EXPLORE_INVALID','The next item page could not be verified. Refresh items and try again.');};
    for(const item of response.items){
      if(next.has(item.id))return invalid();
      if(previous){
        const serial=BigInt(item.tokenId)-BigInt(previous.tokenId),sort=expected.filters.sort;
        if(sort==='serial-asc'&&serial<=0n||sort==='serial-desc'&&serial>=0n)return invalid();
        if(sort.startsWith('price-')){
          if(!item.listing||!previous.listing)return invalid();const delta=BigInt(item.listing.totalPriceRaw)-BigInt(previous.listing.totalPriceRaw);
          if(delta===0n?serial<=0n:sort==='price-asc'?delta<0n:delta>0n)return invalid();
        }
      }
      next.add(item.id);previous=item;
    }
    if(response.context.available&&response.discovery&&(BigInt(next.size)>BigInt(response.discovery.matchingItems)||response.nextCursor===null&&String(next.size)!==response.discovery.matchingItems))return invalid();
    seen=next;last=previous;return response as T;
  });
}
