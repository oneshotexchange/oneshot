import { describe, expect, it } from 'vitest';
import { createNftCartStore, nftCartHref, nftCartKey, nftCartScopeFromSearch } from './client-nft-cart';

const scope = { deploymentId: 'a'.repeat(64), chainId: 84532 as const };
const item = (id = '1') => ({ id, collection: `0x${'1'.repeat(40)}`, tokenId: id, totalPriceRaw: '100000000000000001' });
function storage() { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; }

describe('deployment-scoped NFT cart', () => {
  it('keeps exact big integer amounts, deduplicates listings and preserves another tab selection', () => {
    const memory = storage(), first = createNftCartStore(scope, memory), second = createNftCartStore(scope, memory);
    first.add(item()); second.add(item('2'));
    expect(first.add(item()).items).toHaveLength(2);
    expect(first.read().items[1].totalPriceRaw).toBe('100000000000000001');
    expect(second.remove('1').items.map(value => value.id)).toEqual(['2']);
  });
  it('never combines deployments or chains', () => {
    const memory = storage(); createNftCartStore(scope, memory).add(item());
    expect(createNftCartStore({ ...scope, chainId: 31337 }, memory).read().items).toEqual([]);
    expect(createNftCartStore({ ...scope, deploymentId: 'b'.repeat(64) }, memory).read().items).toEqual([]);
    expect(() => nftCartKey({ ...scope, chainId: 1 as 84532 })).toThrow();
  });
  it('limits selection to 20 distinct listings/NFTs without discarding existing entries', () => {
    const store = createNftCartStore(scope, storage());
    for (let i = 1; i <= 20; i++) store.add(item(String(i)));
    const full = store.add(item('21')); expect(full.error).toContain('20'); expect(full.items).toHaveLength(20);
    const duplicate = store.add({ ...item('21'), tokenId: '1' }); expect(duplicate.error).toContain('another listing'); expect(duplicate.items).toHaveLength(20);
  });
  it.each(['{', '{}', '[]', JSON.stringify({ version: 1, ...scope, items: [item(), item()] }), JSON.stringify({ version: 1, ...scope, items: [{ ...item(), totalPriceRaw: '0' }] }), JSON.stringify({ version: 1, ...scope, items: [{ ...item(), tokenId: '-1' }] })])('preserves unreadable/invalid bytes until explicit reset: %s', raw => {
    const memory = storage(), key = nftCartKey(scope); memory.setItem(key, raw); const store = createNftCartStore(scope, memory);
    expect(store.add(item()).error).toContain('Reset'); expect(memory.getItem(key)).toBe(raw);
    expect(store.remove('1').error).toContain('Reset'); expect(memory.getItem(key)).toBe(raw);
    expect(store.reset()).toEqual({ items: [], error: null }); expect(store.add(item()).items).toEqual([item()]);
  });
  it('does not report a successful save for unavailable or rejected storage', () => {
    expect(createNftCartStore(scope, null).add(item()).error).toContain('could not be saved');
    const memory = storage(); const store = createNftCartStore(scope, { ...memory, setItem: () => { throw new Error('private storage detail'); } });
    const failed = store.add(item()); expect(failed.items).toEqual([]); expect(failed.error).not.toContain('private');
    const denied = createNftCartStore(scope, { ...memory, getItem: () => { throw new Error('private'); } });
    expect(denied.read().error).toContain('Allow browser storage');
  });
  it('rejects invalid amounts/addresses and copied state in a different scope', () => {
    const memory = storage(), store = createNftCartStore(scope, memory);
    expect(store.add({ ...item(), totalPriceRaw: (2n ** 256n).toString() }).error).toBeTruthy();
    expect(store.add({ ...item(), collection: `0x${'0'.repeat(40)}` }).error).toBeTruthy();
    memory.setItem(nftCartKey(scope), JSON.stringify({ version: 1, ...scope, chainId: 31337, items: [item()] }));
    expect(store.read().error).toBeTruthy();
  });
  it('round trips explicit cart URLs and rejects absent, duplicate, mainnet or malformed scope', () => {
    expect(nftCartScopeFromSearch(nftCartHref(scope).split('?')[1])).toEqual(scope);
    for (const search of ['', `deployment=${scope.deploymentId}`, `deployment=${scope.deploymentId}&chain=8453`, `deployment=${scope.deploymentId}&chain=84532&chain=31337`, `deployment=broken&chain=84532`]) expect(nftCartScopeFromSearch(search)).toBeNull();
  });
});
