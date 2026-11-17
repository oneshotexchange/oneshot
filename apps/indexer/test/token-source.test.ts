import {afterEach,describe,expect,it,vi} from 'vitest';
import {tokenFixture,tokenHash,tokenAddress} from './token-fixture';
import {parseTokenManifest,tokenManifestId,tokenManifestJson} from '../src/token-manifest';
import {tokenMarketDto,validateTokenSnapshot} from '../src/token-snapshot';
import {PostgresTokenSnapshotStore} from '../src/token-store';
afterEach(()=>vi.useRealTimers());

describe('isolated canonical token manifests and snapshots',()=>{
  it('binds Base identity, all four protocol runtimes and anchors without accepting other chains',()=>{
    const local=tokenFixture(),base=tokenFixture({base:true}),json=tokenManifestJson(base.manifest);
    expect(parseTokenManifest(json)).toEqual(base.manifest);expect(tokenManifestId(base.manifest)).not.toBe(tokenManifestId(local.manifest));
    for(const patch of [{chainId:8453},{chainId:31337},{mode:'zero'},{genesisHash:tokenHash(999)},{quoter:undefined},{extra:true},{poolManager:local.manifest.poolManager}])expect(()=>parseTokenManifest({...json,...patch})).toThrow('TOKEN_MANIFEST_INVALID');
    expect(tokenManifestId(parseTokenManifest({...json,quoter:{...json.quoter,codeHash:tokenHash(999)}}))).not.toBe(tokenManifestId(base.manifest));
  });
  it.each([false,true])('reads a complete exact snapshot on %s Base profile with hash-selected state/code',async base=>{
    const f=tokenFixture({base}),snapshot=await f.source.snapshot(f.manifest);
    expect(snapshot.block).toEqual(f.block(3n));expect(snapshot.markets).toHaveLength(1);
    expect(snapshot.markets[0]).toMatchObject({market:f.market,token:f.token,tokenDecimals:8,initialSupplyRaw:'100000000000000000',totalSupplyRaw:'100000000000000000',executionFeeBps:100,lockedLiquidityRaw:'123456789'});
    for(const [method,params]of f.readRpc.mock.calls)if(method==='eth_call'||method==='eth_getCode')expect(params![1]).toEqual({blockHash:f.block(3n).hash,requireCanonical:true});
    expect(JSON.stringify(snapshot.markets)).not.toMatch(/priceRaw|volume|holders|Aptos|ZRO/);
  });
  it('verifies a registered market for execution callers and detects wrong runtime, registry and immutable references',async()=>{
    const f=tokenFixture({base:true});
    expect((await f.source.verifyMarket(f.manifest,f.market,f.block(3n))).market).toBe(f.market);
    f.state.registered=false;await expect(f.source.verifyMarket(f.manifest,f.market,f.block(3n))).rejects.toMatchObject({code:'TOKEN_MARKET_UNREGISTERED'});
    f.state.registered=true;f.state.marketChainId=31337n;await expect(f.source.verifyMarket(f.manifest,f.market,f.block(3n))).rejects.toMatchObject({code:'TOKEN_MARKET_REFERENCE_MISMATCH'});
    f.state.marketChainId=84532n;f.state.tokenMarket=tokenAddress(999);await expect(f.source.verifyMarket(f.manifest,f.market,f.block(3n))).rejects.toMatchObject({code:'TOKEN_MARKET_REFERENCE_MISMATCH'});
  });
  it('refuses wrong identity, core code and quoter factory before returning usable records',async()=>{
    const f=tokenFixture({base:true});f.verification.chainId=8453;
    await expect(f.source.snapshot(f.manifest)).rejects.toMatchObject({code:'TOKEN_CHAIN_IDENTITY_MISMATCH'});
    f.verification.chainId=84532;f.state.codeOverrides.set(f.oracle,'0x');
    await expect(f.source.snapshot(f.manifest)).rejects.toMatchObject({code:'TOKEN_CONTRACT_CODE_MISMATCH'});
    f.state.codeOverrides.clear();f.state.quoterFactory=tokenAddress(999);
    await expect(f.source.snapshot(f.manifest)).rejects.toMatchObject({code:'TOKEN_PROTOCOL_REFERENCE_MISMATCH'});
  });
  it('rejects a reorg during snapshot reads and fails a bounded scan rather than reporting zero',async()=>{
    const f=tokenFixture();f.state.reorgDuringSupply=true;
    await expect(f.source.snapshot(f.manifest)).rejects.toMatchObject({code:'TOKEN_CHAIN_MOVED'});
    f.state.reorgDuringSupply=false;f.state.hashes.clear();f.state.count=26n;
    await expect(f.source.snapshot(f.manifest,25)).rejects.toMatchObject({code:'TOKEN_SOURCE_LIMIT'});
  });
  it('keeps successful empty scans distinct from invalid amounts, supplies, duplicates and extra private properties',async()=>{
    const f=tokenFixture(),snapshot=await f.source.snapshot(f.manifest),row=snapshot.markets[0];
    const clean=tokenMarketDto({...row,privateEndpoint:'https://private'});expect(clean).not.toHaveProperty('privateEndpoint');
    for(const patch of [{totalSupplyRaw:'01'},{totalSupplyRaw:'100000000000000001'},{lockedLiquidityRaw:'0'},{tokenDecimals:18},{executionFeeBps:101},{poolId:'bad'}])expect(()=>tokenMarketDto({...row,...patch})).toThrow('TOKEN_DATA_INVALID');
    expect(()=>validateTokenSnapshot({...snapshot,markets:[row,row]})).toThrow('TOKEN_DATA_INVALID');
    f.state.count=0n;expect((await f.source.snapshot(f.manifest)).markets).toEqual([]);
  });
  it('bounds a stalled source and never issues another read after the deadline',async()=>{
    vi.useFakeTimers();const f=tokenFixture();f.readRpc.mockImplementation(async()=>new Promise(()=>{}));
    const result=f.source.snapshot(f.manifest).catch(error=>error);await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({code:'TOKEN_SOURCE_LIMIT'});expect(f.readRpc).toHaveBeenCalledOnce();
  });
  it('rejects an invalid checkpoint before checking out a database connection',async()=>{
    const f=tokenFixture(),snapshot=await f.source.snapshot(f.manifest),connect=vi.fn(async()=>{throw new Error('Unexpected checkout');});
    const store=new PostgresTokenSnapshotStore({connect});
    await expect(store.commit(f.manifest,{...snapshot,block:{...snapshot.block,number:0n}},null,null)).rejects.toMatchObject({code:'TOKEN_CHECKPOINT_INVALID'});
    await expect(store.commit(f.manifest,snapshot,null,{...snapshot.block,number:4n})).rejects.toMatchObject({code:'TOKEN_CHECKPOINT_INVALID'});
    expect(connect).not.toHaveBeenCalled();
  });
  it('verifies public wallet balances only against registered tokens at the exact canonical hash',async()=>{
    const f=tokenFixture({base:true}),wallet=tokenAddress(99);f.state.walletBalance=123n;
    const result=await f.source.verifyWalletBalances(f.manifest,[f.market],wallet,f.block(3n));expect(result[0]).toMatchObject({market:{market:f.market,token:f.token},balanceRaw:'123'});
    for(const[method,params]of f.readRpc.mock.calls)if(method==='eth_call'||method==='eth_getCode')expect(params![1]).toEqual({blockHash:f.block(3n).hash,requireCanonical:true});
    f.state.registered=false;await expect(f.source.verifyWalletBalances(f.manifest,[f.market],wallet,f.block(3n))).rejects.toMatchObject({code:'TOKEN_MARKET_UNREGISTERED'});
    f.state.registered=true;f.state.walletBalance=f.state.totalSupply+1n;await expect(f.source.verifyWalletBalances(f.manifest,[f.market],wallet,f.block(3n))).rejects.toMatchObject({code:'TOKEN_WALLET_BALANCE_INVALID'});
    await expect(f.source.verifyWalletBalances(f.manifest,Array(6).fill(f.market),wallet,f.block(3n))).rejects.toMatchObject({code:'TOKEN_SOURCE_LIMIT'});
  });
});
