import { formatIndexedAmount } from '@oneshot/evm';
import type { NftLaunchAction, NftLaunchState } from '../lib/client-nft-launch';
import { InfoRow } from './ui';

const labels: Record<string, string> = {
  name: 'Collection name', symbol: 'Symbol', creator: 'Creator wallet', collection: 'Collection',
  factory: 'Collection factory', contract: 'Payout contract', recipient: 'Recipient', seller: 'Seller',
  maxSupply: 'Maximum supply', royaltyBps: 'Creator resale royalty', quantity: 'Quantity',
  tokenId: 'NFT number', listingId: 'Listing number', stage: 'Mint phase',
  publicPriceRaw: 'Public mint price', allowlistPriceRaw: 'Allowlist mint price',
  unitPriceRaw: 'Price per NFT', totalPriceRaw: 'Total price', priceRaw: 'Final listing price',
  enteredPriceRaw: 'Entered listing amount', floorPriceRaw: 'Minimum listing floor', floorRaw: 'Minimum listing floor',
  finalPriceRaw: 'Final listing price', listingPriceRaw: 'Final listing price',
  platformFeeRaw: 'Included platform fee', creatorProceedsRaw: 'Creator proceeds',
  royaltyRaw: 'Included creator royalty', sellerProceedsRaw: 'Seller proceeds', claimAmountRaw: 'Proceeds to claim',
  approvedSpender: 'Approved marketplace', publicStart: 'Public mint starts', publicEnd: 'Public mint ends',
  allowlistStart: 'Allowlist starts', allowlistEnd: 'Allowlist ends',
  floorEnabled: 'Floor protection', enabled: 'Floor protection',
};

export function nftTransactionPhase(phase: NftLaunchState['phase']): string {
  const phases: Record<NftLaunchState['phase'], string> = {
    idle: 'Ready', reviewing: 'Preparing review', review: 'Ready for approval', validating: 'Checking transaction',
    signing: 'Waiting for wallet', submitted: 'Submitted', confirming: 'Confirming', success: 'Confirmed',
    reverted: 'Transaction failed', rejected: 'Approval declined', invalidated: 'New review needed', error: 'Could not complete',
  };
  return phases[phase];
}

export function NftReviewSummary({ summary, action }: { summary: Record<string, string>; action: NftLaunchAction }) {
  const consequences: Record<NftLaunchAction, string> = {
    create: 'Creates your collection. Set mint phases and open minting in separate transactions.',
    configure: 'Sets the mint prices and schedule. Terms become permanent when minting opens.',
    open: 'Permanently locks the collection supply, royalty, mint schedule and metadata.',
    mint: 'Pays the total mint price and sends the NFTs to the recipient shown.',
    approve: 'Allows this marketplace to transfer this NFT. Listing it for sale requires a separate transaction.',
    list: 'Moves this NFT into marketplace escrow until it is sold or the listing is canceled.',
    buy: 'Pays the listed price and sends the NFT to the recipient shown.',
    cancel: 'Returns this NFT to the recipient shown.',
    claim: 'Transfers your available proceeds to the recipient shown.',
    policy: 'Applies to new listings. Existing orders keep their approved prices.',
  };
  function value(key: string, text: string): string {
    if (key.endsWith('Raw') && /^(0|[1-9]\d*)$/.test(text)) return `${formatIndexedAmount(text, 18)} ETH`;
    if (key === 'royaltyBps' && /^\d{1,4}$/.test(text)) return `${Number(text) / 100}%`;
    if (key === 'floorEnabled' || key === 'enabled') return text === 'true' ? 'Enabled' : text === 'false' ? 'Disabled' : text;
    if (key === 'stage') return text === 'allowlist' ? 'Allowlist' : text === 'public' ? 'Public mint' : text;
    if (['publicStart', 'publicEnd', 'allowlistStart', 'allowlistEnd'].includes(key) && Number.isFinite(Date.parse(text))) return new Date(text).toLocaleString();
    return text;
  }
  // Internal commitment hashes remain part of review validation, without crowding the customer summary.
  return <>{Object.entries(summary).filter(([key]) => labels[key]).map(([key, text]) => <InfoRow key={key} label={labels[key]}><span className="indexed-amount">{value(key, text)}</span></InfoRow>)}<p className="field-hint section-gap">{consequences[action]}</p></>;
}

export function NftTransactionData({ data }: { data: string }) {
  return <details className="nft-launch-calldata"><summary>Transaction data</summary><p className="field-hint">Compare this contract call data with the transaction shown in your wallet.</p><pre className="settings-code">{data}</pre></details>;
}
