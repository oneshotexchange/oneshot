import type { IndexedReceiptSyncState } from '../lib/client-indexed-sync';
import { Button } from './ui';

export function NftIndexedSyncNotice({ state, onRetry }: { state: IndexedReceiptSyncState; onRetry(): void }) {
  if (state.phase === 'idle' || !state.message) return null;
  return <div className="nft-indexed-sync section-gap" role="status" aria-live="polite">
    <p className="data-notice">{state.message}</p>
    {state.canRetry && <Button type="button" variant="secondary" onClick={onRetry}>Refresh activity</Button>}
  </div>;
}
