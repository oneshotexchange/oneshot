import { formatIndexedAmount } from '@oneshot/evm';
import { readNftNetwork } from './nft-network';

export type NftCollectionMarketStatsView = {
  activeListings: string;
  lowestListing: string | null;
  completedSales: string;
  resaleVolume: string;
  blockNumber: string;
};

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^(0|[1-9]\d*)$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const deployment = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{64}$/.test(value);

/** Admit only the collection response's own statistics and canonical checkpoint; never infer missing totals from a page. */
export function nftCollectionMarketStats(response: unknown, expectedCollection: string, expectedDeployment?: string): NftCollectionMarketStatsView | null {
  const body = object(response), context = object(body?.context), collection = object(body?.collection);
  const network = object(context?.network), checkpoint = object(context?.checkpoint), stats = object(body?.marketStats);
  if (!address(expectedCollection) || !address(collection?.address) || collection.address.toLowerCase() !== expectedCollection.toLowerCase() || !integer(collection.totalMinted)
    || context?.enabled !== true || context.available !== true || context.readonly !== true || context.finalized !== false
    || !deployment(context.deploymentId) || (expectedDeployment !== undefined && (!deployment(expectedDeployment) || context.deploymentId !== expectedDeployment))
    || !readNftNetwork(network)
    || !integer(checkpoint?.number) || typeof checkpoint.hash !== 'string' || !/^0x[\da-f]{64}$/i.test(checkpoint.hash)
    || !stats || !integer(stats.activeListings) || !integer(stats.completedSales) || !integer(stats.secondaryVolumeRaw)) return null;

  const lowest = stats.lowestListingPriceRaw;
  // oneshot resale contracts reject zero-price listings and sales; free primary mints are separate.
  if (stats.activeListings === '0' ? lowest !== null : !integer(lowest) || lowest === '0') return null;
  if (stats.completedSales === '0' ? stats.secondaryVolumeRaw !== '0' : stats.secondaryVolumeRaw === '0') return null;
  const uint256Limit = 1n << 256n;
  if (BigInt(checkpoint.number) >= uint256Limit || /^0x0{64}$/i.test(checkpoint.hash)) return null;
  if (BigInt(collection.totalMinted) >= uint256Limit || BigInt(stats.activeListings) > BigInt(collection.totalMinted)) return null;
  if (typeof lowest === 'string' && BigInt(lowest) >= uint256Limit) return null;
  if (BigInt(stats.secondaryVolumeRaw) < BigInt(stats.completedSales)) return null;

  return {
    activeListings: stats.activeListings,
    lowestListing: typeof lowest === 'string' ? formatIndexedAmount(lowest, 18) : null,
    completedSales: stats.completedSales,
    resaleVolume: formatIndexedAmount(stats.secondaryVolumeRaw, 18),
    blockNumber: checkpoint.number,
  };
}
