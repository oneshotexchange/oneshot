import { useEffect, useMemo, useState } from 'react';
import { isSupportedNftChainId, type IndexedListing } from '@oneshot/evm';
import type { NftChainId } from './nft-network';

export type NftCartScope = { deploymentId: string; chainId: NftChainId };
export type NftCartItem = Pick<IndexedListing, 'id' | 'collection' | 'tokenId' | 'totalPriceRaw'>;
export type NftCartState = { items: NftCartItem[]; error: string | null };
type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const positive = (value: unknown): value is string => uint(value) && value !== '0';
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const unavailable = 'Your cart could not be saved on this device. Allow browser storage and try again.';
const damaged = 'Your saved cart could not be read. Reset this cart to start a new selection.';
export function nftCartKey(scope: NftCartScope) {
  if (!/^[a-f\d]{64}$/i.test(scope.deploymentId) || !isSupportedNftChainId(scope.chainId)) throw new Error('Choose a supported collection network before adding NFTs.');
  return `oneshot.nft.cart.v1.${scope.chainId}.${scope.deploymentId.toLowerCase()}`;
}
function itemValid(value: unknown): value is NftCartItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as NftCartItem;
  return positive(item.id) && address(item.collection) && positive(item.tokenId) && positive(item.totalPriceRaw);
}
function browserStorage(): CartStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }

/** Local selections are estimates, never authority to spend or evidence a listing remains active. */
export function createNftCartStore(scope: NftCartScope, storage: CartStorage | null = browserStorage()) {
  const key = nftCartKey(scope);
  function read(): NftCartState {
    if (!storage) return { items: [], error: unavailable };
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { return { items: [], error: unavailable }; }
    try {
      if (raw === null) return { items: [], error: null };
      if (raw.length > 32768) return { items: [], error: damaged };
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || value.chainId !== scope.chainId || value.deploymentId !== scope.deploymentId.toLowerCase()
        || !Array.isArray(value.items) || value.items.length > 20 || !value.items.every(itemValid)
        || new Set(value.items.map((item: NftCartItem) => item.id)).size !== value.items.length
        || new Set(value.items.map((item: NftCartItem) => `${item.collection.toLowerCase()}:${item.tokenId}`)).size !== value.items.length) return { items: [], error: damaged };
      return { items: value.items, error: null };
    } catch { return { items: [], error: damaged }; }
  }
  function mutate(change: (items: NftCartItem[]) => NftCartItem[]): NftCartState {
    const current = read();
    if (current.error) return current;
    try {
      const items = change(current.items);
      storage!.setItem(key, JSON.stringify({ version: 1, ...scope, deploymentId: scope.deploymentId.toLowerCase(), items }));
      return { items, error: null };
    } catch (error) { return { items: current.items, error: error instanceof CartSelectionError ? error.message : unavailable }; }
  }
  return {
    key, read,
    add(item: NftCartItem) {
      if (!itemValid(item)) return { ...read(), error: 'This listing could not be added. Refresh the collection and try again.' };
      return mutate(items => {
        const sameNft = items.find(previous => previous.collection.toLowerCase() === item.collection.toLowerCase() && previous.tokenId === item.tokenId);
        if (sameNft && sameNft.id !== item.id) throw new CartSelectionError('This NFT is already in your cart with another listing. Remove it before adding its current listing.');
        if (!items.some(previous => previous.id === item.id) && items.length >= 20) throw new CartSelectionError('Your cart can hold up to 20 NFTs. Remove an NFT to add another.');
        return [...items.filter(previous => previous.id !== item.id), { id: item.id, collection: item.collection.toLowerCase(), tokenId: item.tokenId, totalPriceRaw: item.totalPriceRaw }];
      });
    },
    remove(id: string) { return mutate(items => items.filter(item => item.id !== id)); },
    reset(): NftCartState { try { if (!storage) throw new Error(); storage.removeItem(key); return { items: [], error: null }; } catch { return { ...read(), error: unavailable }; } },
  };
}
class CartSelectionError extends Error {}

export function useNftCart(scope: NftCartScope | null) {
  const store = useMemo(() => scope ? createNftCartStore(scope) : null, [scope?.chainId, scope?.deploymentId]);
  const [state, setState] = useState<NftCartState>({ items: [], error: null });
  useEffect(() => {
    setState(store?.read() ?? { items: [], error: null });
    const refresh = (event: StorageEvent | Event) => { if (!(event instanceof StorageEvent) || event.key === null || event.key === store?.key) setState(store?.read() ?? { items: [], error: null }); };
    window.addEventListener('storage', refresh); window.addEventListener('oneshot-nft-cart', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('oneshot-nft-cart', refresh); };
  }, [store]);
  function update(run: () => NftCartState) { const result = run(); setState(result); if (!result.error) window.dispatchEvent(new Event('oneshot-nft-cart')); }
  return { ...state, add: (item: NftCartItem) => { if (store) update(() => store.add(item)); }, remove: (id: string) => { if (store) update(() => store.remove(id)); }, reset: () => { if (store) update(store.reset); } };
}

export function nftCartHref(scope: NftCartScope) { return `/nfts/cart?deployment=${encodeURIComponent(scope.deploymentId.toLowerCase())}&chain=${scope.chainId}`; }
export function nftCartScopeFromSearch(search: string): NftCartScope | null {
  const params = new URLSearchParams(search), deploymentId = params.get('deployment'), chain = params.get('chain');
  if (params.getAll('deployment').length !== 1 || params.getAll('chain').length !== 1 || !deploymentId || !/^[a-f\d]{64}$/i.test(deploymentId) || chain !== '31337' && chain !== '84532') return null;
  return { deploymentId: deploymentId.toLowerCase(), chainId: Number(chain) as NftChainId };
}
