import {afterEach,describe,expect,it,vi} from 'vitest';
import {BASE_SEPOLIA_GENESIS_HASH} from '@oneshot/evm';
import {verifyBaseSepoliaReadOnly} from './verify-base-sepolia';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture() {
  const state={chain:'0x14a34',badSafe:false,reorg:false};
  const fetch=vi.fn<typeof globalThis.fetch>(async(_input,init)=>{
    const body=JSON.parse(init!.body as string);
    let result:unknown;
    if(body.method==='eth_chainId')result=state.chain;
    else if(body.method==='eth_blockNumber')result='0x64';
    else if(body.method==='eth_getBlockByNumber') {
      const tag=body.params[0],n=tag==='latest'?100:tag==='safe'?90:tag==='finalized'?80:Number(BigInt(tag));
      result={number:`0x${n.toString(16)}`,hash:n===0?BASE_SEPOLIA_GENESIS_HASH:state.reorg&&tag==='0x5a'?hash(999):hash(n),parentHash:hash(Math.max(0,n-1)),timestamp:'0x1'};
      if(state.badSafe&&tag==='safe')result=null;
    } else throw new Error('Unexpected method');
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  });
  return{state,fetch};
}
afterEach(()=>vi.useRealTimers());
describe('bounded Base Sepolia read-only network evidence',()=>{
  it('tests canonical checkpoint methods without implying NFT/AMM execution was tested',async()=>{
    const f=fixture(),result=await verifyBaseSepoliaReadOnly({ONESHOT_NETWORK:'base-sepolia'},{fetch:f.fetch});
    expect(result).toMatchObject({status:'passed',chainId:84532,genesisHash:BASE_SEPOLIA_GENESIS_HASH,readOnly:true,executionEnabled:false,requests:21});
    expect(result.untested).toContain('NFT deployment');
    expect(f.fetch.mock.calls.every(([,init])=>['eth_chainId','eth_blockNumber','eth_getBlockByNumber'].includes(JSON.parse(init!.body as string).method))).toBe(true);
  });
  it.each([{ONESHOT_NETWORK:'zero'},{ONESHOT_NETWORK:'local'},{ONESHOT_NETWORK:'base-sepolia',ONESHOT_CHAIN_ID:'8453'}])('rejects a wrong profile before any request',async env=>{
    const f=fixture();await expect(verifyBaseSepoliaReadOnly(env,{fetch:f.fetch})).rejects.toMatchObject({code:'CONFIG_INVALID'});expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['badSafe','reorg'] as const)('fails closed on %s',async field=>{
    const f=fixture();f.state[field]=true;
    await expect(verifyBaseSepoliaReadOnly({ONESHOT_NETWORK:'base-sepolia'},{fetch:f.fetch})).rejects.toMatchObject({code:'RPC_RESPONSE_INVALID'});
  });
  it('rejects mainnet identity and redacts unexpected transport errors',async()=>{
    const f=fixture();f.state.chain='0x2105';
    await expect(verifyBaseSepoliaReadOnly({ONESHOT_NETWORK:'base-sepolia'},{fetch:f.fetch})).rejects.toMatchObject({code:'CHAIN_ID_MISMATCH'});
    const error=await verifyBaseSepoliaReadOnly({ONESHOT_NETWORK:'base-sepolia'},{fetch:async()=>{throw new Error('https://private-secret');}}).catch(error=>error);
    expect(String(error)).not.toContain('private-secret');
  });
  it('aborts a transport that never settles and never sends subsequent calls',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const fetch=vi.fn<typeof globalThis.fetch>(async(_input,init)=>{signal=init!.signal!;return new Promise(()=>{});});
    const result=verifyBaseSepoliaReadOnly({ONESHOT_NETWORK:'base-sepolia'},{fetch}).catch(error=>error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({code:'RPC_TIMEOUT'});expect(signal?.aborted).toBe(true);expect(fetch).toHaveBeenCalledOnce();
  });
});
