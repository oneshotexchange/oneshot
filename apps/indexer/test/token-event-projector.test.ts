import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {zeroAddress} from 'viem';
import {tokenAddress as a,tokenHash as h} from './token-fixture';
import {analyticsFixture,analyticsLog,MemoryTokenEventAdapter,parseEvidenceBlock,evidenceRegistrations} from './token-event-fixture';
import {parseTokenManifest} from '../src/token-manifest';
import type {TokenMarketAnalytics} from '../src/token-event-types';

describe('canonical token event projector',()=>{
  it('discovers before constructor logs and tracks pool volume once across oneshot and external routes',async()=>{
    const f=await analyticsFixture();await f.store.apply(f.manifest,f.first,f.creation,[f.registered]);
    expect(f.store.get('markets',f.market)).toMatchObject({observedSupplyRaw:f.supply.toString(),holderCount:'2',initialized:true,initialMintSeen:true,poolNativeVolumeRaw:'0',sqrtPriceX96Raw:(1n<<96n).toString()});
    await f.store.apply(f.manifest,f.next,f.swaps);
    const market=f.store.get('markets',f.market)!;
    expect(market).toMatchObject({poolSwaps:'2',poolNativeVolumeRaw:'1010',poolTokenVolumeRaw:'102',oneshotTrades:'1',oneshotGrossNativeVolumeRaw:'1000',oneshotExecutionFeesRaw:'10',holderCount:'3',sqrtPriceX96Raw:((1n<<96n)+1n).toString(),priceBlockHash:f.next.hash});
    expect(f.store.get('balances',`${f.token}:${f.buyer}`)?.balanceRaw).toBe('98');
    expect(f.store.get('events',`${h(201)}:4`)).toMatchObject({kind:'pool-swap',poolSender:f.router,trader:null,recipient:null});
  });
  it('counts true burns and balance transitions including self/zero transfers and dead-address holders',async()=>{
    const f=await analyticsFixture();await f.store.apply(f.manifest,f.first,f.creation,[f.registered]);await f.store.apply(f.manifest,f.next,f.swaps);
    const block=f.block(3),dead='0x000000000000000000000000000000000000dead' as const;
    const transfer=(from:typeof f.buyer,to:typeof f.buyer,value:bigint,index:number)=>analyticsLog(block,f.token,'Transfer',{from,to,value},index);
    await f.store.apply(f.manifest,block,[transfer(f.buyer,f.buyer,10n,0),transfer(f.buyer,f.other,40n,1),transfer(f.buyer,zeroAddress,8n,2),transfer(f.buyer,dead,10n,3),transfer(a(99),a(99),0n,4)]);
    expect(f.store.get('markets',f.market)).toMatchObject({observedSupplyRaw:(f.supply-8n).toString(),burnedRaw:'8',holderCount:'5'});
    expect(f.store.get('wallets',f.buyer)?.holdingsCount).toBe('1');expect(f.store.get('wallets',a(99))?.holdingsCount).toBe('0');
    expect(f.store.get('balances',`${f.token}:${f.buyer}`)?.balanceRaw).toBe('40');expect(f.store.get('balances',`${f.token}:${dead}`)?.balanceRaw).toBe('10');
    await f.store.apply(f.manifest,f.block(4),[analyticsLog(f.block(4),f.token,'Transfer',{from:f.other,to:zeroAddress,value:40n},0)]);
    expect(f.store.get('markets',f.market)).toMatchObject({burnedRaw:'48',holderCount:'4'});
    expect(f.store.get('wallets',f.other)?.holdingsCount).toBe('0');
  });
  it('retains exact cumulative volumes above uint256 and ignores unrelated pool/token activity',async()=>{
    const f=await analyticsFixture();await f.store.apply(f.manifest,f.first,f.creation,[f.registered]);const record=f.store.get('markets',f.market)!;
    record.poolNativeVolumeRaw=(2n**256n-1n).toString();f.store.state.set(`markets:${f.market}`,record);
    await f.store.apply(f.manifest,f.next,[...f.swaps,analyticsLog(f.next,f.poolManager,'Swap',{id:h(999),sender:f.router,amount0:999n,amount1:-1n,sqrtPriceX96:1n<<96n,liquidity:1n,tick:0,fee:2500},5,2),analyticsLog(f.next,a(999),'Transfer',{from:zeroAddress,to:f.buyer,value:123n},6,2)]);
    expect(f.store.get('markets',f.market)?.poolNativeVolumeRaw).toBe((2n**256n-1n+1010n).toString());
  });
  it('fails malformed provenance, duplicate logs, incomplete creation and impossible balances atomically',async()=>{
    const f=await analyticsFixture();
    await expect(f.store.apply(f.manifest,f.first,f.creation,[])).rejects.toMatchObject({code:'TOKEN_EVENT_REGISTRATION_INVALID'});expect(f.store.state.size).toBe(0);
    await expect(f.store.apply(f.manifest,f.first,f.creation.filter(log=>log.logIndex!==1),[f.registered])).rejects.toMatchObject({code:'TOKEN_EVENT_CREATION_INCOMPLETE'});expect(f.store.state.size).toBe(0);
    await f.store.apply(f.manifest,f.first,f.creation,[f.registered]);const before=structuredClone(f.store.state);
    for(const logs of [[...f.swaps,f.swaps[0]],[{...f.swaps[0],blockHash:h(999)}],[analyticsLog(f.next,f.token,'Transfer',{from:f.buyer,to:f.other,value:1n},0)]]){
      await expect(f.store.apply(f.manifest,f.next,logs)).rejects.toBeDefined();expect(f.store.state).toEqual(before);
    }
  });
  it('replays actual isolated-Anvil constructor, swaps, transfers and burns without fabricated external identities',async()=>{
    const fixture=JSON.parse(await readFile(new URL('./fixtures/token-event-rehearsal.json',import.meta.url),'utf8'));
    const manifest=parseTokenManifest(fixture.manifest),store=new MemoryTokenEventAdapter();
    for(const raw of fixture.blocks){const{block,logs}=parseEvidenceBlock(raw);await store.apply(manifest,block,logs,evidenceRegistrations(manifest,block,logs,fixture.registrations));}
    const markets=fixture.registrations.map((proof:Record<string,unknown>)=>store.get('markets',proof.market as string) as TokenMarketAnalytics);
    expect(markets).toHaveLength(2);expect(markets[0].poolSwaps).not.toBe('0');expect(markets[0].oneshotTrades).not.toBe('0');expect(BigInt(markets[0].burnedRaw)).toBeGreaterThan(0n);
    for(const market of markets){let sum=0n,holders=0n;for(const[key,value]of store.state)if(key.startsWith(`balances:${market.token}:`)){sum+=BigInt(value.balanceRaw as string);if(BigInt(value.balanceRaw as string)>0n)holders++;}
      expect(sum.toString()).toBe(market.observedSupplyRaw);expect(holders.toString()).toBe(market.holderCount);expect(BigInt(market.mintedRaw)-BigInt(market.burnedRaw)).toBe(BigInt(market.observedSupplyRaw));}
    for(const[key,value]of store.state)if(key.startsWith('events:')&&value.kind==='pool-swap')expect(value).toMatchObject({trader:null,recipient:null});
  });
});
