import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {NextRequest} from 'next/server';
import {createVerifiedRpc,networkConfig,nftExecutionNetwork,type IndexedTokenContext} from '@oneshot/evm';
import {parseTokenManifest,tokenManifestId,tokenManifestJson,type TokenManifest} from '../../../indexer/src/token-manifest';
import {tokenCheckpoint} from '../../../indexer/src/token-store';
import {tokenMarketDto,validateTokenSnapshot} from '../../../indexer/src/token-snapshot';
import {VerifiedTokenSource} from '../../../indexer/src/token-source';
import {isAddress,isHash} from '../../../indexer/src/manifest';
import type {Block} from '../../../indexer/src/types';
import type {SqlPool,SqlClient} from '../../../indexer/src/store';
import {database} from './store';
import {ApiError} from './errors';

type Env=Record<string,string|undefined>;
type TokenCursor={id:string;number:string;hash:string;after:number;q:string;limit:number};
export type TokenReadSource={verify(manifest:TokenManifest,at?:Block):Promise<unknown>;block(number:bigint):Promise<Block>;height():Promise<bigint>};
type Dependencies={env:()=>Env;pool:()=>SqlPool|null;loadManifest:(env:Env)=>Promise<TokenManifest>;source:(env:Env)=>Promise<TokenReadSource>};
const invalid=():never=>{throw new ApiError(503,'TOKEN_INDEXER_DATA_INVALID','Token market records are temporarily unavailable. Please try again shortly.');};
const bad=():never=>{throw new ApiError(400,'TOKEN_INDEXED_INPUT_INVALID','Check the market address, search text or page selection and try again.');};
const stale=():never=>{throw new ApiError(409,'TOKEN_CURSOR_STALE','Token markets have changed. Refresh this list from the beginning.');};
const json=(body:unknown)=>Response.json(body,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
export async function loadTokenManifestFile(path:string){
  const file=await open(resolve(path),'r');try{
    const buffer=Buffer.alloc(16_385);let size=0;
    for(;;){const read=await file.read(buffer,size,buffer.length-size,null);size+=read.bytesRead;if(size>16_384)throw new Error('TOKEN_MANIFEST_INVALID');if(!read.bytesRead)break;}
    return parseTokenManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size))));
  }finally{await file.close();}
}
const defaults:Dependencies={env:()=>process.env,pool:database,loadManifest:env=>loadTokenManifestFile(env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH!),source:async env=>new VerifiedTokenSource(await createVerifiedRpc(networkConfig(env)))};
function selection(request:NextRequest){
  if(request.method!=='GET'&&request.method!=='HEAD')throw new ApiError(405,'METHOD_NOT_ALLOWED','Token market records are read-only.');
  const path=request.nextUrl.pathname.replace(/\/$/,''),prefix='/api/oneshot/token-indexed/markets';
  if(path.length>1024)return bad();
  const detail=path.startsWith(`${prefix}/`)?path.slice(prefix.length+1):null;
  if(path!==prefix&&(detail===null||!isAddress(detail)))throw new ApiError(404,'NOT_FOUND','Token market not found.');
  if(request.nextUrl.search.length>4096)return bad();
  const query=request.nextUrl.searchParams;
  for(const key of query.keys())if(detail||!['limit','cursor','q'].includes(key)||query.getAll(key).length!==1)return bad();
  const rawLimit=query.get('limit')??'20';if(!/^[1-9]\d?$/.test(rawLimit)||Number(rawLimit)>25)return bad();
  const rawQuery=query.get('q')??'';if(rawQuery.length>100||/[\u0000-\u001f\u007f]/.test(rawQuery))return bad();
  const q=rawQuery.trim().toLowerCase(),limit=Number(rawLimit),rawCursor=query.get('cursor');
  let cursor:TokenCursor|null=null;
  if(rawCursor!==null){try{
    if(!rawCursor||rawCursor.length>2048||!/^[\w-]+$/.test(rawCursor))return bad();
    const bytes=Buffer.from(rawCursor,'base64url');if(bytes.toString('base64url')!==rawCursor)return bad();
    const parsed:unknown=JSON.parse(bytes.toString('utf8'));
    if(!object(parsed)||Object.keys(parsed).sort().join(',')!=='after,hash,id,limit,number,q'||typeof parsed.id!=='string'||!/^[a-f0-9]{64}$/.test(parsed.id)
      ||typeof parsed.number!=='string'||!/^(0|[1-9]\d{0,77})$/.test(parsed.number)||!isHash(parsed.hash)||!Number.isInteger(parsed.after)||Number(parsed.after)<0||Number(parsed.after)>24
      ||parsed.limit!==limit||parsed.q!==q)return bad();
    cursor=parsed as TokenCursor;
  }catch(error){if(error instanceof ApiError)throw error;return bad();}}
  return{market:detail?.toLowerCase()??null,q,limit,cursor};
}
const unavailable=(enabled:boolean,reason:string):IndexedTokenContext=>({schemaVersion:1,enabled,available:false,reason,deploymentId:null,network:null,source:null,checkpoint:null,readonly:true,finalized:false,kind:'canonical-contract-snapshot'});
const empty=(context:IndexedTokenContext,market:string|null)=>market?{context,market:null}:{context,items:[],nextCursor:null};
export function createIndexedTokenReader(overrides:Partial<Dependencies>={}){
  const deps={...defaults,...overrides};
  return async(request:NextRequest):Promise<Response>=>{
    const select=selection(request),env={...deps.env()},flag=env.ONESHOT_TOKEN_INDEXER_READS_ENABLED;
    if(flag===undefined||flag===''||flag==='false')return json(empty(unavailable(false,'Token markets are currently unavailable. You can save a token draft and return later.'),select.market));
    if(flag!=='true'||!['local','base-sepolia'].includes(env.ONESHOT_NETWORK??'')||!env.DATABASE_URL||!env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH)throw new ApiError(503,'TOKEN_INDEXER_UNAVAILABLE','Token markets are temporarily unavailable. Please try again later.');
    let client:SqlClient|undefined,began=false;
    try{
      const manifest=await deps.loadManifest(env),id=tokenManifestId(manifest);
      if(manifest.mode!==env.ONESHOT_NETWORK)return invalid();
      const source=await deps.source(env),pool=deps.pool();if(!pool)return invalid();
      client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
      await client.query("SET LOCAL statement_timeout='5000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");
      const deployment=(await client.query('SELECT manifest FROM oneshot_evm_token_deployments WHERE manifest_id=$1',[id])).rows[0];
      const row=(await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text,market_count FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 ORDER BY oneshot_evm_token_checkpoints.block_number DESC LIMIT 1',[id])).rows[0];
      if(!deployment||!row){if(select.cursor)return stale();await client.query('COMMIT');began=false;return json(empty(unavailable(true,'Token market records are being updated. Please try again shortly.'),select.market));}
      if(tokenManifestId(parseTokenManifest(deployment.manifest))!==id)return invalid();
      const block=tokenCheckpoint(row);if(block.number<manifest.startBlock||!Number.isInteger(row.market_count)||Number(row.market_count)<0||Number(row.market_count)>25)return invalid();
      if(select.cursor&&(select.cursor.id!==id||select.cursor.number!==block.number.toString()||select.cursor.hash!==block.hash))return stale();
      await source.verify(manifest,block);
      // The initial worker admits at most25 markets. Validate the complete
      // checkpoint before searching/paging, so a damaged hidden row is never an empty result.
      const rows=(await client.query('SELECT ordinal,market,token,value FROM oneshot_evm_token_market_snapshots WHERE manifest_id=$1 AND block_number=$2::numeric ORDER BY ordinal LIMIT 26',[id,block.number.toString()])).rows;
      if(rows.length!==row.market_count||rows.some((value,index)=>value.ordinal!==index))return invalid();
      const convert=(row:Record<string,unknown>)=>{const market=tokenMarketDto(row.value);if(market.market!==row.market||market.token!==row.token||!Number.isInteger(row.ordinal)||Number(row.ordinal)<0||Number(row.ordinal)>24)return invalid();return market;};
      const markets=validateTokenSnapshot({block,markets:rows.map(convert)}).markets;
      if(select.cursor&&select.cursor.after>=markets.length)return bad();
      const context:IndexedTokenContext={schemaVersion:1,enabled:true,available:true,reason:null,deploymentId:id,network:nftExecutionNetwork(manifest),
        source:{chainId:manifest.chainId,genesisHash:manifest.genesisHash,factory:{...manifest.factory},poolManager:{...manifest.poolManager},oracle:{...manifest.oracle},quoter:{...manifest.quoter}},
        checkpoint:{number:block.number.toString(),hash:block.hash,parentHash:block.parentHash,timestamp:block.timestamp.toString()},readonly:true,finalized:false,kind:'canonical-contract-snapshot'};
      let result:unknown;
      if(select.market){const market=markets.find(value=>value.market===select.market);if(!market)throw new ApiError(404,'TOKEN_MARKET_NOT_FOUND','This token market is not present at the indexed checkpoint.');result={context,market};}
      else{const matches=markets.map((market,ordinal)=>({market,ordinal})).filter(({market,ordinal})=>(!select.cursor||ordinal>select.cursor.after)&&(!select.q||[market.name,market.symbol,market.market,market.token].some(value=>value.toLowerCase().includes(select.q))));
        const page=matches.slice(0,select.limit),items=page.map(value=>value.market);const nextCursor=matches.length>select.limit?Buffer.from(JSON.stringify({id,number:block.number.toString(),hash:block.hash,after:page.at(-1)!.ordinal,q:select.q,limit:select.limit})).toString('base64url'):null;result={context,items,nextCursor};}
      if(await source.height()<block.number||(await source.block(block.number)).hash!==block.hash)throw new ApiError(409,'TOKEN_CHAIN_MOVED','Token markets are being updated after a network change. Please refresh shortly.');
      await client.query('COMMIT');began=false;return json(result);
    }catch(error){if(began)await client?.query('ROLLBACK').catch(()=>undefined);if(error instanceof ApiError)throw error;
      if(object(error)&&error.code==='TOKEN_CHAIN_MOVED')throw new ApiError(409,'TOKEN_CHAIN_MOVED','Token markets are being updated after a network change. Please refresh shortly.');
      throw new ApiError(503,'TOKEN_INDEXER_UNAVAILABLE','Token market records are temporarily unavailable. Please try again later.');}
    finally{client?.release();}
  };
}
export const indexedTokenRead=createIndexedTokenReader();
