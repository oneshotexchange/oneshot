import { z } from 'zod';
import { reviewedAddress, reviewedAnyAddress, reviewedHash, reviewedUint, reviewedPositiveUint, reviewedNetworkSchema } from './reviewed-nft-data';

const deployment = z.string().regex(/^[a-f0-9]{64}$/);
const baseInput = { from: reviewedAddress, expectedChainId: z.union([z.literal(31337), z.literal(84532)]), expectedDeploymentId: deployment, testEthAcknowledged: z.literal(true) };
const itemInput = { collection: reviewedAddress, tokenId: reviewedUint };
export const reviewedNftExecutionInputSchema = z.discriminatedUnion('action', [
  z.object({ ...baseInput, ...itemInput, action: z.literal('list'), price: z.string().regex(/^(0|[1-9]\d{0,77})(?:\.\d{1,18})?$/).max(97) }).strict(),
  z.object({ ...baseInput, ...itemInput, action: z.literal('buy'), listingId: reviewedPositiveUint, recipient: reviewedAddress, expectedTotalPriceRaw: reviewedPositiveUint }).strict(),
  z.object({ ...baseInput, ...itemInput, action: z.literal('cancel'), listingId: reviewedPositiveUint, recipient: reviewedAddress }).strict(),
  z.object({ ...baseInput, action: z.literal('claim'), recipient: reviewedAddress }).strict(),
]);
export type ReviewedNftExecutionInput = z.infer<typeof reviewedNftExecutionInputSchema>;
export const reviewedNftListingIntentSchema = z.object({ seller: reviewedAddress, collection: reviewedAddress, tokenId: reviewedUint, totalPrice: reviewedPositiveUint,
  royaltyRecipient: reviewedAnyAddress, royaltyAmount: reviewedUint, reviewVersion: reviewedPositiveUint, nonce: reviewedUint, deadline: reviewedUint,
  chainId: z.union([z.literal(31337), z.literal(84532)]), marketplace: reviewedAddress, deploymentSalt: reviewedHash }).strict();
const trade = { collection: reviewedAddress, tokenId: reviewedUint, seller: reviewedAddress, totalPriceRaw: reviewedPositiveUint,
  platformFeeRaw: reviewedUint, royaltyRecipient: reviewedAnyAddress, royaltyRaw: reviewedUint, sellerProceedsRaw: reviewedUint,
  reviewVersion: reviewedPositiveUint, runtimeCodeHash: reviewedHash };
const reviewBase = { schemaVersion: z.literal(1), kind: z.literal('reviewed-external-nft-execution'), id: z.string().uuid(), reviewHash: deployment,
  deploymentId: deployment, chainId: z.union([z.literal(31337), z.literal(84532)]), network: reviewedNetworkSchema, marketplace: reviewedAddress, registry: reviewedAddress,
  from: reviewedAddress, to: reviewedAddress, data: z.string().regex(/^0x(?:[\da-f]{2})+$/).max(32_770).transform(value => value as `0x${string}`), value: reviewedUint, nonce: reviewedUint,
  expiresAt: z.string().datetime(), simulation: z.object({ blockNumber: reviewedUint, blockHash: reviewedHash, blockTimestamp: reviewedUint, gasEstimate: reviewedPositiveUint }).strict(),
};
export const reviewedNftExecutionReviewSchema = z.discriminatedUnion('action', [
  z.object({ ...reviewBase, action: z.literal('list'), terms: z.object({ ...trade, intent: reviewedNftListingIntentSchema, intentHash: reviewedHash }).strict() }).strict(),
  z.object({ ...reviewBase, action: z.literal('buy'), terms: z.object({ ...trade, listingId: reviewedPositiveUint, recipient: reviewedAddress }).strict() }).strict(),
  z.object({ ...reviewBase, action: z.literal('cancel'), terms: z.object({ collection: reviewedAddress, tokenId: reviewedUint, listingId: reviewedPositiveUint, seller: reviewedAddress, recipient: reviewedAddress }).strict() }).strict(),
  // claimTo sweeps all pending funds. The reviewed amount is an observation,
  // not an onchain minimum/exact-amount condition; the recipient is exact.
  z.object({ ...reviewBase, action: z.literal('claim'), terms: z.object({ account: reviewedAddress, recipient: reviewedAddress, amountRaw: reviewedPositiveUint, allPending: z.literal(true) }).strict() }).strict(),
]).superRefine((value, context) => {
  let valid = value.chainId === value.network.chainId;
  if (value.action === 'list' || value.action === 'buy') {
    const t = value.terms, price = BigInt(t.totalPriceRaw), royalty = BigInt(t.royaltyRaw), fee = price * 200n / 10_000n;
    valid &&= BigInt(t.platformFeeRaw) === fee && BigInt(t.sellerProceedsRaw) === price - fee - royalty && royalty <= price / 10n
      && (royalty === 0n || t.royaltyRecipient !== `0x${'0'.repeat(40)}` && t.royaltyRecipient !== value.marketplace);
    if (value.action === 'list') { const i = value.terms.intent;
      valid &&= value.value === '0' && value.to === t.collection && value.from === t.seller && i.seller === t.seller && i.collection === t.collection && i.tokenId === t.tokenId
        && i.totalPrice === t.totalPriceRaw && i.royaltyAmount === t.royaltyRaw && i.royaltyRecipient === t.royaltyRecipient && i.reviewVersion === t.reviewVersion
        && i.chainId === value.chainId && i.marketplace === value.marketplace;
    } else valid &&= value.to === value.marketplace && value.value === t.totalPriceRaw && value.from !== t.seller && value.terms.recipient !== value.marketplace;
  } else if (value.action === 'cancel') valid &&= value.to === value.marketplace && value.value === '0' && value.terms.seller === value.from && value.terms.recipient !== value.marketplace;
  else valid &&= value.to === value.marketplace && value.value === '0' && value.terms.account === value.from && value.terms.recipient !== value.marketplace;
  if (!valid) context.addIssue({ code: 'custom', message: 'Inconsistent external NFT transaction review.' });
});
export type ReviewedNftExecutionReview = z.infer<typeof reviewedNftExecutionReviewSchema>;
export const reviewedNftExecutionStatusSchema = z.object({ enabled: z.boolean(), reason: z.string().max(500).nullable(), network: reviewedNetworkSchema.nullable(), deploymentId: deployment.nullable(), marketplace: reviewedAddress.nullable(), registry: reviewedAddress.nullable(), capabilities: z.object({ list: z.boolean(), buy: z.boolean(), cancel: z.boolean(), claim: z.boolean() }).strict() }).strict()
  .refine(value => value.enabled ? value.reason === null && !!value.network && !!value.deploymentId && !!value.marketplace && !!value.registry && Object.values(value.capabilities).some(Boolean) : value.network === null && value.deploymentId === null && value.marketplace === null && value.registry === null && Object.values(value.capabilities).every(flag => !flag));
export type ReviewedNftExecutionStatus = z.infer<typeof reviewedNftExecutionStatusSchema>;
export const reviewedNftCanonicalReceiptSchema = z.object({ blockNumber: reviewedUint, blockHash: reviewedHash }).strict();
export const reviewedNftExecutionRecordSchema = z.object({ review: reviewedNftExecutionReviewSchema, transactionHash: reviewedHash.nullable(), outcome: z.enum(['review','submitted','confirmed','reverted']), updatedAt: z.string().datetime(), canonicalReceipt: reviewedNftCanonicalReceiptSchema.nullable() }).strict()
  .refine(value => (value.outcome === 'review') === (value.transactionHash === null) && (value.outcome === 'confirmed' || value.outcome === 'reverted') === (value.canonicalReceipt !== null));
export type ReviewedNftExecutionRecord = z.infer<typeof reviewedNftExecutionRecordSchema>;
export const reviewedNftExecutionHistorySchema = z.object({ items: z.array(reviewedNftExecutionRecordSchema).max(50), nextCursor: z.string().min(1).max(2048).regex(/^[\w-]+$/).nullable() }).strict();
