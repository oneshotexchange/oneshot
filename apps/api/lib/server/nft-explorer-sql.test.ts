import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {acquireNftExplorerSql,NFT_EXPLORER_SQL_TIMEOUT_MS} from './nft-explorer-sql';
import {createIndexedNftReader} from './indexed-nfts';
import {api} from './http';
import {parseManifest} from '../../../indexer/src/manifest';
import type {QueryResult,SqlClient,SqlPool} from '../../../indexer/src/store';

const empty:QueryResult={rows:[],rowCount:0};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('bounded explorer SQL lease',()=>{
  it('uses one ordinary release after successful queries and ignores later abort/release attempts',async()=>{
    vi.useFakeTimers();const controller=new AbortController(),query=vi.fn(async()=>empty),release=vi.fn(),connect=vi.fn(async()=>({query,release}));
    const lease=await acquireNftExplorerSql({connect},controller.signal);expect(await lease.query('BEGIN')).toBe(empty);expect(await lease.query('COMMIT')).toBe(empty);
    lease.release();lease.release();controller.abort();await vi.advanceTimersByTimeAsync(NFT_EXPLORER_SQL_TIMEOUT_MS+1);
    expect(release).toHaveBeenCalledExactlyOnceWith();expect(connect).toHaveBeenCalledOnce();
    await expect(lease.query('SELECT 1')).rejects.toMatchObject({code:'NFT_EXPLORER_TIMEOUT'});expect(query).toHaveBeenCalledTimes(2);
  });
  it('times out a stalled acquisition and destroys its late leased client exactly once',async()=>{
    vi.useFakeTimers();const late=deferred<SqlClient>(),started=deferred<void>(),query=vi.fn(async()=>empty),release=vi.fn();
    const pending=acquireNftExplorerSql({connect:async()=>{started.resolve();return late.promise;}}).catch(error=>error);await started.promise;
    await vi.advanceTimersByTimeAsync(NFT_EXPLORER_SQL_TIMEOUT_MS+1);expect(await pending).toMatchObject({status:504,code:'NFT_EXPLORER_TIMEOUT'});expect(release).not.toHaveBeenCalled();
    late.resolve({query,release});await vi.advanceTimersByTimeAsync(0);expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query).not.toHaveBeenCalled();
  });
  it('does no pool work for an already aborted request and preserves non-abort acquisition errors',async()=>{
    const controller=new AbortController();controller.abort();const connect=vi.fn(async()=>({query:async()=>empty,release:()=>{}}));
    await expect(acquireNftExplorerSql({connect},controller.signal)).rejects.toMatchObject({code:'NFT_EXPLORER_TIMEOUT'});expect(connect).not.toHaveBeenCalled();
    const error=new Error('Original internal acquisition failure');await expect(acquireNftExplorerSql({connect:async()=>{throw error;}})).rejects.toBe(error);
  });
  it('destroys a stalled query on abort and rejects rollback immediately without queuing more driver work',async()=>{
    vi.useFakeTimers();const controller=new AbortController(),late=deferred<QueryResult>(),started=deferred<void>(),query=vi.fn(async()=>{started.resolve();return late.promise;}),release=vi.fn();
    const lease=await acquireNftExplorerSql({connect:async()=>({query,release})},controller.signal),pending=lease.query('SELECT catalog').catch(error=>error);await started.promise;controller.abort();
    expect(await pending).toMatchObject({status:504,code:'NFT_EXPLORER_TIMEOUT'});expect(release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(lease.query('ROLLBACK')).rejects.toMatchObject({code:'NFT_EXPLORER_TIMEOUT'});lease.release();lease.release();
    late.resolve(empty);await vi.advanceTimersByTimeAsync(0);expect(query).toHaveBeenCalledExactlyOnceWith('SELECT catalog',undefined);expect(release).toHaveBeenCalledOnce();
  });
  it('bounds a stalled rollback using the original lease deadline',async()=>{
    vi.useFakeTimers();const late=deferred<QueryResult>(),started=deferred<void>(),error=new Error('Original statement failure'),release=vi.fn();
    const query=vi.fn(async(sql:string)=>{if(sql==='ROLLBACK'){started.resolve();return late.promise;}throw error;});
    const lease=await acquireNftExplorerSql({connect:async()=>({query,release})});await expect(lease.query('SELECT catalog')).rejects.toBe(error);
    const rollback=lease.query('ROLLBACK').catch(error=>error);await started.promise;await vi.advanceTimersByTimeAsync(NFT_EXPLORER_SQL_TIMEOUT_MS+1);
    expect(await rollback).toMatchObject({status:504,code:'NFT_EXPLORER_TIMEOUT'});lease.release();late.reject(new Error('Late private transport error'));await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query).toHaveBeenCalledTimes(2);
  });
  it('allows normal rollback and preserves an original statement error when no deadline expired',async()=>{
    const error=new Error('Original statement failure'),release=vi.fn(),query=vi.fn(async(sql:string)=>{if(sql==='SELECT catalog')throw error;return empty;});
    const lease=await acquireNftExplorerSql({connect:async()=>({query,release})});await expect(lease.query('SELECT catalog')).rejects.toBe(error);expect(await lease.query('ROLLBACK')).toBe(empty);lease.release();expect(release).toHaveBeenCalledExactlyOnceWith();
  });
  it('keeps a destruction failure out of abort callbacks and still reports only the customer timeout',async()=>{
    const controller=new AbortController(),release=vi.fn(()=>{throw new Error('Private driver destruction detail');}),lease=await acquireNftExplorerSql({connect:async()=>({query:async()=>new Promise(()=>{}),release})},controller.signal);
    const pending=lease.query('SELECT catalog').catch(error=>error);await Promise.resolve();controller.abort();const result=await pending;expect(result).toMatchObject({code:'NFT_EXPLORER_TIMEOUT'});expect(result.message).not.toContain('Private');expect(()=>lease.release()).not.toThrow();expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

const hash=(number:number)=>`0x${number.toString(16).padStart(64,'0')}` as const,address=(number:number)=>`0x${number.toString(16).padStart(40,'0')}` as const;
function reader(pool:SqlPool){
  const manifest=parseManifest({schemaVersion:1,deploymentVersion:'oneshot-nft-v1',mode:'local',chainId:31337,genesisHash:hash(1),startBlock:'1',anchorHash:hash(1),factory:{address:address(1),codeHash:hash(2)},marketplace:{address:address(2),codeHash:hash(3)}});
  const read=createIndexedNftReader({env:()=>({ONESHOT_INDEXER_READS_ENABLED:'true',ONESHOT_NETWORK:'local',DATABASE_URL:'injected-disposable-only',ONESHOT_INDEXER_MANIFEST_PATH:'injected-fixture-only'}),pool:()=>pool,loadManifest:async()=>manifest,source:async()=>({verify:async()=>{},height:async()=>1n,block:async()=>({number:1n,hash:hash(2),parentHash:hash(1),timestamp:1n}),logs:async()=>[]})});
  return(path:string)=>api(request=>read(request))(new NextRequest(`http://localhost/api/oneshot/indexed${path}`),{});
}
describe('explorer-only indexed API lease integration',()=>{
  it('returns a safe timeout after a held driver read stalls without waiting for a queued rollback',async()=>{
    vi.useFakeTimers();const late=deferred<QueryResult>(),started=deferred<void>(),release=vi.fn();
    const query=vi.fn(async(sql:string)=>{if(sql.startsWith('SELECT j.block_number')){started.resolve();return late.promise;}return empty;});
    const read=reader({connect:async()=>({query,release})}),pending=read(`/collections/${address(3)}/explore`);await started.promise;await vi.advanceTimersByTimeAsync(NFT_EXPLORER_SQL_TIMEOUT_MS+1);
    const response=await pending;expect(response.status).toBe(504);expect(await response.json()).toMatchObject({error:{code:'NFT_EXPLORER_TIMEOUT',message:expect.stringContaining('try again')}});expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(false);
    late.resolve(empty);await vi.advanceTimersByTimeAsync(0);expect(release).toHaveBeenCalledOnce();
  });
  it('leaves the existing collection resource on its ordinary pool acquisition path',async()=>{
    vi.useFakeTimers();const late=deferred<SqlClient>(),started=deferred<void>(),release=vi.fn(),query=vi.fn(async()=>empty);
    const read=reader({connect:async()=>{started.resolve();return late.promise;}}),pending=read('/collections');await started.promise;await vi.advanceTimersByTimeAsync(NFT_EXPLORER_SQL_TIMEOUT_MS+1);expect(release).not.toHaveBeenCalled();
    late.resolve({query,release});const response=await pending;expect(response.status).toBe(200);expect((await response.json()).context.available).toBe(false);expect(release).toHaveBeenCalledExactlyOnceWith();
  });
});
