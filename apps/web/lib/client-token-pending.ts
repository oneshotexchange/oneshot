export const TOKEN_PENDING_STORAGE_KEY = 'oneshot.token.pending.v1';
export type PendingTokenTransaction = { userId: string; from: string; chainId: 31337 | 84532; deploymentId: string; reviewId: string; hash: `0x${string}`; createdAt: string; target: string; action: 'launch' | 'approve' | 'buy' | 'sell' | 'claim' };
type PendingStorage = Pick<Storage, 'getItem' | 'setItem'>;
const retention = 30 * 86_400_000;
function valid(value: unknown, now: number, includeExpired = false): value is PendingTokenTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as PendingTokenTransaction;
  return typeof item.userId === 'string' && item.userId.length > 0 && item.userId.length <= 256
    && /^0x[\da-f]{40}$/.test(item.from) && /^0x[\da-f]{40}$/.test(item.target) && ['launch', 'approve', 'buy', 'sell', 'claim'].includes(item.action) && (item.chainId === 31337 || item.chainId === 84532)
    && /^[\da-f]{64}$/.test(item.deploymentId) && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(item.reviewId)
    && /^0x[\da-f]{64}$/.test(item.hash) && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && Date.parse(item.createdAt) <= now && (includeExpired || now - Date.parse(item.createdAt) < retention);
}
function browserStorage(): PendingStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }

/** Non-secret references only. Unreadable data is preserved, and failed writes are never reported as saved. */
export function createTokenPendingStore(storage: PendingStorage | null = browserStorage(), now: () => number = Date.now) {
  let warning: string | null = null;
  function read(): PendingTokenTransaction[] {
    if (!storage) throw new Error();
    const raw = storage.getItem(TOKEN_PENDING_STORAGE_KEY); if (raw === null) return [];
    if (new TextEncoder().encode(raw).length > 131072) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(item => !valid(item, now(), true))) throw new Error();
    return parsed.filter(item => valid(item, now()));
  }
  function update(change: (items: PendingTokenTransaction[]) => PendingTokenTransaction[]) {
    try {
      const before = storage?.getItem(TOKEN_PENDING_STORAGE_KEY), current = read(), items = change(current);
      if (storage?.getItem(TOKEN_PENDING_STORAGE_KEY) !== before || items.length > 100) throw new Error();
      storage!.setItem(TOKEN_PENDING_STORAGE_KEY, JSON.stringify(items)); warning = null; return true;
    } catch { warning = 'The transaction reference could not be saved on this device. Keep its review ID and transaction hash before leaving.'; return false; }
  }
  return {
    warning: () => warning,
    list(userId: string, from: string, chainId?: number, deploymentId?: string, target?: string) {
      try { const items = read(); warning = null; return items.filter(item => item.userId === userId && item.from === from.toLowerCase() && (chainId === undefined || item.chainId === chainId) && (deploymentId === undefined || item.deploymentId === deploymentId) && (target === undefined || item.target === target.toLowerCase())); }
      catch { warning = 'Saved transaction references could not be opened on this device. You can check a review ID and transaction hash from your wallet.'; return []; }
    },
    remember(item: PendingTokenTransaction) {
      if (!valid(item, now())) { warning = 'The transaction reference could not be saved. Keep its review ID and transaction hash.'; return false; }
      return update(items => [...items.filter(previous => previous.userId !== item.userId || previous.reviewId !== item.reviewId), { ...item }]);
    },
    forget(userId: string, reviewId: string) { return update(items => items.filter(item => item.userId !== userId || item.reviewId !== reviewId)); },
  };
}
