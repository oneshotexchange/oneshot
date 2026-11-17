import { GUARDED_MARKETPLACE_V3_ABI, parseAssetAmount } from '@oneshot/evm';
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import type { NftLaunchContext, NftLaunchRequest, NftLaunchReview } from './client-nft-launch';
import { readNftMarketplace } from './client-nft-marketplace';

const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const positive = (value: unknown): value is string => uint(value) && value !== '0';
const sameAddress = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' && /^0x[\da-f]{40}$/i.test(left) && left.toLowerCase() === right.toLowerCase();
export const isNftMarketAction = (action: string) => ['offer-create', 'offer-accept', 'offer-cancel', 'offer-expire', 'buy-batch'].includes(action);

/** New funded actions must match both the customer's selection and the exact V3 contract call. */
export function validNftMarketReview(input: NftLaunchRequest, review: NftLaunchReview, context: NftLaunchContext): boolean {
  if (!isNftMarketAction(input.action)) return true;
  try {
    const market = readNftMarketplace(context.marketplace);
    if (!market || market.version !== 3 || !sameAddress(review.to, market.address) || review.scope !== 'public'
      || review.revision !== 0 || !uint(review.value) || (input.action === 'buy-batch' ? !market.batchBuy : !market.fundedOffers)) return false;
    const decoded = decodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, data: review.data as Hex });
    // ABI decoding can otherwise accept appended bytes which were absent from the reviewed arguments.
    if (encodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, functionName: decoded.functionName, args: decoded.args } as Parameters<typeof encodeFunctionData>[0]).toLowerCase() !== review.data.toLowerCase()) return false;
    const args = decoded.args as readonly unknown[], summary = review.summary;
    const recipient = input.recipient?.trim() || input.from;
    if (input.action === 'offer-create') {
      if (decoded.functionName !== 'createOffer' || !input.collection || !positive(input.quantity) || BigInt(input.quantity) > 20n
        || input.tokenId !== undefined && (!positive(input.tokenId) || input.quantity !== '1') || !positive(input.expiresAt)) return false;
      const price = parseAssetAmount(input.price || '', 18), quantity = BigInt(input.quantity), total = price * quantity;
      return price > 0n && total < 2n ** 256n && sameAddress(args[0], input.collection) && args[1] === BigInt(input.tokenId || '0') && args[2] === price
        && args[3] === quantity && sameAddress(args[4], recipient) && args[5] === BigInt(input.expiresAt)
        && review.value === total.toString() && sameAddress(summary.collection, input.collection) && sameAddress(summary.recipient, recipient)
        && summary.unitPriceRaw === price.toString() && summary.quantity === input.quantity && summary.expiresAt === input.expiresAt
        && summary.escrowRaw === total.toString();
    }
    if (input.action === 'buy-batch') {
      const selected = context.expectedListings;
      if (decoded.functionName !== 'buyBatch' || !input.listingIds?.length || input.listingIds.length > 20 || !input.listingIds.every(positive)
        || new Set(input.listingIds).size !== input.listingIds.length || !selected || selected.length !== input.listingIds.length
        || !input.listingIds.every((id, index) => selected[index].id === id && positive(selected[index].totalPriceRaw))
        || !Array.isArray(args[0]) || args[0].length !== input.listingIds.length || !args[0].every((id, index) => id === BigInt(input.listingIds![index]))) return false;
      const total = selected.reduce((sum, item) => sum + BigInt(item.totalPriceRaw), 0n);
      return total < 2n ** 256n && args[1] === total && sameAddress(args[2], recipient) && review.value === total.toString()
        && summary.totalPriceRaw === total.toString() && sameAddress(summary.recipient, recipient) && summary.quantity === String(selected.length);
    }
    if (!positive(input.offerId) || !sameAddress(summary.collection, input.collection) || summary.offerId !== input.offerId || review.value !== '0') return false;
    const expected = context.expectedOffer;
    if (!expected || expected.id !== input.offerId) return false;
    if (input.action === 'offer-cancel' || input.action === 'offer-expire') {
      return decoded.functionName === (input.action === 'offer-cancel' ? 'cancelOffer' : 'releaseExpiredOffer') && args[0] === BigInt(input.offerId)
        && summary.releasedAmountRaw === expected.escrowRaw && sameAddress(summary.claimBeneficiary, expected.bidder);
    }
    return decoded.functionName === 'acceptOffer' && positive(input.tokenId) && args[0] === BigInt(input.offerId) && args[1] === BigInt(input.tokenId)
      && uint(summary.nonce) && args[2] === BigInt(summary.nonce) && typeof summary.policyCommitment === 'string' && /^0x[\da-f]{64}$/i.test(summary.policyCommitment)
      && String(args[3]).toLowerCase() === summary.policyCommitment.toLowerCase() && positive(summary.permitDeadline) && args[4] === BigInt(summary.permitDeadline)
      && typeof args[5] === 'string' && /^0x[\da-f]{130}$/i.test(args[5]) && summary.tokenId === input.tokenId
      && summary.totalPriceRaw === expected.unitPriceRaw && sameAddress(summary.recipient, expected.recipient) && sameAddress(summary.bidder, expected.bidder)
      && positive(summary.totalPriceRaw) && uint(summary.platformFeeRaw) && uint(summary.royaltyRaw) && uint(summary.sellerProceedsRaw)
      && BigInt(summary.platformFeeRaw) === BigInt(summary.totalPriceRaw) * 200n / 10000n
      && BigInt(summary.royaltyRaw) <= BigInt(summary.totalPriceRaw) / 10n
      && BigInt(summary.platformFeeRaw) + BigInt(summary.royaltyRaw) + BigInt(summary.sellerProceedsRaw) === BigInt(summary.totalPriceRaw);
  } catch { return false; }
}
