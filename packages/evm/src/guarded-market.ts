import { hashTypedData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { UINT256_MAX } from './economics';
import { NFT_MARKETPLACE_ABI } from './nft-launch';

export type GuardedMarketContext = { chainId: number; verifyingContract: Address };
export type GuardedListingPermit = {
  seller: Address;
  collection: Address;
  tokenId: bigint;
  totalPrice: bigint;
  nonce: bigint;
  policyCommitment: Hex;
  deadline: bigint;
  deploymentSalt: Hex;
};
export type GuardedPolicyPermit = {
  creator: Address;
  collection: Address;
  commitment: Hex;
  expectedCommitment: Hex;
  deadline: bigint;
  deploymentSalt: Hex;
};

export const GUARDED_LISTING_TYPES = Object.freeze({ ListingPermit: Object.freeze([
  Object.freeze({name:'seller',type:'address'}), Object.freeze({name:'collection',type:'address'}),
  Object.freeze({name:'tokenId',type:'uint256'}), Object.freeze({name:'totalPrice',type:'uint256'}),
  Object.freeze({name:'nonce',type:'uint256'}), Object.freeze({name:'policyCommitment',type:'bytes32'}),
  Object.freeze({name:'deadline',type:'uint256'}), Object.freeze({name:'deploymentSalt',type:'bytes32'}),
] as const) });
export const GUARDED_POLICY_TYPES = Object.freeze({ PolicyPermit: Object.freeze([
  Object.freeze({name:'creator',type:'address'}), Object.freeze({name:'collection',type:'address'}),
  Object.freeze({name:'commitment',type:'bytes32'}), Object.freeze({name:'expectedCommitment',type:'bytes32'}),
  Object.freeze({name:'deadline',type:'uint256'}), Object.freeze({name:'deploymentSalt',type:'bytes32'}),
] as const) });

function address(value: unknown, field: string): Address {
  if (typeof value!=='string' || !/^0x[\da-f]{40}$/i.test(value) || value.toLowerCase()===zeroAddress) throw new TypeError(`${field} must be a nonzero EVM address.`);
  return value.toLowerCase() as Address;
}
function bytes32(value: unknown, field: string): Hex {
  if (typeof value!=='string' || !/^0x[\da-f]{64}$/i.test(value)) throw new TypeError(`${field} must be exactly 32 bytes.`);
  return value.toLowerCase() as Hex;
}
function uint(value: unknown, field: string): bigint {
  if (typeof value!=='bigint') throw new TypeError(`${field} must be a bigint.`);
  if (value<0n || value>UINT256_MAX) throw new RangeError(`${field} is outside uint256.`);
  return value;
}
function domain(context: GuardedMarketContext) {
  if (!context || context.chainId!==31337) throw new RangeError('Guarded marketplace permits require local chain 31337.');
  return Object.freeze({name:'OneshotGuardedMarketplace',version:'1',chainId:31337,verifyingContract:address(context.verifyingContract,'Marketplace')} as const);
}

/** A deep-frozen snapshot of the exact local contract authorization; this helper never signs. */
export function guardedListingPermitTypedData(context: GuardedMarketContext, input: GuardedListingPermit) {
  const selected=domain(context);
  if (!input || typeof input!=='object') throw new TypeError('A listing permit is required.');
  const message=Object.freeze({seller:address(input.seller,'Seller'),collection:address(input.collection,'Collection'),
    tokenId:uint(input.tokenId,'Token ID'),totalPrice:uint(input.totalPrice,'Total price'),nonce:uint(input.nonce,'Nonce'),
    policyCommitment:bytes32(input.policyCommitment,'Policy commitment'),deadline:uint(input.deadline,'Deadline'),deploymentSalt:bytes32(input.deploymentSalt,'Deployment salt')});
  return Object.freeze({domain:selected,types:GUARDED_LISTING_TYPES,primaryType:'ListingPermit',message} as const);
}

/** Policy activation is bound to the creator, exact previous commitment and deployment. */
export function guardedPolicyPermitTypedData(context: GuardedMarketContext, input: GuardedPolicyPermit) {
  const selected=domain(context);
  if (!input || typeof input!=='object') throw new TypeError('A policy permit is required.');
  const message=Object.freeze({creator:address(input.creator,'Creator'),collection:address(input.collection,'Collection'),
    commitment:bytes32(input.commitment,'Commitment'),expectedCommitment:bytes32(input.expectedCommitment,'Expected commitment'),
    deadline:uint(input.deadline,'Deadline'),deploymentSalt:bytes32(input.deploymentSalt,'Deployment salt')});
  return Object.freeze({domain:selected,types:GUARDED_POLICY_TYPES,primaryType:'PolicyPermit',message} as const);
}

export const guardedListingPermitHash = (context: GuardedMarketContext, input: GuardedListingPermit) => hashTypedData(guardedListingPermitTypedData(context,input));
export const guardedPolicyPermitHash = (context: GuardedMarketContext, input: GuardedPolicyPermit) => hashTypedData(guardedPolicyPermitTypedData(context,input));

/** V1 escrow and settlement interface, with its unguarded list entry point removed. */
export const GUARDED_MARKETPLACE_ABI = [
  ...NFT_MARKETPLACE_ABI.filter(item=>item.type!=='constructor' && !(item.type==='function' && item.name==='list')),
  ...parseAbi([
    'constructor(address factory_, address listingAuthority_, bytes32 deploymentSalt_)',
    'function listingAuthority() view returns (address)',
    'function deploymentSalt() view returns (bytes32)',
    'function listingNonces(address) view returns (uint256)',
    'function policyCommitment(address) view returns (bytes32)',
    'function listAuthorized(address collection, uint256 tokenId, uint256 totalPrice, uint256 nonce, bytes32 expectedPolicyCommitment, uint256 deadline, bytes signature) returns (uint256 listingId)',
    'function setPolicyCommitment(address collection, bytes32 newCommitment, bytes32 expectedCommitment, uint256 deadline, bytes signature)',
    'event PolicyCommitted(address indexed collection, bytes32 indexed previousCommitment, bytes32 indexed commitment)',
    'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
    'event EIP712DomainChanged()',
    'error LocalChainOnly()', 'error InvalidListingAuthority()', 'error InvalidDeploymentSalt()',
    'error AuthorizationExpired()', 'error InvalidAuthorization()', 'error InvalidNonce()',
    'error PolicyChanged()', 'error InvalidPolicyCommitment()', 'error OnlyCreator()', 'error PolicyAuthorizationUsed()',
    'error InvalidShortString()', 'error StringTooLong(string str)',
  ]),
] as const;
