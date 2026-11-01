import { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { RpcReadMethod, RpcVerification } from '@oneshot/evm';
import { isAddress, isData, isHash } from './manifest';
import { IndexerError, type Block, type ChainSource, type Manifest, type RawLog } from './types';

type VerifiedRpc = { verification: RpcVerification; readRpc(method: RpcReadMethod, params?: readonly unknown[]): Promise<unknown> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new IndexerError('RPC_DATA_INVALID'); };
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/.test(value)) return invalid();
  return BigInt(value);
}
const tag = (number: bigint) => `0x${number.toString(16)}`;
const referenceAbi = parseAbi(['function factory() view returns (address)', 'function treasury() view returns (address)']);
const authorizationAbi = parseAbi(['function listingAuthority() view returns (address)', 'function deploymentSalt() view returns (bytes32)']);

/** Reuses the server-only bounded RPC reader, including its identity check before every read. */
export class VerifiedRpcSource implements ChainSource {
  constructor(private readonly rpc: VerifiedRpc) {}
  async verify(manifest: Manifest): Promise<void> {
    const observed = this.rpc.verification;
    if (manifest.mode !== 'local' || manifest.chainId !== 31337 || observed.mode !== 'local' || observed.chainId !== 31337
      || observed.genesisHash.toLowerCase() !== manifest.genesisHash.toLowerCase()) throw new IndexerError('CHAIN_IDENTITY_MISMATCH');
    const genesis = await this.block(0n);
    if (genesis.hash !== manifest.genesisHash) throw new IndexerError('CHAIN_IDENTITY_MISMATCH');
    const anchor = await this.block(manifest.startBlock - 1n);
    if (anchor.hash !== manifest.anchorHash) throw new IndexerError('DEPLOYMENT_ANCHOR_CHANGED');
    for (const contract of [manifest.factory, manifest.marketplace]) {
      const code = await this.rpc.readRpc('eth_getCode', [contract.address, 'latest']);
      if (!isData(code) || code === '0x' || keccak256(code) !== contract.codeHash) throw new IndexerError('CONTRACT_CODE_MISMATCH');
    }
    const callAddress = async (address: Address, functionName: 'factory' | 'treasury') => {
      const data = await this.rpc.readRpc('eth_call', [{ to: address, data: encodeFunctionData({ abi: referenceAbi, functionName }) }, 'latest']);
      if (!isData(data)) return invalid();
      try { return decodeFunctionResult({ abi: referenceAbi, functionName, data }).toLowerCase(); }
      catch { return invalid(); }
    };
    if (await callAddress(manifest.marketplace.address, 'factory') !== manifest.factory.address) throw new IndexerError('FACTORY_REFERENCE_MISMATCH');
    const treasury = await callAddress(manifest.factory.address, 'treasury');
    if (treasury === zeroAddress || treasury !== await callAddress(manifest.marketplace.address, 'treasury')) throw new IndexerError('TREASURY_REFERENCE_MISMATCH');
    if (manifest.deploymentVersion === 'oneshot-nft-v2') {
      const callAuthorization = async (functionName: 'listingAuthority' | 'deploymentSalt') => {
        const data = await this.rpc.readRpc('eth_call', [{ to: manifest.marketplace.address,
          data: encodeFunctionData({ abi: authorizationAbi, functionName }) }, 'latest']);
        if (!isData(data)) return invalid();
        try { return decodeFunctionResult({ abi: authorizationAbi, functionName, data }).toLowerCase(); }
        catch { return invalid(); }
      };
      if (await callAuthorization('listingAuthority') !== manifest.listingAuthorization.authority) throw new IndexerError('LISTING_AUTHORITY_MISMATCH');
      if (await callAuthorization('deploymentSalt') !== manifest.listingAuthorization.salt) throw new IndexerError('DEPLOYMENT_SALT_MISMATCH');
    }
  }
  async height() { return quantity(await this.rpc.readRpc('eth_blockNumber')); }
  async block(number: bigint): Promise<Block> {
    if (number < 0n) return invalid();
    const value = await this.rpc.readRpc('eth_getBlockByNumber', [tag(number), false]);
    if (!object(value) || quantity(value.number) !== number || !isHash(value.hash) || !isHash(value.parentHash)) return invalid();
    return { number, hash: value.hash.toLowerCase() as Hex, parentHash: value.parentHash.toLowerCase() as Hex, timestamp: quantity(value.timestamp) };
  }
  async logs(block: Block, addresses: readonly Address[]): Promise<RawLog[]> {
    if (addresses.length === 0 || addresses.length > 4096 || !addresses.every(isAddress)) throw new IndexerError('SOURCE_LIMIT');
    const unique = [...new Set(addresses.map(address => address.toLowerCase() as Address))];
    const all: RawLog[] = [];
    for (let offset = 0; offset < unique.length; offset += 8) {
      const part = unique.slice(offset, offset + 8);
      // Bind even an empty response to this exact block, including across address chunks.
      // A number-range query can silently read a competing fork during an A→B→A reorg.
      const logs = await this.rpc.readRpc('eth_getLogs', [{ address: part, blockHash: block.hash }]);
      if (!Array.isArray(logs) || logs.length > 10_000) return invalid();
      for (const value of logs) {
        if (!object(value) || !isAddress(value.address) || !part.includes(value.address.toLowerCase() as Address)
          || value.removed !== false || !isData(value.data) || value.data.length > 131_074
          || !isHash(value.blockHash) || value.blockHash.toLowerCase() !== block.hash || quantity(value.blockNumber) !== block.number
          || !isHash(value.transactionHash) || !Array.isArray(value.topics) || value.topics.length > 4 || !value.topics.every(isHash)) return invalid();
        const transactionIndex = quantity(value.transactionIndex), logIndex = quantity(value.logIndex);
        if (transactionIndex > BigInt(Number.MAX_SAFE_INTEGER) || logIndex > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
        all.push({ address: value.address.toLowerCase() as Address, data: value.data,
          topics: value.topics.map(topic => topic.toLowerCase() as Hex), blockNumber: block.number, blockHash: block.hash,
          transactionHash: value.transactionHash.toLowerCase() as Hex, transactionIndex: Number(transactionIndex), logIndex: Number(logIndex) });
        if (all.length > 10_000) throw new IndexerError('SOURCE_LIMIT');
      }
    }
    all.sort((a, b) => a.logIndex - b.logIndex);
    for (let i = 1; i < all.length; i++) if (all[i - 1].logIndex === all[i].logIndex) throw new IndexerError('DUPLICATE_LOG');
    return all;
  }
}
