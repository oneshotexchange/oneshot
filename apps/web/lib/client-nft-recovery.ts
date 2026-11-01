export type PendingNftTransaction = {
  userId: string; from: string; deploymentId: string; reviewId: string; reviewHash: string; hash: string; createdAt: string;
};
export type NftPendingStorage = Pick<Storage,'getItem'|'setItem'>;
const key = 'oneshot.nft.pending.v1';
const address = /^0x[\da-f]{40}$/i, hash = /^0x[\da-f]{64}$/i;
const retention = 30 * 24 * 60 * 60 * 1000;
function valid(value: unknown, now: number): value is PendingNftTransaction {
  if (!value || typeof value !== 'object') return false;
  const item = value as PendingNftTransaction;
  return typeof item.userId === 'string' && item.userId.length > 0 && item.userId.length <= 256
    && address.test(item.from) && typeof item.deploymentId === 'string' && item.deploymentId.length > 0 && item.deploymentId.length <= 256
    && typeof item.reviewId === 'string' && item.reviewId.length > 0 && item.reviewId.length <= 128
    && hash.test(item.reviewHash) && hash.test(item.hash) && typeof item.createdAt === 'string'
    && Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) <= now && now - Date.parse(item.createdAt) < retention;
}
function browserStorage(): NftPendingStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
/** Only non-secret identifiers are kept here. The server rechecks ownership and exact transaction fields. */
export function createNftPendingStore(storage: NftPendingStorage | null = browserStorage(), now: () => number = Date.now) {
  function all(): PendingNftTransaction[] {
    if (!storage) return [];
    try { const raw = storage.getItem(key); if (!raw || raw.length > 262144) return []; const items: unknown = JSON.parse(raw); return Array.isArray(items) ? items.filter(item => valid(item,now())).slice(-100) : []; } catch { return []; }
  }
  function save(items: PendingNftTransaction[]) {
    if (!storage) return false;
    try { storage.setItem(key,JSON.stringify(items.slice(-100))); return true; } catch { return false; }
  }
  return {
    list(userId: string, wallet?: string) { return all().filter(item => item.userId === userId && (!wallet || item.from.toLowerCase() === wallet.toLowerCase())); },
    remember(item: PendingNftTransaction) { if (!valid(item,now())) return false; return save([...all().filter(previous => previous.userId !== item.userId || previous.reviewId !== item.reviewId),{...item,from:item.from.toLowerCase(),hash:item.hash.toLowerCase()}]); },
    forget(userId: string, reviewId: string) { return save(all().filter(item => item.userId !== userId || item.reviewId !== reviewId)); },
  };
}
