import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { networkConfig } from './config';
import { BASE_SEPOLIA_GENESIS_HASH } from './execution-network';
import { createVerifiedRpc } from './rpc';
import {
  REVIEWED_NFT_MARKETPLACE_ABI, REVIEWED_NFT_REGISTRY_ABI, ReviewedNftError, VerifiedReviewedNftSource,
  parseReviewedNftManifest, reviewedNftManifestId, reviewedNftManifestJson,
  type ReviewedNftBlock, type ReviewedNftManifest, type ReviewedNftManifestJson,
} from './reviewed-nft';

const GENESIS = `0x${'11'.repeat(32)}` as Hex;
const ANCHOR = `0x${'22'.repeat(32)}` as Hex;
const CHECKPOINT = `0x${'33'.repeat(32)}` as Hex;
const PARENT = `0x${'44'.repeat(32)}` as Hex;
const OTHER = `0x${'55'.repeat(32)}` as Hex;
const FACTORY = `0x${'a1'.repeat(20)}` as Address;
const REGISTRY = `0x${'b2'.repeat(20)}` as Address;
const MARKET = `0x${'c3'.repeat(20)}` as Address;
const TREASURY = `0x${'d4'.repeat(20)}` as Address;
const AUTHORITY = `0x${'e5'.repeat(20)}` as Address;
const REGISTRY_SALT = `0x${'66'.repeat(32)}` as Hex;
const MARKET_SALT = `0x${'77'.repeat(32)}` as Hex;
const CODE = { [FACTORY]:'0x60016000', [REGISTRY]:'0x60026000', [MARKET]:'0x60036000' } as Record<string,Hex>;
const FACTORY_ABI = parseAbi(['function treasury() view returns(address)']);
const BLOCK: ReviewedNftBlock = {number:10n,hash:CHECKPOINT,parentHash:PARENT,timestamp:100n};

function manifestJson(base = false): ReviewedNftManifestJson {
  return {
    schemaVersion:1,deploymentVersion:'oneshot-reviewed-erc721-v1',mode:base?'base-sepolia':'local',chainId:base?84532:31337,
    genesisHash:base?BASE_SEPOLIA_GENESIS_HASH:GENESIS,startBlock:'2',anchorHash:ANCHOR,
    oneshotFactory:{address:FACTORY,codeHash:keccak256(CODE[FACTORY])},registry:{address:REGISTRY,codeHash:keccak256(CODE[REGISTRY])},
    marketplace:{address:MARKET,codeHash:keccak256(CODE[MARKET])},treasury:TREASURY,reviewAuthority:AUTHORITY,
    registrySalt:REGISTRY_SALT,marketplaceSalt:MARKET_SALT,
  };
}
const manifest = (base = false) => parseReviewedNftManifest(manifestJson(base));
type Request = {id:number;method:string;params:unknown[]};
type RpcFixtureOptions = {
  base?:boolean;
  transform?:(request:Request,result:unknown)=>unknown;
  changeGetter?:(to:string,name:string,result:unknown)=>unknown;
};
function transport(options:RpcFixtureOptions = {}) {
  const calls:Request[] = [];
  const chainId = options.base?84532:31337;
  const genesisHash = options.base?BASE_SEPOLIA_GENESIS_HASH:GENESIS;
  const abiFor = (to:string):Abi => to===REGISTRY?REVIEWED_NFT_REGISTRY_ABI:to===MARKET?REVIEWED_NFT_MARKETPLACE_ABI:FACTORY_ABI;
  const registry:Record<string,unknown> = {
    REGISTRY_VERSION:1n,ASSET_STANDARD:'0x80ac58cd',MAX_SIGNATURE_BYTES:4096n,oneshotFactory:FACTORY,
    oneshotFactoryCodeHash:keccak256(CODE[FACTORY]),reviewAuthority:AUTHORITY,deploymentSalt:REGISTRY_SALT,deploymentChainId:BigInt(chainId),
    eip712Domain:['0x0f','OneshotReviewedCollectionRegistry','1',BigInt(chainId),REGISTRY,zeroHash,[]],
  };
  const market:Record<string,unknown> = {
    MARKETPLACE_VERSION:4n,ASSET_STANDARD:'0x80ac58cd',PLATFORM_FEE_BPS:200n,MAX_LISTING_INTENT_BYTES:384n,
    ROYALTY_QUOTE_GAS_LIMIT:100_000n,registry:REGISTRY,oneshotFactory:FACTORY,treasury:TREASURY,
    deploymentSalt:MARKET_SALT,deploymentChainId:BigInt(chainId),
    eip712Domain:['0x0f','OneshotReviewedMarketplace','1',BigInt(chainId),MARKET,zeroHash,[]],
  };
  const fetch = vi.fn(async(_url:Parameters<typeof globalThis.fetch>[0],init?:RequestInit) => {
    const request = JSON.parse(init!.body as string) as Request; calls.push(structuredClone(request));
    let result:unknown;
    if (request.method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
    else if (request.method === 'eth_blockNumber') result = '0xa';
    else if (request.method === 'eth_getBlockByNumber') {
      const number = request.params[0];
      result = number === '0x0' ? {number,hash:genesisHash,parentHash:zeroHash,timestamp:'0x0'}
        : number === '0x1' ? {number,hash:ANCHOR,parentHash:genesisHash,timestamp:'0x1'}
          : {number:'0xa',hash:CHECKPOINT,parentHash:PARENT,timestamp:'0x64'};
    } else if (request.method === 'eth_getCode') result = CODE[request.params[0] as string];
    else if (request.method === 'eth_call') {
      const call = request.params[0] as {to:string;data:Hex}, abi = abiFor(call.to);
      const {functionName} = decodeFunctionData({abi,data:call.data});
      const getters = call.to === REGISTRY?registry:call.to === MARKET?market:{treasury:TREASURY};
      const decoded = options.changeGetter ? options.changeGetter(call.to,functionName,getters[functionName]) : getters[functionName];
      result = encodeFunctionResult({abi,functionName,result:decoded});
    } else throw new Error('Unrecognized test RPC request.');
    if (options.transform) result = options.transform(request,result);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
  }) as typeof globalThis.fetch;
  return {calls,fetch};
}
async function source(options:RpcFixtureOptions = {}) {
  const rpc = transport(options), config = networkConfig(options.base?{ONESHOT_NETWORK:'base-sepolia'}:{ONESHOT_NETWORK:'local'});
  const verified = await createVerifiedRpc(config,{fetch:rpc.fetch});
  return {...rpc,source:new VerifiedReviewedNftSource(verified),rpc:verified};
}
const errorCode = (code:string) => expect.objectContaining({name:'ReviewedNftError',code});

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('independent reviewed ERC-721 manifest',()=>{
  it('normalizes all identities and hashes stable canonical JSON irrespective of input key order',()=>{
    const original = manifest();
    const reversed: Record<string,unknown> = Object.fromEntries(Object.entries(manifestJson()).reverse());
    reversed.oneshotFactory = {codeHash:original.oneshotFactory.codeHash.toUpperCase(),address:FACTORY.toUpperCase()};
    reversed.registrySalt = REGISTRY_SALT.toUpperCase();
    const normalized = parseReviewedNftManifest(reversed);
    expect(normalized).toEqual(original);
    expect(reviewedNftManifestJson(normalized)).toEqual(manifestJson());
    expect(reviewedNftManifestId(normalized)).toMatch(/^[\da-f]{64}$/);
    expect(reviewedNftManifestId(normalized)).toBe(reviewedNftManifestId(original));
    expect(reviewedNftManifestId({...original,marketplaceSalt:OTHER})).not.toBe(reviewedNftManifestId(original));
    expect(reviewedNftManifestId({...original,registrySalt:OTHER})).not.toBe(reviewedNftManifestId(original));
  });
  it('permits only exact local/Base Sepolia identities with explicit anchors',()=>{
    expect(manifest(true).genesisHash).toBe(BASE_SEPOLIA_GENESIS_HASH);
    const changed:Record<string,unknown>[] = [
      {mode:'zero',chainId:12345},{mode:'base-sepolia',chainId:8453},{mode:'local',chainId:84532},
      {mode:'base-sepolia',chainId:84532,genesisHash:GENESIS},{genesisHash:zeroHash},{anchorHash:zeroHash},
      {startBlock:'0'},{startBlock:'01'},{startBlock:2},{startBlock:'18446744073709551616'},
      {deploymentVersion:'oneshot-nft-v3'},{schemaVersion:2},{registrySalt:zeroHash},{marketplaceSalt:zeroHash},
      {treasury:`0x${'00'.repeat(20)}`},{reviewAuthority:`0x${'00'.repeat(20)}`},{unknown:'unexpected'},
      {registry:{address:REGISTRY,codeHash:zeroHash}},{registry:{address:REGISTRY,codeHash:OTHER,unknown:true}},
      {registry:{address:FACTORY,codeHash:OTHER}},{marketplace:{address:REGISTRY,codeHash:OTHER}},
    ];
    for(const patch of changed) expect(()=>parseReviewedNftManifest({...manifestJson(),...patch}),JSON.stringify(patch)).toThrow(ReviewedNftError);
    const first = {...manifestJson(),startBlock:'1',anchorHash:GENESIS};
    expect(parseReviewedNftManifest(first).startBlock).toBe(1n);
    expect(()=>parseReviewedNftManifest({...first,anchorHash:ANCHOR})).toThrow(ReviewedNftError);
    const missing = {...manifestJson()} as Record<string,unknown>; delete missing.reviewAuthority;
    expect(()=>parseReviewedNftManifest(missing)).toThrow(ReviewedNftError);
  });
  it('also rejects extra or wrongly typed programmatic manifest fields',()=>{
    expect(()=>reviewedNftManifestId({...manifest(),extra:true} as unknown as ReviewedNftManifest)).toThrow(ReviewedNftError);
    expect(()=>reviewedNftManifestJson({...manifest(),startBlock:'2'} as unknown as ReviewedNftManifest)).toThrow(ReviewedNftError);
    expect(()=>reviewedNftManifestId({...manifest(),registry:{...manifest().registry,extra:true}} as unknown as ReviewedNftManifest)).toThrow(ReviewedNftError);
  });
});

describe('hash-selected reviewed ERC-721 deployment verification',()=>{
  it.each([false,true])('verifies all core runtimes, domain identities and immutable references (Base=%s)',async base=>{
    const rpc = await source({base});
    const verified = await rpc.source.verify(manifest(base));
    expect(verified).toEqual({manifest:manifest(base),manifestId:reviewedNftManifestId(manifest(base)),block:BLOCK});
    const reads = rpc.calls.filter(call=>call.method === 'eth_call' || call.method === 'eth_getCode');
    expect(reads.filter(call=>call.method === 'eth_getCode')).toHaveLength(3);
    expect(reads.length).toBeGreaterThan(20);
    for (const request of reads) expect(request.params[1]).toEqual({blockHash:CHECKPOINT,requireCanonical:true});
    expect(rpc.calls.every(call=>!['eth_sendTransaction','eth_sendRawTransaction','eth_sign','personal_sign'].includes(call.method))).toBe(true);
  });
  it('accepts an explicitly selected canonical checkpoint, copying inputs before asynchronous reads',async()=>{
    const input = manifest(), selected = {...BLOCK};
    let mutate = false;
    const rpc = await source({transform:(request,result)=>{
      if(mutate && request.method === 'eth_chainId') { input.treasury = FACTORY; selected.hash = OTHER; mutate = false; }
      return result;
    }});
    mutate = true;
    const verified = await rpc.source.verify(input,selected);
    expect(verified.manifest.treasury).toBe(TREASURY); expect(verified.block.hash).toBe(CHECKPOINT);
  });
  it('rejects wrong verified network before reads and pre-deployment checkpoints',async()=>{
    const rpc = await source(); const count = rpc.calls.length;
    await expect(rpc.source.verify(manifest(true))).rejects.toEqual(errorCode('REVIEWED_NFT_CHAIN_MISMATCH'));
    expect(rpc.calls.length).toBe(count);
    await expect(rpc.source.verify(manifest(),{...BLOCK,number:1n})).rejects.toEqual(errorCode('REVIEWED_NFT_CHAIN_MISMATCH'));
    await expect(rpc.source.verify(manifest(),{...BLOCK,number:-1n})).rejects.toEqual(errorCode('REVIEWED_NFT_RPC_INVALID'));
  });
  it('rejects a changed parent deployment anchor',async()=>{
    const rpc = await source({transform:(request,result)=>request.method === 'eth_getBlockByNumber' && request.params[0] === '0x1'
      ? {...result as object,hash:OTHER} : result});
    await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_ANCHOR_MISMATCH'));
  });
  it.each([FACTORY,REGISTRY,MARKET])('rejects changed, empty, and malformed runtime at %s',async selected=>{
    for(const value of ['0x6004','0x','0xxyz']) {
      const rpc = await source({transform:(request,result)=>request.method === 'eth_getCode' && request.params[0] === selected ? value : result});
      await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_CODE_MISMATCH'));
    }
  });
  it('rejects each identity, capability, economic constant, and independent salt mismatch',async()=>{
    const cases:[Address,string,unknown][] = [
      [REGISTRY,'REGISTRY_VERSION',2n],[REGISTRY,'ASSET_STANDARD','0xd9b67a26'],[REGISTRY,'oneshotFactory',MARKET],
      [REGISTRY,'oneshotFactoryCodeHash',OTHER],[REGISTRY,'reviewAuthority',TREASURY],[REGISTRY,'deploymentSalt',MARKET_SALT],
      [REGISTRY,'deploymentChainId',84532n],[MARKET,'MARKETPLACE_VERSION',3n],[MARKET,'ASSET_STANDARD','0xd9b67a26'],
      [MARKET,'PLATFORM_FEE_BPS',201n],[MARKET,'MAX_LISTING_INTENT_BYTES',383n],[MARKET,'ROYALTY_QUOTE_GAS_LIMIT',99_999n],
      [MARKET,'registry',FACTORY],[MARKET,'oneshotFactory',REGISTRY],[MARKET,'treasury',AUTHORITY],
      [MARKET,'deploymentSalt',REGISTRY_SALT],[MARKET,'deploymentChainId',1n],[FACTORY,'treasury',AUTHORITY],
    ];
    for(const [to,name,replacement] of cases) {
      const rpc = await source({changeGetter:(candidate,getter,value)=>candidate === to && getter === name?replacement:value});
      await expect(rpc.source.verify(manifest()),`${to}:${name}`).rejects.toEqual(errorCode('REVIEWED_NFT_REFERENCE_MISMATCH'));
    }
  });
  it('checks both EIP712 domains including fields, salt and extension set',async()=>{
    const replacements = [[0,'0x1f'],[1,'Another marketplace'],[2,'2'],[3,1n],[4,FACTORY],[5,OTHER],[6,[1n]]] as const;
    for(const target of [REGISTRY,MARKET]) for(const [index,replacement] of replacements) {
      const rpc = await source({changeGetter:(to,name,value)=>{
        if(to !== target || name !== 'eip712Domain') return value;
        const next = [...value as unknown[]]; next[index] = replacement; return next;
      }});
      await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_REFERENCE_MISMATCH'));
    }
  });
  it('rejects trailing, short, malformed and oversized ABI responses',async()=>{
    for(const transform of [(value:string)=>value+'00'.repeat(32),()=> '0x',()=> '0xabcd',()=> `0x${'00'.repeat(8193)}`]) {
      const rpc = await source({transform:(request,result)=>request.method === 'eth_call'?transform(result as string):result});
      await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_RPC_INVALID'));
    }
  });
  it('detects a reorganization during proof instead of returning mixed canonical evidence',async()=>{
    let targetReads = 0;
    const rpc = await source({transform:(request,result)=>{
      if(request.method === 'eth_getBlockByNumber' && request.params[0] === '0xa' && ++targetReads >= 3)
        return {...result as object,hash:OTHER};
      return result;
    }});
    await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_CHAIN_MOVED'));
  });
  it('detects anchor movement after all getter reads',async()=>{
    let anchorReads = 0;
    const rpc = await source({transform:(request,result)=>{
      if(request.method === 'eth_getBlockByNumber' && request.params[0] === '0x1' && ++anchorReads >= 2)
        return {...result as object,hash:OTHER};
      return result;
    }});
    await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_ANCHOR_MISMATCH'));
  });
  it('preserves the verified RPC fail-closed identity check on each read',async()=>{
    let reset = false;
    const rpc = await source({transform:(request,result)=>reset && request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0'
      ? {...result as object,hash:OTHER} : result});
    reset = true;
    await expect(rpc.source.verify(manifest())).rejects.toMatchObject({code:'GENESIS_MISMATCH'});
  });
  it('bounds stalled reads without exposing transport details',async()=>{
    vi.useFakeTimers();
    const rpc = await source();
    const stalled = new VerifiedReviewedNftSource({...rpc.rpc,readRpc:async()=>new Promise(()=>{})});
    const result = stalled.verify(manifest());
    const rejection = expect(result).rejects.toEqual(errorCode('REVIEWED_NFT_SOURCE_LIMIT'));
    await vi.advanceTimersByTimeAsync(30_000); await rejection;
  });
  it('rejects browser execution',async()=>{
    const rpc = await source(); vi.stubGlobal('window',{});
    await expect(rpc.source.verify(manifest())).rejects.toEqual(errorCode('REVIEWED_NFT_SERVER_ONLY'));
  });
});

describe('generated reviewed NFT ABIs',()=>{
  it.each([
    ['OneshotReviewedCollectionRegistry',REVIEWED_NFT_REGISTRY_ABI],['OneshotReviewedMarketplace',REVIEWED_NFT_MARKETPLACE_ABI],
  ] as const)('matches the full compiled %s ABI when Foundry artifacts are available',(name,abi)=>{
    const path = fileURLToPath(new URL(`../../../contracts-evm/out/${name}.sol/${name}.json`,import.meta.url));
    // npm-only checkouts do not have generated Forge output; the contract suite
    // and deployment planner provide the compiled comparison when available.
    if(!existsSync(path)) return;
    expect(abi).toEqual(JSON.parse(readFileSync(path,'utf8')).abi);
  });
});
