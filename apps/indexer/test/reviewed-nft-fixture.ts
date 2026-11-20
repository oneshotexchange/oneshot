import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, type Address, type Hex, type AbiEvent } from 'viem';
import { parseReviewedNftManifest } from '../../../packages/evm/src/reviewed-nft';
import type { Block, RawLog } from '../src/types';
import type { ReviewedNftAccounting, ReviewedNftChainSource } from '../src/reviewed-nft-types';
export const rh = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex;
export const ra = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
export const rManifest = parseReviewedNftManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-reviewed-erc721-v1', mode: 'local', chainId: 31337, genesisHash: rh(100), startBlock: '1', anchorHash: rh(100),
  oneshotFactory: { address: ra(9), codeHash: keccak256('0x6009') }, registry: { address: ra(1), codeHash: keccak256('0x6001') }, marketplace: { address: ra(2), codeHash: keccak256('0x6002') }, treasury: ra(3), reviewAuthority: ra(4), registrySalt: rh(55), marketplaceSalt: rh(56) });
// Independent wire declarations, not generated from the implementation ABI.
export const rEvents = parseAbi([
  'event ReviewAdmitted(address indexed collection,uint256 indexed version,bytes32 runtimeCodeHash,bytes32 permitHash,uint256 deadline)',
  'event ReviewRevoked(address indexed collection,uint256 indexed previousVersion,uint256 indexed version)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event Listed(uint256 indexed listingId,address indexed collection,uint256 indexed tokenId,address seller,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,bytes32 runtimeCodeHash,bytes32 intentHash)',
  'event Sold(uint256 indexed listingId,address indexed buyer,address indexed recipient,uint256 totalPrice,uint256 platformFee,address royaltyRecipient,uint256 royaltyAmount,uint256 sellerProceeds)',
  'event Cancelled(uint256 indexed listingId,address indexed seller,address indexed recipient)',
  'event Claimed(address indexed account,address indexed recipient,uint256 amount)',
]);
export const rBlock = (n: number, fork = 0): Block => ({ number: BigInt(n), hash: rh(100 + n + fork * 1000), parentHash: rh(99 + n + (n > 1 ? fork * 1000 : 0)), timestamp: BigInt(1795100000 + n) });
export function rLog(block: Block, source: Address, eventName: string, args: Record<string, unknown>, logIndex: number, transactionIndex = 0): RawLog {
  const def = rEvents.find(value => value.name === eventName) as AbiEvent;
  return { address: source, data: encodeAbiParameters(def.inputs.filter(value => !value.indexed), def.inputs.filter(value => !value.indexed).map(value => args[value.name!])),
    topics: encodeEventTopics({ abi: [def], eventName, args }) as Hex[], blockNumber: block.number, blockHash: block.hash, logIndex, transactionIndex, transactionHash: rh(BigInt(block.hash) + 10000n + BigInt(transactionIndex)) };
}
export const rAdmit = (block: Block, index = 0, collection = ra(10), version = 1n) => rLog(block, rManifest.registry.address, 'ReviewAdmitted', { collection, version, runtimeCodeHash: rh(500), permitHash: rh(501), deadline: block.timestamp + 900n }, index);
export const rTransfer = (block: Block, index: number, from: Address, to: Address, tokenId = 0n, collection = ra(10), transaction = 0) => rLog(block, collection, 'Transfer', { from, to, tokenId }, index, transaction);
export const rListed = (block: Block, index: number, fields: Record<string, unknown> = {}) => rLog(block, rManifest.marketplace.address, 'Listed', { listingId: 1n, collection: ra(10), tokenId: 0n, seller: ra(4), totalPrice: 10000n, royaltyRecipient: ra(5), royaltyAmount: 500n, reviewVersion: 1n, runtimeCodeHash: rh(500), intentHash: rh(502), ...fields }, index);
export const rSold = (block: Block, index: number, fields: Record<string, unknown> = {}) => rLog(block, rManifest.marketplace.address, 'Sold', { listingId: 1n, buyer: ra(6), recipient: ra(7), totalPrice: 10000n, platformFee: 200n, royaltyRecipient: ra(5), royaltyAmount: 500n, sellerProceeds: 9300n, ...fields }, index);
export class ReviewedFixtureSource implements ReviewedNftChainSource {
  blocks = new Map<bigint, Block>([[0n, { number: 0n, hash: rh(100), parentHash: rh(0), timestamp: 1795100000n }]]);
  events = new Map<bigint, RawLog[]>(); states = new Map<bigint, ReviewedNftAccounting>(); reads: Address[][] = [];
  add(block: Block, logs: RawLog[] = [], pending = '0', nextListingId = '1', marketDeployed = true) { this.blocks.set(block.number, block); this.events.set(block.number, logs); this.states.set(block.number, { pending, balance: pending, nextListingId, marketDeployed }); return this; }
  async verify() {} async height() { return [...this.blocks.keys()].reduce((a, b) => a > b ? a : b, 0n); }
  async block(number: bigint) { const value = this.blocks.get(number); if (!value) throw Error('Missing fixture block'); return { ...value }; }
  async logs(block: Block, addresses: readonly Address[]) { this.reads.push([...addresses]); return structuredClone((this.events.get(block.number) ?? []).filter(value => addresses.includes(value.address))); }
  async accounting(_manifest: unknown, block: Block) { return { ...this.states.get(block.number)! }; }
}
