import type { IndexedTokenContext } from '@oneshot/evm';
import { nftNetworkLabel, readNftNetwork } from '../lib/nft-network';
import { Button, EmptyState } from './ui';

export function TokenMarketContext({ context }: { context: IndexedTokenContext }) {
  if (!context.available) return null;
  return <p className="data-notice token-market-context">{nftNetworkLabel(readNftNetwork(context.network))}. Contract terms at block {context.checkpoint!.number}; recent blocks may change. Opening valuation is a launch term. Review each market for prices, activity and transaction availability.</p>;
}
export function TokenMarketsUnavailable({ onRefresh }: { onRefresh(): void }) {
  return <EmptyState title="Token markets are unavailable" description="You can keep working on a draft and check markets again later." action={<Button variant="secondary" onClick={onRefresh}>Refresh markets</Button>} />;
}
