import { z } from 'zod';
import { BASE_SEPOLIA_GENESIS_HASH } from '../../../packages/evm/src/execution-network';

export const reviewedAddress = z.string().regex(/^0x[\da-f]{40}$/).refine(value => !/^0x0{40}$/.test(value)).transform(value => value as `0x${string}`);
export const reviewedAnyAddress = z.string().regex(/^0x[\da-f]{40}$/).transform(value => value as `0x${string}`);
export const reviewedHash = z.string().regex(/^0x[\da-f]{64}$/).refine(value => !/^0x0{64}$/.test(value)).transform(value => value as `0x${string}`);
export const reviewedUint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
export const reviewedPositiveUint = reviewedUint.refine(value => BigInt(value) > 0n);
const index = z.number().int().min(0).max(2_147_483_647);
export const reviewedPosition = z.object({ lastBlockNumber: reviewedUint, lastBlockHash: reviewedHash, lastTransactionHash: reviewedHash, lastLogIndex: index });
const position = reviewedPosition.shape;
export const reviewedCollectionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('reviewed-external-erc721'), address: reviewedAddress,
  reviewVersion: reviewedPositiveUint, runtimeCodeHash: reviewedHash, active: z.boolean(),
  observedFromBlock: reviewedUint, observedFromLogIndex: index, ...position,
}).strict().refine(value => BigInt(value.observedFromBlock) <= BigInt(value.lastBlockNumber));
export type ReviewedCollection = z.infer<typeof reviewedCollectionSchema>;
export const reviewedItemSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('reviewed-external-item'), collection: reviewedAddress, tokenId: reviewedUint,
  owner: reviewedAnyAddress, burned: z.boolean(), activeListingId: reviewedPositiveUint.nullable(), firstObservedBlockNumber: reviewedUint, firstObservedLogIndex: index, ...position,
}).strict().refine(value => value.burned === /^0x0{40}$/.test(value.owner) && BigInt(value.firstObservedBlockNumber) <= BigInt(value.lastBlockNumber));
export type ReviewedItem = z.infer<typeof reviewedItemSchema>;
export const reviewedListingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('reviewed-market-listing'), marketplace: reviewedAddress, listingId: reviewedPositiveUint,
  collection: reviewedAddress, tokenId: reviewedUint, seller: reviewedAddress, totalPriceRaw: reviewedPositiveUint,
  royaltyRecipient: reviewedAnyAddress, royaltyRaw: reviewedUint, reviewVersion: reviewedPositiveUint, runtimeCodeHash: reviewedHash, intentHash: reviewedHash,
  status: z.enum(['active', 'sold', 'cancelled']), buyer: reviewedAddress.nullable(), recipient: reviewedAddress.nullable(),
  platformFeeRaw: reviewedUint.nullable(), sellerProceedsRaw: reviewedUint.nullable(), ...position,
}).strict().superRefine((value, context) => {
  const price = BigInt(value.totalPriceRaw), royalty = BigInt(value.royaltyRaw), sold = value.status === 'sold';
  if (royalty > price / 10n || royalty > 0n && /^0x0{40}$/.test(value.royaltyRecipient)
    || sold !== (value.buyer !== null) || (value.status !== 'active') !== (value.recipient !== null)
    || sold !== (value.platformFeeRaw !== null) || sold !== (value.sellerProceedsRaw !== null)
    || sold && (BigInt(value.platformFeeRaw!) !== price * 200n / 10_000n || BigInt(value.sellerProceedsRaw!) !== price - BigInt(value.platformFeeRaw!) - royalty))
    context.addIssue({ code: 'custom', message: 'Inconsistent reviewed NFT listing.' });
});
export type ReviewedListing = z.infer<typeof reviewedListingSchema>;
export const reviewedClaimSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('reviewed-market-claim'), marketplace: reviewedAddress, account: reviewedAddress,
  pendingRaw: reviewedUint, claimedRaw: reviewedUint, ...position,
}).strict();
export type ReviewedClaim = z.infer<typeof reviewedClaimSchema>;
export const reviewedActivityNames = ['ReviewAdmitted', 'ReviewRevoked', 'Transfer', 'Listed', 'Sold', 'Cancelled', 'Claimed'] as const;
const activityArgs = {
  ReviewAdmitted: z.object({ collection: reviewedAddress, version: reviewedPositiveUint, runtimeCodeHash: reviewedHash, permitHash: reviewedHash, deadline: reviewedUint }).strict(),
  ReviewRevoked: z.object({ collection: reviewedAddress, previousVersion: reviewedPositiveUint, version: reviewedPositiveUint }).strict(),
  Transfer: z.object({ from: reviewedAnyAddress, to: reviewedAnyAddress, tokenId: reviewedUint }).strict(),
  Listed: z.object({ listingId: reviewedPositiveUint, collection: reviewedAddress, tokenId: reviewedUint, seller: reviewedAddress, totalPrice: reviewedPositiveUint, royaltyRecipient: reviewedAnyAddress, royaltyAmount: reviewedUint, reviewVersion: reviewedPositiveUint, runtimeCodeHash: reviewedHash, intentHash: reviewedHash }).strict(),
  Sold: z.object({ listingId: reviewedPositiveUint, buyer: reviewedAddress, recipient: reviewedAddress, totalPrice: reviewedPositiveUint, platformFee: reviewedUint, royaltyRecipient: reviewedAnyAddress, royaltyAmount: reviewedUint, sellerProceeds: reviewedUint }).strict(),
  Cancelled: z.object({ listingId: reviewedPositiveUint, seller: reviewedAddress, recipient: reviewedAddress }).strict(),
  Claimed: z.object({ account: reviewedAddress, recipient: reviewedAddress, amount: reviewedPositiveUint }).strict(),
};
export const reviewedActivitySchema = z.object({
  id: z.string().regex(/^0x[\da-f]{64}:(0|[1-9]\d{0,9})$/), eventName: z.enum(reviewedActivityNames), source: reviewedAddress,
  collection: reviewedAddress.nullable(), transactionHash: reviewedHash, blockNumber: reviewedUint, blockHash: reviewedHash, logIndex: index,
  timestamp: z.string().datetime(), args: z.record(z.string().max(64), z.union([z.string().max(256), z.boolean()])),
}).strict().superRefine((value, context) => {
  if (value.id !== `${value.transactionHash}:${value.logIndex}` || !activityArgs[value.eventName].safeParse(value.args).success
    || 'collection' in value.args && value.args.collection !== value.collection) context.addIssue({ code: 'custom', message: 'Inconsistent reviewed NFT activity.' });
});
export type ReviewedActivity = z.infer<typeof reviewedActivitySchema>;
export const reviewedNetworkSchema = z.object({ mode: z.enum(['local', 'base-sepolia']), chainId: z.union([z.literal(31337), z.literal(84532)]),
  name: z.string().min(1).max(100), nativeSymbol: z.literal('ETH'), nativeDecimals: z.literal(18) }).strict()
  .refine(value => value.mode === 'local' ? value.chainId === 31337 : value.chainId === 84532);
export const reviewedContextSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('reviewed-external-nft-journal'), enabled: z.boolean(), available: z.boolean(), reason: z.string().max(500).nullable(),
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), network: reviewedNetworkSchema.nullable(),
  source: z.object({ genesisHash: reviewedHash, registry: reviewedAddress, marketplace: reviewedAddress }).strict().nullable(),
  checkpoint: z.object({ number: reviewedUint, hash: reviewedHash, timestamp: reviewedUint }).strict().nullable(),
  sync: z.object({ chainHead: reviewedUint, behindBlocks: reviewedUint }).strict().nullable(), readonly: z.literal(true), finalized: z.literal(false),
  coverage: z.object({ mode: z.literal('observed-since-admission'), completeCollection: z.literal(false), includesPreAdmissionHistory: z.literal(false) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.available && (!value.enabled || !value.deploymentId || !value.network || !value.source || !value.checkpoint || value.reason !== null)
    || value.network?.chainId === 84532 && value.source && value.source.genesisHash !== BASE_SEPOLIA_GENESIS_HASH
    || value.sync && value.checkpoint && (BigInt(value.sync.chainHead) < BigInt(value.checkpoint.number) || BigInt(value.sync.behindBlocks) !== BigInt(value.sync.chainHead) - BigInt(value.checkpoint.number)))
    context.addIssue({ code: 'custom', message: 'Inconsistent reviewed NFT checkpoint.' });
});
export type ReviewedNftContext = z.infer<typeof reviewedContextSchema>;
const cursor = z.string().min(1).max(2048).regex(/^[\w-]+$/).nullable();
export const reviewedStatusSchema = z.object({ context: reviewedContextSchema }).strict();
export const reviewedCollectionsPageSchema = z.object({ context: reviewedContextSchema, items: z.array(reviewedCollectionSchema).max(50), nextCursor: cursor }).strict();
export const reviewedCollectionDetailSchema = z.object({ context: reviewedContextSchema, collection: reviewedCollectionSchema.nullable() }).strict();
export const reviewedItemsPageSchema = z.object({ context: reviewedContextSchema, items: z.array(reviewedItemSchema).max(50), nextCursor: cursor }).strict();
export const reviewedItemDetailSchema = z.object({ context: reviewedContextSchema, item: reviewedItemSchema.nullable(), listing: reviewedListingSchema.nullable() }).strict();
export const reviewedListingsPageSchema = z.object({ context: reviewedContextSchema, items: z.array(reviewedListingSchema).max(50), nextCursor: cursor }).strict();
export const reviewedActivityPageSchema = z.object({ context: reviewedContextSchema, items: z.array(reviewedActivitySchema).max(50), nextCursor: cursor }).strict();
export const reviewedClaimsPageSchema = z.object({ context: reviewedContextSchema, items: z.array(reviewedClaimSchema).max(50), nextCursor: cursor }).strict();
