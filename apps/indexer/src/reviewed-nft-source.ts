import { randomBytes } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { RpcError, type RpcReadMethod } from '@oneshot/evm';
import { parseReviewedNftManifest, reviewedNftManifestJson, VerifiedReviewedNftSource, type ReviewedNftManifest, type ReviewedNftRpc } from '../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../packages/evm/src/reviewed-nft-abi';
import { IndexerError, type Block, type RawLog } from './types';
import { REVIEWED_NFT_JOURNAL_LIMITS as LIMITS, type ReviewedNftAccounting, type ReviewedNftChainSource } from './reviewed-nft-types';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && value.toLowerCase() !== zeroAddress;
const data = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value);
const fail = (code = 'REVIEWED_NFT_RPC_INVALID'): never => { throw new IndexerError(code); };
const MAX_BLOCK = (1n << 64n) - 1n;
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value) ? BigInt(value) : fail();
const tag = (value: bigint) => `0x${value.toString(16)}`;
const same = (left: Block, right: Block) => left.number === right.number && left.hash === right.hash && left.parentHash === right.parentHash && left.timestamp === right.timestamp;

export function normalizeReviewedNftBlock(value: Block): Block {
  if (!object(value) || typeof value.number !== 'bigint' || value.number < 0n || value.number > MAX_BLOCK
    || typeof value.timestamp !== 'bigint' || value.timestamp < 0n || value.timestamp > MAX_BLOCK
    || !hash(value.hash) || value.hash.toLowerCase() === zeroHash || !hash(value.parentHash)
    || value.number !== 0n && value.parentHash.toLowerCase() === zeroHash) return fail();
  return {number:value.number,hash:value.hash.toLowerCase() as Hex,parentHash:value.parentHash.toLowerCase() as Hex,timestamp:value.timestamp};
}

/** Validate even custom ChainSource results before they enter a canonical journal. */
export function normalizeReviewedNftLogs(at: Block, input: readonly RawLog[], allowed?: readonly Address[]): RawLog[] {
  const block = normalizeReviewedNftBlock(at);
  if (!Array.isArray(input) || input.length > LIMITS.maximumLogs) return fail('REVIEWED_NFT_SOURCE_LIMIT');
  const permitted = allowed ? new Set(allowed.map(value => value.toLowerCase())) : null;
  let bytes = 0;
  const logs = input.map((value): RawLog => {
    if (!object(value) || !address(value.address) || permitted && !permitted.has(value.address.toLowerCase())
      || !data(value.data) || value.data.length > LIMITS.maximumLogDataBytes * 2 + 2
      || !hash(value.blockHash) || value.blockHash.toLowerCase() !== block.hash || value.blockNumber !== block.number
      || !hash(value.transactionHash) || value.transactionHash.toLowerCase() === zeroHash
      || !Array.isArray(value.topics) || value.topics.length > 4 || !value.topics.every(hash)
      || typeof value.logIndex !== 'number' || !Number.isSafeInteger(value.logIndex) || value.logIndex < 0 || value.logIndex > 2_147_483_647
      || typeof value.transactionIndex !== 'number' || !Number.isSafeInteger(value.transactionIndex) || value.transactionIndex < 0 || value.transactionIndex > 2_147_483_647
      || Object.hasOwn(value,'removed') && value.removed !== false) return fail('REVIEWED_NFT_LOG_INVALID');
    bytes += (value.data.length - 2) / 2 + value.topics.length * 32 + 160;
    if (bytes > LIMITS.maximumLogBytes) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    return {address:value.address.toLowerCase() as Address,data:value.data.toLowerCase() as Hex,topics:value.topics.map(topic => topic.toLowerCase() as Hex),
      blockNumber:block.number,blockHash:block.hash,transactionHash:value.transactionHash.toLowerCase() as Hex,transactionIndex:value.transactionIndex,logIndex:value.logIndex};
  }).sort((left,right)=>left.logIndex-right.logIndex);
  const indexes = new Map<number,Hex>(), transactions = new Map<Hex,number>();
  let previousTransaction = -1;
  for (let index = 0; index < logs.length; index++) {
    const log = logs[index], knownHash = indexes.get(log.transactionIndex), knownIndex = transactions.get(log.transactionHash);
    if (index > 0 && log.logIndex === logs[index-1].logIndex || log.transactionIndex < previousTransaction
      || knownHash !== undefined && knownHash !== log.transactionHash || knownIndex !== undefined && knownIndex !== log.transactionIndex)
      return fail('REVIEWED_NFT_LOG_ORDER_INVALID');
    indexes.set(log.transactionIndex,log.transactionHash); transactions.set(log.transactionHash,log.transactionIndex); previousTransaction = log.transactionIndex;
  }
  return logs;
}

type Budget = { active:boolean; reads:number; deadline:number };

/** Bounded read-only journal transport; a missing hash-selector capability fails closed. */
export class VerifiedReviewedNftJournalSource implements ReviewedNftChainSource {
  constructor(private readonly rpc: ReviewedNftRpc) {}
  private async read(method: RpcReadMethod, params: readonly unknown[], budget: Budget) {
    if (!budget.active || Date.now() >= budget.deadline || ++budget.reads > LIMITS.maximumReads) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    return this.rpc.readRpc(method,params);
  }
  private async bounded<T>(run:(budget:Budget)=>Promise<T>): Promise<T> {
    const budget:Budget = {active:true,reads:0,deadline:Date.now()+LIMITS.sourceTimeoutMs};
    let timer:ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_,reject)=>{timer=setTimeout(()=>{budget.active=false;reject(new IndexerError('REVIEWED_NFT_SOURCE_LIMIT'));},LIMITS.sourceTimeoutMs);});
    try { return await Promise.race([run(budget),timeout]); } finally { budget.active=false;if(timer)clearTimeout(timer); }
  }
  private async readBlock(number:bigint,budget:Budget):Promise<Block> {
    if (typeof number !== 'bigint' || number < 0n || number > MAX_BLOCK) return fail();
    const value = await this.read('eth_getBlockByNumber',[tag(number),false],budget);
    if (!object(value) || quantity(value.number) !== number || !hash(value.hash) || !hash(value.parentHash)) return fail();
    return normalizeReviewedNftBlock({number,hash:value.hash,parentHash:value.parentHash,timestamp:quantity(value.timestamp)});
  }
  private async canonical(block:Block,budget:Budget) {
    if (!same(block,await this.readBlock(block.number,budget))) return fail('REVIEWED_NFT_CHAIN_MOVED');
  }
  private async negative(method:RpcReadMethod,params:readonly unknown[],budget:Budget) {
    let rejected = false;
    try { await this.read(method,params,budget); }
    catch(error) {
      if(error instanceof IndexerError) throw error;
      rejected = error instanceof RpcError && error.code === 'RPC_REMOTE_ERROR' && error.remoteRejection === 'block-not-found';
    }
    if (!rejected) return fail('REVIEWED_NFT_HASH_SELECTOR_UNVERIFIED');
  }
  async verify(input:ReviewedNftManifest,selected?:Block):Promise<void> {
    const manifest = parseReviewedNftManifest(reviewedNftManifestJson(input));
    return this.bounded(async budget=>{
      const wrapped:ReviewedNftRpc = {verification:this.rpc.verification,readRpc:(method,params=[])=>this.read(method,params,budget)};
      const verified = await new VerifiedReviewedNftSource(wrapped).verify(manifest,selected);
      const missing = {blockHash:`0x${randomBytes(32).toString('hex')}` as Hex,requireCanonical:true};
      const market = manifest.marketplace.address, call = {to:market,data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'totalPending'})};
      await this.negative('eth_getCode',[market,missing],budget);
      await this.negative('eth_call',[call,missing],budget);
      await this.negative('eth_getBalance',[market,missing],budget);
      await this.negative('eth_getLogs',[{address:[manifest.registry.address],blockHash:missing.blockHash}],budget);
      await this.canonical(verified.block,budget);
    });
  }
  height():Promise<bigint> { return this.bounded(async budget=>{const number=quantity(await this.read('eth_blockNumber',[],budget));if(number>MAX_BLOCK)return fail();return number;}); }
  block(number:bigint):Promise<Block> { return this.bounded(budget=>this.readBlock(number,budget)); }
  async logs(at:Block,addresses:readonly Address[]):Promise<RawLog[]> {
    const block = normalizeReviewedNftBlock(at);
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > LIMITS.maximumAddresses || !addresses.every(address)) return fail('REVIEWED_NFT_SOURCE_LIMIT');
    const unique = [...new Set(addresses.map(value=>value.toLowerCase() as Address))];
    return this.bounded(async budget=>{
      await this.canonical(block,budget);
      await this.negative('eth_getLogs',[{address:[unique[0]],blockHash:`0x${randomBytes(32).toString('hex')}`}],budget);
      const all:RawLog[] = [];
      for(let offset=0;offset<unique.length;offset+=LIMITS.addressBatchSize) {
        const part=unique.slice(offset,offset+LIMITS.addressBatchSize);
        const result=await this.read('eth_getLogs',[{address:part,blockHash:block.hash}],budget);
        if (!Array.isArray(result) || result.length > LIMITS.maximumLogs) return fail('REVIEWED_NFT_SOURCE_LIMIT');
        for(const value of result) {
          if(!object(value) || value.removed !== false || !hash(value.blockHash) || !hash(value.transactionHash) || !address(value.address)
            || !data(value.data) || !Array.isArray(value.topics)) return fail();
          const logIndex=quantity(value.logIndex),transactionIndex=quantity(value.transactionIndex);
          if(logIndex>2_147_483_647n||transactionIndex>2_147_483_647n)return fail();
          const parsed=normalizeReviewedNftLogs(block,[{address:value.address,data:value.data,topics:value.topics as Hex[],blockHash:value.blockHash,
            blockNumber:quantity(value.blockNumber),transactionHash:value.transactionHash,logIndex:Number(logIndex),transactionIndex:Number(transactionIndex)}],part);
          all.push(...parsed);
          if(all.length>LIMITS.maximumLogs)return fail('REVIEWED_NFT_SOURCE_LIMIT');
        }
      }
      const logs=normalizeReviewedNftLogs(block,all,unique);
      await this.canonical(block,budget);return logs;
    });
  }
  async accounting(input:ReviewedNftManifest,at:Block):Promise<ReviewedNftAccounting> {
    const manifest=parseReviewedNftManifest(reviewedNftManifestJson(input)),block=normalizeReviewedNftBlock(at);
    if(block.number<manifest.startBlock)return fail('REVIEWED_NFT_ACCOUNTING_INVALID');
    return this.bounded(async budget=>{
      await this.canonical(block,budget);
      const selected={blockHash:block.hash,requireCanonical:true},market=manifest.marketplace.address;
      const call={to:market,data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'totalPending'})};
      const missing={blockHash:`0x${randomBytes(32).toString('hex')}`,requireCanonical:true};
      await this.negative('eth_getBalance',[market,missing],budget);
      await this.negative('eth_getCode',[market,missing],budget);
      await this.negative('eth_call',[call,missing],budget);
      const code=await this.read('eth_getCode',[market,selected],budget);
      const balance=quantity(await this.read('eth_getBalance',[market,selected],budget));
      if(code==='0x'){await this.canonical(block,budget);return{pending:'0',balance:balance.toString(),marketDeployed:false,nextListingId:'1'};}
      if(!data(code)||code.length>131_074||keccak256(code)!==manifest.marketplace.codeHash)return fail('REVIEWED_NFT_CODE_MISMATCH');
      const value=await this.read('eth_call',[call,selected],budget);
      if(!data(value)||value.length!==66)return fail();
      let pending:bigint;
      try { pending=decodeFunctionResult({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'totalPending',data:value});
        if(encodeFunctionResult({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'totalPending',result:pending}).toLowerCase()!==value.toLowerCase())return fail();
      } catch { return fail(); }
      const nextData=await this.read('eth_call',[{to:market,data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'nextListingId'})},selected],budget);
      if(!data(nextData)||nextData.length!==66)return fail();
      const nextListingId=decodeFunctionResult({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'nextListingId',data:nextData});
      if(nextListingId<=0n||encodeFunctionResult({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'nextListingId',result:nextListingId}).toLowerCase()!==nextData.toLowerCase())return fail();
      if(balance<pending)return fail('REVIEWED_NFT_INSOLVENT');
      await this.canonical(block,budget);
      return{pending:pending.toString(),balance:balance.toString(),marketDeployed:true,nextListingId:nextListingId.toString()};
    });
  }
}
