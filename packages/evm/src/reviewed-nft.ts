import {
  decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256,
  parseAbi, sha256, stringToHex, zeroAddress, zeroHash,
  type Abi, type Address, type Hex,
} from 'viem';
import { BASE_SEPOLIA_GENESIS_HASH, nftExecutionNetwork } from './execution-network';
import type { RpcReadMethod, RpcVerification } from './rpc';
import { REVIEWED_NFT_MARKETPLACE_ABI, REVIEWED_NFT_REGISTRY_ABI } from './reviewed-nft-abi';

export { REVIEWED_NFT_MARKETPLACE_ABI, REVIEWED_NFT_REGISTRY_ABI } from './reviewed-nft-abi';

export type ReviewedNftContractIdentity = { address: Address; codeHash: Hex };
type ReviewedNftIdentity = { mode: 'local'; chainId: 31337 } | { mode: 'base-sepolia'; chainId: 84532 };
/** Independent of the dense, factory-created native NFT deployment manifest. */
export type ReviewedNftManifest = ReviewedNftIdentity & {
  schemaVersion: 1;
  deploymentVersion: 'oneshot-reviewed-erc721-v1';
  genesisHash: Hex;
  startBlock: bigint;
  anchorHash: Hex;
  oneshotFactory: ReviewedNftContractIdentity;
  registry: ReviewedNftContractIdentity;
  marketplace: ReviewedNftContractIdentity;
  treasury: Address;
  reviewAuthority: Address;
  registrySalt: Hex;
  marketplaceSalt: Hex;
};
export type ReviewedNftManifestJson = Omit<ReviewedNftManifest, 'startBlock'> & { startBlock: string };
export type ReviewedNftBlock = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };
/** Structurally compatible with createVerifiedRpc; no signer or transaction method. */
export type ReviewedNftRpc = {
  verification: RpcVerification;
  readRpc(method: RpcReadMethod, params?: readonly unknown[]): Promise<unknown>;
};
export type ReviewedNftVerification = { manifest: ReviewedNftManifest; manifestId: string; block: ReviewedNftBlock };
export type ReviewedNftErrorCode = 'REVIEWED_NFT_MANIFEST_INVALID' | 'REVIEWED_NFT_SERVER_ONLY'
  | 'REVIEWED_NFT_CHAIN_MISMATCH' | 'REVIEWED_NFT_ANCHOR_MISMATCH' | 'REVIEWED_NFT_CODE_MISMATCH'
  | 'REVIEWED_NFT_REFERENCE_MISMATCH' | 'REVIEWED_NFT_RPC_INVALID' | 'REVIEWED_NFT_CHAIN_MOVED'
  | 'REVIEWED_NFT_SOURCE_LIMIT';

/** Safe classifications only: never include provider responses or RPC secrets. */
export class ReviewedNftError extends Error {
  constructor(readonly code: ReviewedNftErrorCode) {
    super(code); this.name = 'ReviewedNftError';
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const data = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value);
const hexAddress = (value: unknown): value is Address => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);
const MAX_BLOCK = (1n << 64n) - 1n;
const fail = (code: ReviewedNftErrorCode): never => { throw new ReviewedNftError(code); };
const invalidManifest = (): never => fail('REVIEWED_NFT_MANIFEST_INVALID');

export function parseReviewedNftManifest(input: unknown): ReviewedNftManifest {
  const keys = ['schemaVersion','deploymentVersion','mode','chainId','genesisHash','startBlock','anchorHash',
    'oneshotFactory','registry','marketplace','treasury','reviewAuthority','registrySalt','marketplaceSalt'];
  if (!object(input) || !exact(input, keys) || input.schemaVersion !== 1 || input.deploymentVersion !== 'oneshot-reviewed-erc721-v1'
    || !hash(input.genesisHash) || input.genesisHash.toLowerCase() === zeroHash
    || !hash(input.anchorHash) || input.anchorHash.toLowerCase() === zeroHash
    || typeof input.startBlock !== 'string' || !/^[1-9]\d{0,19}$/.test(input.startBlock) || BigInt(input.startBlock) > MAX_BLOCK
    || !hexAddress(input.treasury) || input.treasury.toLowerCase() === zeroAddress
    || !hexAddress(input.reviewAuthority) || input.reviewAuthority.toLowerCase() === zeroAddress
    || !hash(input.registrySalt) || input.registrySalt.toLowerCase() === zeroHash
    || !hash(input.marketplaceSalt) || input.marketplaceSalt.toLowerCase() === zeroHash) return invalidManifest();
  const network = nftExecutionNetwork(input);
  if (!network || network.mode === 'base-sepolia' && input.genesisHash.toLowerCase() !== BASE_SEPOLIA_GENESIS_HASH) return invalidManifest();
  const contract = (value: unknown): ReviewedNftContractIdentity => {
    if (!object(value) || !exact(value, ['address','codeHash']) || !hexAddress(value.address) || value.address.toLowerCase() === zeroAddress
      || !hash(value.codeHash) || value.codeHash.toLowerCase() === zeroHash) return invalidManifest();
    return { address: value.address.toLowerCase() as Address, codeHash: value.codeHash.toLowerCase() as Hex };
  };
  const oneshotFactory = contract(input.oneshotFactory), registry = contract(input.registry), marketplace = contract(input.marketplace);
  if (new Set([oneshotFactory.address,registry.address,marketplace.address]).size !== 3) return invalidManifest();
  const identity: ReviewedNftIdentity = network.mode === 'local' ? {mode:'local',chainId:31337} : {mode:'base-sepolia',chainId:84532};
  const genesisHash = input.genesisHash.toLowerCase() as Hex, anchorHash = input.anchorHash.toLowerCase() as Hex;
  if (input.startBlock === '1' && anchorHash !== genesisHash) return invalidManifest();
  return {
    schemaVersion:1, deploymentVersion:'oneshot-reviewed-erc721-v1', ...identity, genesisHash, startBlock:BigInt(input.startBlock),anchorHash,
    oneshotFactory,registry,marketplace,treasury:input.treasury.toLowerCase() as Address,reviewAuthority:input.reviewAuthority.toLowerCase() as Address,
    registrySalt:input.registrySalt.toLowerCase() as Hex,marketplaceSalt:input.marketplaceSalt.toLowerCase() as Hex,
  };
}

/** Validate typed callers as strictly as JSON, then serialize in one fixed key order. */
export function reviewedNftManifestJson(input: ReviewedNftManifest): ReviewedNftManifestJson {
  if (!object(input) || typeof input.startBlock !== 'bigint') return invalidManifest();
  const normalized = parseReviewedNftManifest({...input,startBlock:input.startBlock.toString()});
  return {...normalized,startBlock:normalized.startBlock.toString()};
}
/** Lowercase SHA-256 hex without 0x, matching the existing manifest ID convention. */
export function reviewedNftManifestId(input: ReviewedNftManifest): string {
  return sha256(stringToHex(JSON.stringify(reviewedNftManifestJson(input)))).slice(2);
}

const factoryAbi = parseAbi(['function treasury() view returns(address)']);
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value)) return fail('REVIEWED_NFT_RPC_INVALID');
  return BigInt(value);
};
const tag = (value: bigint) => `0x${value.toString(16)}`;
const address = (value: unknown): Address => hexAddress(value) && value.toLowerCase() !== zeroAddress
  ? value.toLowerCase() as Address : fail('REVIEWED_NFT_REFERENCE_MISMATCH');
type Budget = { active: boolean; calls: number; deadline: number };

/** Read-only, bounded deployment proof at one exact canonical checkpoint.
 * This proves registry/market identity, never that a collection is admitted,
 * immutable, non-proxy, creator-owned, listed, or available for trading.
 */
export class VerifiedReviewedNftSource {
  constructor(private readonly rpc: ReviewedNftRpc) {}
  private async read(method: RpcReadMethod, params: readonly unknown[], budget: Budget) {
    if (!budget.active || Date.now() >= budget.deadline || ++budget.calls > 64) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    return this.rpc.readRpc(method, params);
  }
  private async block(number: bigint, budget: Budget): Promise<ReviewedNftBlock> {
    if (number < 0n || number > MAX_BLOCK) return fail('REVIEWED_NFT_RPC_INVALID');
    const value = await this.read('eth_getBlockByNumber',[tag(number),false],budget);
    if (!object(value) || quantity(value.number) !== number || !hash(value.hash) || value.hash.toLowerCase() === zeroHash
      || !hash(value.parentHash)) return fail('REVIEWED_NFT_RPC_INVALID');
    const timestamp = quantity(value.timestamp);
    if (timestamp > MAX_BLOCK) return fail('REVIEWED_NFT_RPC_INVALID');
    return {number,hash:value.hash.toLowerCase() as Hex,parentHash:value.parentHash.toLowerCase() as Hex,timestamp};
  }
  private async canonical(at: ReviewedNftBlock, budget: Budget) {
    const current = await this.block(at.number,budget);
    if (current.hash !== at.hash || current.parentHash !== at.parentHash || current.timestamp !== at.timestamp) return fail('REVIEWED_NFT_CHAIN_MOVED');
  }
  private async code(at: ReviewedNftBlock, contract: ReviewedNftContractIdentity, budget: Budget) {
    const value = await this.read('eth_getCode',[contract.address,{blockHash:at.hash,requireCanonical:true}],budget);
    if (!data(value) || value === '0x' || value.length > 131_074 || keccak256(value) !== contract.codeHash) return fail('REVIEWED_NFT_CODE_MISMATCH');
  }
  private async call(at: ReviewedNftBlock, to: Address, abi: Abi, functionName: string, budget: Budget): Promise<unknown> {
    const value = await this.read('eth_call',[{to,data:encodeFunctionData({abi,functionName})},{blockHash:at.hash,requireCanonical:true}],budget);
    if (!data(value) || value.length > 16_386) return fail('REVIEWED_NFT_RPC_INVALID');
    try {
      const result = decodeFunctionResult({abi,functionName,data:value});
      if (encodeFunctionResult({abi,functionName,result}).toLowerCase() !== value.toLowerCase()) return fail('REVIEWED_NFT_RPC_INVALID');
      return result;
    } catch { return fail('REVIEWED_NFT_RPC_INVALID'); }
  }
  private async domain(at: ReviewedNftBlock, to: Address, abi: Abi, name: string, chainId: number, budget: Budget) {
    const result = await this.call(at,to,abi,'eip712Domain',budget);
    if (!Array.isArray(result) || result.length !== 7 || result[0] !== '0x0f' || result[1] !== name || result[2] !== '1'
      || result[3] !== BigInt(chainId) || address(result[4]) !== to || result[5] !== zeroHash || !Array.isArray(result[6]) || result[6].length !== 0)
      return fail('REVIEWED_NFT_REFERENCE_MISMATCH');
  }
  async verify(input: ReviewedNftManifest, selected?: ReviewedNftBlock): Promise<ReviewedNftVerification> {
    if (typeof window !== 'undefined') return fail('REVIEWED_NFT_SERVER_ONLY');
    // Normalize/snapshot before the first await, including the caller's checkpoint.
    const manifest = parseReviewedNftManifest(reviewedNftManifestJson(input));
    const at = selected === undefined ? null : {...selected};
    if (at && (!exact(at,['number','hash','parentHash','timestamp']) || typeof at.number !== 'bigint' || at.number < 0n || at.number > MAX_BLOCK
      || typeof at.timestamp !== 'bigint' || at.timestamp < 0n || at.timestamp > MAX_BLOCK || !hash(at.hash) || !hash(at.parentHash))) return fail('REVIEWED_NFT_RPC_INVALID');
    if (at) { at.hash = at.hash.toLowerCase() as Hex; at.parentHash = at.parentHash.toLowerCase() as Hex; }
    const seen = this.rpc.verification;
    if (seen.mode !== manifest.mode || seen.chainId !== manifest.chainId || !hash(seen.genesisHash)
      || seen.genesisHash.toLowerCase() !== manifest.genesisHash) return fail('REVIEWED_NFT_CHAIN_MISMATCH');
    const budget: Budget = {active:true,calls:0,deadline:Date.now()+30_000};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_,reject) => {
      timer = setTimeout(() => { budget.active = false; reject(new ReviewedNftError('REVIEWED_NFT_SOURCE_LIMIT')); },30_000);
    });
    try {
      return await Promise.race([this.verifyAt(manifest,at,budget),timeout]);
    } finally { budget.active = false; if (timer) clearTimeout(timer); }
  }
  private async verifyAt(manifest: ReviewedNftManifest, selected: ReviewedNftBlock | null, budget: Budget): Promise<ReviewedNftVerification> {
    const at = selected ?? await this.block(quantity(await this.read('eth_blockNumber',[],budget)),budget);
    if (at.number < manifest.startBlock || (await this.block(0n,budget)).hash !== manifest.genesisHash) return fail('REVIEWED_NFT_CHAIN_MISMATCH');
    if ((await this.block(manifest.startBlock-1n,budget)).hash !== manifest.anchorHash) return fail('REVIEWED_NFT_ANCHOR_MISMATCH');
    await this.canonical(at,budget);
    for (const contract of [manifest.oneshotFactory,manifest.registry,manifest.marketplace]) await this.code(at,contract,budget);
    const reg = (name: string) => this.call(at,manifest.registry.address,REVIEWED_NFT_REGISTRY_ABI,name,budget);
    const market = (name: string) => this.call(at,manifest.marketplace.address,REVIEWED_NFT_MARKETPLACE_ABI,name,budget);
    if (await reg('REGISTRY_VERSION') !== 1n || await reg('ASSET_STANDARD') !== '0x80ac58cd' || await reg('MAX_SIGNATURE_BYTES') !== 4096n
      || address(await reg('oneshotFactory')) !== manifest.oneshotFactory.address || await reg('oneshotFactoryCodeHash') !== manifest.oneshotFactory.codeHash
      || address(await reg('reviewAuthority')) !== manifest.reviewAuthority || await reg('deploymentSalt') !== manifest.registrySalt
      || await reg('deploymentChainId') !== BigInt(manifest.chainId)) return fail('REVIEWED_NFT_REFERENCE_MISMATCH');
    if (await market('MARKETPLACE_VERSION') !== 4n || await market('ASSET_STANDARD') !== '0x80ac58cd' || await market('PLATFORM_FEE_BPS') !== 200n
      || await market('MAX_LISTING_INTENT_BYTES') !== 384n || await market('ROYALTY_QUOTE_GAS_LIMIT') !== 100_000n
      || address(await market('registry')) !== manifest.registry.address || address(await market('oneshotFactory')) !== manifest.oneshotFactory.address
      || address(await market('treasury')) !== manifest.treasury || await market('deploymentSalt') !== manifest.marketplaceSalt
      || await market('deploymentChainId') !== BigInt(manifest.chainId)) return fail('REVIEWED_NFT_REFERENCE_MISMATCH');
    if (address(await this.call(at,manifest.oneshotFactory.address,factoryAbi,'treasury',budget)) !== manifest.treasury) return fail('REVIEWED_NFT_REFERENCE_MISMATCH');
    await this.domain(at,manifest.registry.address,REVIEWED_NFT_REGISTRY_ABI,'OneshotReviewedCollectionRegistry',manifest.chainId,budget);
    await this.domain(at,manifest.marketplace.address,REVIEWED_NFT_MARKETPLACE_ABI,'OneshotReviewedMarketplace',manifest.chainId,budget);
    // A reorganization during any code or getter read invalidates the proof.
    await this.canonical(at,budget);
    if ((await this.block(manifest.startBlock-1n,budget)).hash !== manifest.anchorHash) return fail('REVIEWED_NFT_ANCHOR_MISMATCH');
    return {manifest,manifestId:reviewedNftManifestId(manifest),block:at};
  }
}
