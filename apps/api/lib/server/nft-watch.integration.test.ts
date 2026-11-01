import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {Pool} from 'pg';
import {NextRequest} from 'next/server';
import {createPublicClient,createWalletClient,http,type Address,type Hex} from 'viem';
import {anvil} from 'viem/chains';
import {describe,expect,it,vi} from 'vitest';
import {createVerifiedRpc,networkConfig,NFT_COLLECTION_ABI} from '@oneshot/evm';
import {parseManifest,manifestId} from '../../../indexer/src/manifest';
import {VerifiedRpcSource} from '../../../indexer/src/rpc-source';
import {createNftLaunchService,type NftReviewInput} from './nft-launch';
import {createNftLaunchRepository} from './nft-launch-store';
import {createIndexedNftReader} from './indexed-nfts';
import type {OneshotSession} from './oneshot-auth';
import {createIndexedReceiptSync} from '../../../web/lib/client-indexed-sync';
import {startLocalDatabaseKeeper} from '../../../../deploy/local/local-runtime.mjs';

const enabled=process.env.ONESHOT_RUN_NFT_LAUNCH_INTEGRATION==='true';
const databaseUrl=process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const root=path.resolve('.'),testRoot=path.join(root,'.local/nft-watch-integration-tests');
const inherited=():NodeJS.ProcessEnv=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key))),NODE_ENV:'test'});
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,timeout=20_000):Promise<T>{const end=performance.now()+timeout;let last:T|undefined;while(performance.now()<end){try{last=await read();if(accept(last))return last;}catch{}await pause(100);}throw new Error('Owned watcher did not reach the expected canonical state.');}
async function stop(child:ChildProcess|undefined,stdin=false){if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));if(stdin)child.stdin?.end();else child.kill();await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&child.signalCode===null)throw new Error('Owned process did not stop.');}

describe.skipIf(!enabled)('actual continuous local NFT indexing',()=>{
  it('catches receipts, excludes duplicate watchers, resumes after restart and reconciles a replacement fork',async()=>{
    if(!databaseUrl)throw new Error('Explicit dedicated ONESHOT_INDEXER_TEST_DATABASE_URL required.');
    const selected=new URL(databaseUrl);if(!['postgres:','postgresql:'].includes(selected.protocol)||!['127.0.0.1','localhost','[::1]'].includes(selected.hostname)||selected.pathname!=='/oneshot_indexer_test'||selected.search||selected.hash)throw new Error('Dedicated loopback test database required.');
    await mkdir(testRoot,{recursive:true});const directory=await mkdtemp(path.join(testRoot,'case-')),manifestPath=path.join(directory,'manifest.json');
    let fixture:ChildProcess|undefined,watcher:ChildProcess|undefined,duplicate:ChildProcess|undefined,pool:Pool|undefined,keeper:Awaited<ReturnType<typeof startLocalDatabaseKeeper>>=null;
    const owner=`did:privy:watch-${randomUUID()}`,watchLogs:string[]=[];let sync:ReturnType<typeof createIndexedReceiptSync>|undefined;
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('DATABASE_URL','');
    try{
      keeper=await startLocalDatabaseKeeper();
      pool=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:8000,query_timeout:10_000});
      await pool.query(await readFile(path.join(root,'db/schema.sql'),'utf8'));
      fixture=spawn(process.execPath,['--import','tsx',path.join(root,'scripts/local-indexed-fixture.ts'),'--guarded','--database-url',databaseUrl,'--manifest',manifestPath],{cwd:root,env:inherited(),windowsHide:true,stdio:['pipe','pipe','pipe']});
      fixture.on('error',()=>{});fixture.stdout?.resume();fixture.stderr?.resume();fixture.stdin?.on('error',()=>{});
      const state=await until(async()=>JSON.parse(await readFile(`${manifestPath}.state.json`,'utf8')),value=>value.status==='ready',45_000);
      const env:Record<string,string|undefined>={...parseEnv(await readFile(`${manifestPath}.guarded.env`,'utf8')),DATABASE_URL:databaseUrl};
      const manifest=parseManifest(JSON.parse(await readFile(manifestPath,'utf8'))),deploymentId=manifestId(manifest),collection=state.collection as Address;
      const minter=state.wallets.minter as Address,buyer=state.wallets.buyer as Address,creator=state.wallets.creator as Address;
      const rpcUrl=state.rpcUrl as string,client=createPublicClient({chain:anvil,transport:http(rpcUrl,{retryCount:0,timeout:5000})}),wallet=createWalletClient({chain:anvil,transport:http(rpcUrl,{retryCount:0,timeout:5000})});
      const verified=await createVerifiedRpc(networkConfig(env)),source=new VerifiedRpcSource(verified);
      const service=createNftLaunchService({environment:()=>env,loadManifest:async()=>manifest,repository:createNftLaunchRepository({database:()=>pool!})});
      const reader=createIndexedNftReader({env:()=>env,pool:()=>pool!,loadManifest:async()=>manifest,source:async()=>source});
      const read=async(suffix:string)=>{const response=await reader(new NextRequest(`http://localhost/api/oneshot/indexed${suffix}`));if(!response.ok)throw new Error('Indexed state is reconciling.');return response.json();};
      const identity:OneshotSession={provider:'privy',userId:owner,sessionId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+3600,linkedAddresses:[minter]};
      async function act(action:NftReviewInput['action'],fields:Partial<NftReviewInput>={}){
        const review=await service.review({action,from:minter,collection,localEthAcknowledged:true,...fields},identity);
        const fresh=await service.validate(review.id,review.reviewHash,identity);expect(fresh.data).toBe(review.data);
        const hash=await wallet.sendTransaction({account:minter,to:fresh.to,data:fresh.data,value:BigInt(fresh.value)});
        await client.waitForTransactionReceipt({hash,timeout:5000});await service.submitted(review.id,review.reviewHash,hash,identity);
        const receipt=await service.receipt(review.id,hash,identity);expect(receipt.status).toBe('confirmed');return {review,receipt,hash};
      }
      await act('approve',{tokenId:'3'});const listed=await act('list',{tokenId:'3',price:'0.004'});
      const stale=await read(`/collections/${collection}/items/3`);expect(stale.item.owner).toBe(minter);expect(BigInt(stale.context.sync.behindBlocks)).toBeGreaterThanOrEqual(2n);
      const workerEnv={ONESHOT_NETWORK:'local',ONESHOT_RPC_URL:rpcUrl,DATABASE_URL:databaseUrl};
      const envPath=path.join(directory,'watch.env');await writeFile(envPath,Object.entries(workerEnv).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{flag:'wx',mode:0o600});
      function startWatcher(){
        const child=spawn(process.execPath,['--import','tsx',path.join(root,'apps/indexer/src/cli.ts'),'--watch','--env-file',envPath,'--manifest',manifestPath,'--max-blocks','1','--poll-interval-ms','500'],{cwd:root,env:inherited(),windowsHide:true,stdio:['pipe','pipe','pipe']});
        child.once('error',()=>{});child.stdout?.on('data',chunk=>watchLogs.push(String(chunk)));child.stderr?.on('data',chunk=>watchLogs.push(String(chunk)));return child;
      }
      watcher=startWatcher();
      let refreshed=0;sync=createIndexedReceiptSync({context:()=>owner,status:()=>read('/status'),receipt:input=>service.receipt(input.reviewId,input.hash as Hex,identity),refresh:()=>{refreshed++;}});
      sync.start({scope:owner,deploymentId,reviewId:listed.review.id,transactionHash:listed.hash,blockNumber:listed.receipt.blockNumber!,blockHash:listed.receipt.blockHash!});
      await until(async()=>sync!.getSnapshot(),value=>value.phase==='indexed');expect(refreshed).toBe(1);
      expect((await read(`/collections/${collection}/items/3`)).item).toMatchObject({owner:manifest.marketplace.address,listing:{id:'4',status:'active',totalPriceRaw:'4000000000000000'}});
      duplicate=startWatcher();await until(async()=>duplicate!.exitCode,code=>code!==null);expect(duplicate.exitCode).toBe(1);expect(watchLogs.join('')).toContain('WATCH_ALREADY_RUNNING');
      await stop(watcher);watcher=undefined;
      const canceled=await act('cancel',{listingId:'4'});
      const paused=await read(`/collections/${collection}/items/3`);expect(paused.item.listing.status).toBe('active');expect(BigInt(paused.context.sync.behindBlocks)).toBeGreaterThan(0n);
      watcher=startWatcher();
      await until(()=>read(`/collections/${collection}/items/3`),value=>value.item.owner===minter&&value.item.listing===null);
      const rpc=async<T>(method:string,params:unknown[]=[])=>{const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});const body=await response.json();if(body.error)throw new Error('Owned Anvil fixture failed.');return body.result as T;};
      const snapshot=await rpc<string>('evm_snapshot');
      const orphanHash=await wallet.writeContract({account:minter,address:collection,abi:NFT_COLLECTION_ABI,functionName:'transferFrom',args:[minter,creator,3n]});await client.waitForTransactionReceipt({hash:orphanHash,timeout:5000});
      await until(()=>read(`/collections/${collection}/items/3`),value=>value.item.owner===creator);
      expect(await rpc<boolean>('evm_revert',[snapshot])).toBe(true);
      const replacement=await wallet.writeContract({account:minter,address:collection,abi:NFT_COLLECTION_ABI,functionName:'transferFrom',args:[minter,buyer,3n]});await client.waitForTransactionReceipt({hash:replacement,timeout:5000});
      const current=await until(()=>read(`/collections/${collection}/items/3`),value=>value.item.owner===buyer&&value.context.sync.behindBlocks==='0');
      expect(current.context.readonly).toBe(true);expect(current.context.finalized).toBe(false);
      const indexed=await pool.query("SELECT payload FROM oneshot_evm_logs WHERE manifest_id=$1 AND payload->>'transactionHash'=ANY($2::text[])",[deploymentId,[orphanHash,replacement]]);
      expect(indexed.rows.some(row=>row.payload.transactionHash===orphanHash)).toBe(false);expect(indexed.rows.some(row=>row.payload.transactionHash===replacement)).toBe(true);
      const history=await service.recover(canceled.review.id,identity);expect(history.outcome).toBe('confirmed');
      expect(watchLogs.some(line=>line.includes('"rolledBack":1'))).toBe(true);
      for(const secret of [rpcUrl,databaseUrl,minter,buyer,creator,env.ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY,owner])if(secret)expect(watchLogs.join('').toLowerCase()).not.toContain(secret.toLowerCase());
    }finally{
      sync?.cancel();
      try{await stop(duplicate);await stop(watcher);}finally{
        try{await pool?.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_reviews' AND value->>'owner'=$1",[owner]);await pool?.end();}
        finally{try{await stop(fixture,true);if(fixture?.pid){const state=JSON.parse(await readFile(`${manifestPath}.state.json`,'utf8'));expect(state.cleanupSucceeded).toBe(true);expect(state.chainStopped).toBe(true);}}
          finally{await keeper?.stop();vi.unstubAllEnvs();const target=path.resolve(directory);if(path.dirname(target)!==testRoot)throw new Error('Unsafe watch fixture cleanup.');await rm(target,{recursive:true,force:true});}}
      }
    }
  },120_000);
});
