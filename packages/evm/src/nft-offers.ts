import { hashTypedData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { GUARDED_MARKETPLACE_ABI, type GuardedMarketContext } from './guarded-market';
import { UINT256_MAX } from './economics';

export type GuardedOfferAcceptancePermit = {
  seller: Address; offerId: bigint; collection: Address; tokenId: bigint; totalPrice: bigint;
  nonce: bigint; policyCommitment: Hex; deadline: bigint; deploymentSalt: Hex;
};
export const GUARDED_OFFER_ACCEPTANCE_TYPES = Object.freeze({ OfferAcceptancePermit: Object.freeze([
  Object.freeze({ name: 'seller', type: 'address' }), Object.freeze({ name: 'offerId', type: 'uint256' }),
  Object.freeze({ name: 'collection', type: 'address' }), Object.freeze({ name: 'tokenId', type: 'uint256' }),
  Object.freeze({ name: 'totalPrice', type: 'uint256' }), Object.freeze({ name: 'nonce', type: 'uint256' }),
  Object.freeze({ name: 'policyCommitment', type: 'bytes32' }), Object.freeze({ name: 'deadline', type: 'uint256' }),
  Object.freeze({ name: 'deploymentSalt', type: 'bytes32' }),
] as const) });
function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || value.toLowerCase() === zeroAddress) throw new TypeError('A nonzero EVM address is required.');
  return value.toLowerCase() as Address;
}
function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[\da-f]{64}$/i.test(value)) throw new TypeError('An exact bytes32 value is required.');
  return value.toLowerCase() as Hex;
}
function uint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > UINT256_MAX) throw new RangeError('Amount is outside uint256.');
  return value;
}
/** Exact seller acceptance authorization; never signs or reveals private policy inputs. */
export function guardedOfferAcceptancePermitTypedData(context: GuardedMarketContext, input: GuardedOfferAcceptancePermit) {
  if (!context || (context.chainId !== 31337 && context.chainId !== 84532)) throw new RangeError('A supported test network is required.');
  if (!input || typeof input !== 'object') throw new TypeError('An offer acceptance permit is required.');
  const domain = Object.freeze({ name: 'OneshotGuardedMarketplace', version: '1', chainId: context.chainId, verifyingContract: address(context.verifyingContract) } as const);
  const message = Object.freeze({ seller: address(input.seller), offerId: uint(input.offerId), collection: address(input.collection), tokenId: uint(input.tokenId),
    totalPrice: uint(input.totalPrice), nonce: uint(input.nonce), policyCommitment: hash(input.policyCommitment), deadline: uint(input.deadline), deploymentSalt: hash(input.deploymentSalt) });
  return Object.freeze({ domain, types: GUARDED_OFFER_ACCEPTANCE_TYPES, primaryType: 'OfferAcceptancePermit', message } as const);
}
export const guardedOfferAcceptancePermitHash = (context: GuardedMarketContext, input: GuardedOfferAcceptancePermit) => hashTypedData(guardedOfferAcceptancePermitTypedData(context, input));

export const GUARDED_MARKETPLACE_V3_ABI = [
  ...GUARDED_MARKETPLACE_ABI.filter(item => item.type !== 'constructor'),
  ...parseAbi([
    'constructor(address factory_, address authority_, bytes32 salt_)',
    'function MARKETPLACE_VERSION() view returns (uint256)',
    'function MAX_BATCH_BUY() view returns (uint256)', 'function MAX_OFFER_QUANTITY() view returns (uint256)',
    'function nextOfferId() view returns (uint256)', 'function totalOfferEscrow() view returns (uint256)',
    'function offerAcceptanceNonces(address) view returns (uint256)',
    'function offers(uint256) view returns (address collection, address bidder, address recipient, uint256 tokenId, uint256 unitPrice, uint256 remaining, uint256 expiry)',
    'function createOffer(address collection, uint256 tokenId, uint256 unitPrice, uint256 quantity, address recipient, uint256 expiry) payable returns (uint256 offerId)',
    'function acceptOffer(uint256 offerId, uint256 tokenId, uint256 nonce, bytes32 expectedPolicyCommitment, uint256 deadline, bytes signature)',
    'function cancelOffer(uint256 offerId)', 'function releaseExpiredOffer(uint256 offerId)',
    'function buyBatch(uint256[] listingIds, uint256 maximumTotalPrice, address recipient) payable',
    'event OfferCreated(uint256 indexed offerId, address indexed collection, address indexed bidder, uint256 tokenId, uint256 unitPrice, uint256 quantity, address recipient, uint256 expiry)',
    'event OfferCancelled(uint256 indexed offerId, address indexed bidder, uint256 quantity, uint256 refund)',
    'event OfferExpired(uint256 indexed offerId, address indexed bidder, address indexed caller, uint256 quantity, uint256 refund)',
    'event OfferAccepted(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address seller, address bidder, address recipient, uint256 totalPrice, uint256 platformFee, uint256 royalty, uint256 sellerProceeds, uint256 replacedListingId)',
    'error CollectionNotOpen()', 'error InvalidOfferQuantity()', 'error InvalidOfferExpiry()', 'error InactiveOffer()',
    'error OfferHasExpired()', 'error OfferNotExpired()', 'error NotBidder()', 'error WrongOfferItem()',
    'error InvalidBatch()', 'error DuplicateListing()', 'error InsolventAccounting()',
  ]),
] as const;
