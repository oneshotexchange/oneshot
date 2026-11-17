import {afterEach,describe,expect,it,vi} from 'vitest';
import {decodeFunctionData,type Address} from 'viem';
import {TOKEN_MARKET_FACTORY_ABI} from '@oneshot/evm';
import {analyticsFixture} from './token-event-fixture';
import {tokenAddress as a,tokenHash as h} from './token-fixture';
import {TOKEN_EVENT_LIMITS,VerifiedTokenEventSource} from '../src/token-event-source';
import {normalizeTokenRegistration} from '../src/token-event-projector';
import {parseTokenEventArguments} from '../../../scripts/index-token-events';

afterEach(()=>vi.useRealTimers());
export async function eventRpcFixture(){
  const f=await analyticsFixture(),original=f.readRpc.getMockImplementation()!;
  f.state.head=2n;f.state.hashes.set(1n,f.first.hash);f.state.hashes.set(2n,f.next.hash);
  const logs=[...f.creation,...f.swaps];
  const wire=(log:typeof logs[number])=>({...log,removed:false,blockNumber:`0x${log.blockNumber.toString(16)}`,transactionIndex:`0x${log.transactionIndex.toString(16)}`,logIndex:`0x${log.logIndex.toString(16)}`});
  f.readRpc.mockImplementation(async(method,params=[])=>{
    if(method!=='eth_getLogs')return original(method,params);
    const filter=params[0] as {address:Address[];blockHash:string;topics?:unknown[]};
    return logs.filter(log=>log.blockHash===filter.blockHash&&filter.address.includes(log.address)&&(!filter.topics||filter.topics.every((expected,index)=>expected===null||(Array.isArray(expected)?expected:[expected]).includes(log.topics[index])))).map(wire);
  });
  f.readRpc.mockClear();
  return{...f,logs,wire,source:new VerifiedTokenEventSource({verification:f.verification,readRpc:f.readRpc})};
}
describe('bounded verified token event capture',()=>{
  it('captures constructor ordering, all pool routes and exact hash-selected contract proofs',async()=>{
    const f=await eventRpcFixture(),first=await f.source.capture(f.manifest,f.first,[],f.next);
    expect(first.logs).toEqual(f.creation);expect(first.registrations).toHaveLength(1);
    const second=await f.source.capture(f.manifest,f.next,first.registrations,f.next);expect(second.logs).toEqual(f.swaps);expect(second.registrations).toEqual([]);
    for(const[method,params]of f.readRpc.mock.calls)if(method==='eth_getLogs')expect(params![0]).toHaveProperty('blockHash');else if(method==='eth_call'||method==='eth_getCode')expect(params![1]).toMatchObject({requireCanonical:true});
  });
  it('captures more than25 already registered markets without a factory-wide snapshot or enumeration',async()=>{
    const f=await eventRpcFixture();
    const known=Array.from({length:32},(_,index)=>normalizeTokenRegistration({...f.registered,market:a(100+index*2),token:a(101+index*2),poolId:h(100+index)}));
    f.state.count=32n;
    // No logs for these registered addresses/pools in this block.
    const result=await f.source.capture(f.manifest,f.next,known,f.next);expect(result.logs).toEqual([]);
    for(const[method,params]of f.readRpc.mock.calls)if(method==='eth_call'&&(params![0] as {to:string}).to===f.factory)expect(decodeFunctionData({abi:TOKEN_MARKET_FACTORY_ABI,data:(params![0] as {data:`0x${string}`}).data}).functionName).not.toBe('markets');
    expect(result.reads).toBeLessThan(TOKEN_EVENT_LIMITS.maximumReads);
  });
  it('rejects omitted factory registrations instead of advancing a complete-looking checkpoint',async()=>{
    const f=await eventRpcFixture();await expect(f.source.capture(f.manifest,f.next,[],f.next)).rejects.toMatchObject({code:'TOKEN_EVENT_REGISTRY_INCOMPLETE'});
  });
  it('verifies legitimate market creation before quoter deployment without weakening current execution proofs',async()=>{
    const f=await eventRpcFixture(),original=f.readRpc.getMockImplementation()!;
    f.readRpc.mockImplementation(async(method,params=[])=>method==='eth_getCode'&&params[0]===f.quoter&&(params[1] as {blockHash:string}).blockHash===f.first.hash?'0x':original(method,params));
    expect((await f.source.capture(f.manifest,f.first,[],f.next)).registrations).toHaveLength(1);
    const {VerifiedTokenSource}=await import('../src/token-source'),current=new VerifiedTokenSource({verification:f.verification,readRpc:f.readRpc});
    await expect(current.verifyMarket(f.manifest,f.market,f.first)).rejects.toMatchObject({code:'TOKEN_CONTRACT_CODE_MISMATCH'});
    expect((await current.verifyMarket(f.manifest,f.market,f.next)).market).toBe(f.market);
  });
  it('rejects missing or tampered historical factory code despite a valid current target',async()=>{
    for(const code of ['0x','0x60026000']){
      const f=await eventRpcFixture(),original=f.readRpc.getMockImplementation()!;
      f.readRpc.mockImplementation(async(method,params=[])=>method==='eth_getCode'&&params[0]===f.factory&&(params[1] as {blockHash:string}).blockHash===f.first.hash?code:original(method,params));
      await expect(f.source.capture(f.manifest,f.first,[],f.next)).rejects.toMatchObject({code:'TOKEN_CONTRACT_CODE_MISMATCH'});
    }
  });
  it('rejects removed, foreign-address, wrong-hash and filter-violating RPC logs',async()=>{
    for(const patch of [{removed:true},{address:a(999)},{blockHash:h(999)},{topics:[h(999)]}]){
      const f=await eventRpcFixture(),original=f.readRpc.getMockImplementation()!;
      f.readRpc.mockImplementation(async(method,params=[])=>method==='eth_getLogs'?[{...f.wire(f.creation.at(-1)!),...patch}]:original(method,params));
      await expect(f.source.capture(f.manifest,f.first,[],f.next)).rejects.toMatchObject({code:'TOKEN_EVENT_RPC_INVALID'});
    }
  });
  it('rejects a block reorg during chunk reads and bounds a stalled read without issuing more calls',async()=>{
    const f=await eventRpcFixture(),original=f.readRpc.getMockImplementation()!;
    f.readRpc.mockImplementation(async(method,params=[])=>{const result=await original(method,params);if(method==='eth_getLogs')f.state.hashes.set(1n,h(999));return result;});
    await expect(f.source.capture(f.manifest,f.first,[],f.next)).rejects.toBeDefined();
    vi.useFakeTimers();const stalled=await eventRpcFixture();stalled.readRpc.mockImplementation(async()=>new Promise(()=>{}));const pending=stalled.source.capture(stalled.manifest,stalled.first,[],stalled.next).catch(error=>error);
    await vi.advanceTimersByTimeAsync(TOKEN_EVENT_LIMITS.timeoutMs+1);expect(await pending).toMatchObject({code:'TOKEN_EVENT_SOURCE_LIMIT'});expect(stalled.readRpc).toHaveBeenCalledTimes(1);
  });
  it('requires explicit bounded operator inputs and refuses malformed limits',()=>{
    expect(parseTokenEventArguments(['--manifest','test.json'])).toEqual({manifest:'test.json',envFile:undefined,maximumBlocks:8,confirmations:2});
    for(const args of [[],['--manifest','x','--max-blocks','33'],['--manifest','x','--confirmations','-1'],['--manifest','x','--max-blocks','01'],['--manifest','x','--watch','true']])expect(()=>parseTokenEventArguments(args)).toThrow('CLI_ARGUMENTS_INVALID');
  });
});
