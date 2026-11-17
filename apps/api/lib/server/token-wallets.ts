import type {NextRequest} from 'next/server';
import {createVerifiedRpc,networkConfig,nftExecutionNetwork,type IndexedTokenMarket,type TokenAnalyticsContext,type TokenWalletHolding} from '@oneshot/evm';
import type {Address} from 'viem';
import {loadTokenManifestFile} from './indexed-tokens';
import {database} from './store';
import {ApiError} from './errors';
import {VerifiedTokenSource} from '../../../indexer/src/token-source';
import {parseTokenManifest,tokenManifestId,type TokenManifest} from '../../../indexer/src/token-manifest';
import {tokenCheckpoint} from '../../../indexer/src/token-store';
import {tokenMarketDto} from '../../../indexer/src/token-snapshot';
import {tokenMarketAnalytics} from '../../../indexer/src/token-event-projector';
import {isAddress,isHash} from '../../../indexer/src/manifest';
import type {Block} from '../../../indexer/src/types';
import type {SqlPool,SqlClient} from '../../../indexer/src/store';

type Env=Record<string,string|undefined>;
type Source={verify(manifest:TokenManifest,block?:Block):Promise<unknown>;verifyWalletBalances(manifest:TokenManifest,markets:readonly Address[],wallet:Address,block:Block):Promise<{market:IndexedTokenMarket;balanceRaw:string}[]>;height():Promise<bigint>;block(number:bigint):Promise<Block>};
type Dependencies={env:()=>Env;pool:()=>SqlPool|null;loadManifest:(env:Env)=>Promise<TokenManifest>;source:(env:Env)=>Promise<Source>};
type Cursor={id:string;number:string;hash:string;wallet:string;limit:number;after:string};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=():never=>{throw new ApiError(503,'TOKEN_WALLET_UNAVAILABLE','Token balances are temporarily unavailable. Please try again shortly.');};
const bad=():never=>{throw new ApiError(400,'TOKEN_WALLET_INPUT_INVALID','Check the wallet address or page selection and try again.');};
const stale=():never=>{throw new ApiError(409,'TOKEN_WALLET_CURSOR_STALE','Token balances have changed. Refresh this list from the beginning.');};
const moved=():never=>{throw new ApiError(409,'TOKEN_CHAIN_MOVED','Token balances are being updated after a network change. Please refresh shortly.');};
const decimal=(value:unknown):string=>typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<2n**256n?value:invalid();
const address=(value:unknown):Address=>isAddress(value)&&!/^0x0{40}$/i.test(value)?value.toLowerCase() as Address:invalid();
const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const defaults:Dependencies={env:()=>process.env,pool:database,loadManifest:env=>loadTokenManifestFile(env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH!),source:async env=>new VerifiedTokenSource(await createVerifiedRpc(networkConfig(env)))};
function selection(request:NextRequest){
  if(request.method!=='GET'&&request.method!=='HEAD')throw new ApiError(405,'METHOD_NOT_ALLOWED','Wallet balances are read-only.');
  const parts=request.nextUrl.pathname.replace(/\/$/,'').split('/'),wallet=parts[5]?.toLowerCase();
  if(request.nextUrl.pathname.length>1024||request.nextUrl.search.length>4096)return bad();
  if(parts.length!==6||parts.slice(0,5).join('/')!=='/api/oneshot/token-analytics/wallets'||!isAddress(wallet)||/^0x0{40}$/i.test(wallet))throw new ApiError(404,'NOT_FOUND','Wallet balances not found.');
  const query=request.nextUrl.searchParams;for(const key of query.keys())if(!['limit','cursor'].includes(key)||query.getAll(key).length!==1)return bad();
  const rawLimit=query.get('limit')??'3';if(!/^[2-5]$/.test(rawLimit))return bad();const limit=Number(rawLimit);let cursor:Cursor|null=null;const raw=query.get('cursor');
  if(raw!==null){try{
    if(!raw||raw.length>2048||!/^[\w-]+$/.test(raw))return bad();const bytes=Buffer.from(raw,'base64url');if(bytes.toString('base64url')!==raw)return bad();const value:unknown=JSON.parse(bytes.toString('utf8'));
    if(!object(value)||Object.keys(value).sort().join(',')!=='after,hash,id,limit,number,wallet'||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||typeof value.number!=='string'||!/^(0|[1-9]\d{0,77})$/.test(value.number)||BigInt(value.number)>=2n**256n||!isHash(value.hash)||value.wallet!==wallet||value.limit!==limit||typeof value.after!=='string'||!/^0x[\da-f]{40}$/.test(value.after))return bad();cursor=value as Cursor;
  }catch(error){if(error instanceof ApiError)throw error;return bad();}}
  return{wallet:wallet as Address,limit,cursor};
}
function unavailable(enabled:boolean):TokenAnalyticsContext{return{schemaVersion:1,kind:'canonical-event-journal',enabled,available:false,reason:enabled?'Token balances are being updated. Please try again shortly.':'Token balances are currently unavailable. You can return to your portfolio later.',deploymentId:null,network:null,source:null,checkpoint:null,observedHeadNumber:null,lagBlocks:null,readonly:true,finalized:false};}
export function createTokenWalletReader(overrides:Partial<Dependencies>={}){
  const deps={...defaults,...overrides};
  return async(request:NextRequest):Promise<Response>=>{
    const select=selection(request),env={...deps.env()},empty=(enabled:boolean)=>json({context:unavailable(enabled),wallet:select.wallet,scope:'registered-token-markets',holdingCount:null,items:[],nextCursor:null}),flag=env.ONESHOT_TOKEN_ANALYTICS_READS_ENABLED;
    if(flag===undefined||flag===''||flag==='false')return empty(false);
    if(flag!=='true'||!['local','base-sepolia'].includes(env.ONESHOT_NETWORK??'')||!env.DATABASE_URL||!env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH)return invalid();
    let client:SqlClient|undefined,began=false;
    try{
      const manifest=await deps.loadManifest(env),id=tokenManifestId(manifest);if(manifest.mode!==env.ONESHOT_NETWORK)return invalid();const source=await deps.source(env),pool=deps.pool();if(!pool)return invalid();
      client=await pool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await client.query("SET LOCAL statement_timeout='5000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");
      const deployment=(await client.query('SELECT manifest FROM oneshot_evm_token_event_deployments WHERE manifest_id=$1',[id])).rows[0];
      const head=(await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_token_event_journal.block_number DESC LIMIT 1',[id])).rows[0];
      if(!deployment||!head){if(select.cursor)return stale();await client.query('COMMIT');began=false;return empty(true);}
      if(tokenManifestId(parseTokenManifest(deployment.manifest))!==id)return invalid();const block=tokenCheckpoint(head);if(block.number<manifest.startBlock)return invalid();
      if(select.cursor&&(select.cursor.id!==id||select.cursor.number!==block.number.toString()||select.cursor.hash!==block.hash))return stale();
      // Older producer journals remain readable by the market APIs but cannot be
      // presented as complete wallet inventories. Never migrate or reset on read.
      if((await client.query('SELECT 1 FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND producer_version<>2 LIMIT 1',[id])).rows.length)return invalid();
      const summary=(await client.query("SELECT value FROM oneshot_evm_token_event_wallets WHERE manifest_id=$1 AND kind='wallets' AND entity_id=$2",[id,select.wallet])).rows[0]?.value;
      const countRow=(await client.query("SELECT count(*)::text AS count FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'wallet'=$2 AND (value->>'balanceRaw')::numeric>0",[id,select.wallet])).rows[0];
      const count=decimal(countRow?.count);if(BigInt(count)>1024n)return invalid();
      if(summary){
        if(!object(summary)||summary.schemaVersion!==1||summary.wallet!==select.wallet||decimal(summary.holdingsCount)!==count||BigInt(decimal(summary.lastBlockNumber))>block.number||!isHash(summary.lastBlockHash))return invalid();
        const anchor=(await client.query('SELECT block_hash FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND block_number=$2::numeric',[id,summary.lastBlockNumber])).rows[0];if(anchor?.block_hash!==summary.lastBlockHash)return invalid();
      }else if(count!=='0')return invalid();
      const rows=(await client.query("SELECT p.entity_id,p.value,m.entity_id AS market_id,m.value AS market_value,j.block_number::text,j.block_hash FROM oneshot_evm_token_event_projections p LEFT JOIN oneshot_evm_token_event_projections m ON m.manifest_id=p.manifest_id AND m.kind='markets' AND m.value->>'token'=p.value->>'token' LEFT JOIN oneshot_evm_token_event_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'lastBlockNumber')::numeric WHERE p.manifest_id=$1 AND p.kind='balances' AND p.value->>'wallet'=$2 AND (p.value->>'balanceRaw')::numeric>0 AND ($3::text IS NULL OR p.value->>'token'>$3) ORDER BY p.value->>'token' LIMIT $4",[id,select.wallet,select.cursor?.after??null,select.limit+1])).rows;
      const candidates=rows.map(row=>{
        if(!object(row.value)||!object(row.market_value))return invalid();const value=row.value,token=address(value.token),market=address(row.market_id),balanceRaw=decimal(value.balanceRaw),lastBalanceBlockNumber=decimal(value.lastBlockNumber);
        if(value.schemaVersion!==1||value.wallet!==select.wallet||row.entity_id!==`${token}:${select.wallet}`||balanceRaw==='0'||BigInt(lastBalanceBlockNumber)>block.number||row.block_number!==lastBalanceBlockNumber||!isHash(value.lastBlockHash)||row.block_hash!==value.lastBlockHash)return invalid();
        const analytics=tokenMarketAnalytics(row.market_value,manifest,market);if(analytics.token!==token||!analytics.initialized||!analytics.initialMintSeen||BigInt(analytics.lastBlockNumber)>block.number||BigInt(analytics.createdBlockNumber)<manifest.startBlock||BigInt(balanceRaw)>BigInt(analytics.observedSupplyRaw))return invalid();
        return{token,market,balanceRaw,lastBalanceBlockNumber,lastBalanceBlockHash:value.lastBlockHash,analytics};
      });
      if(candidates.some((value,index)=>index>0&&value.token<=candidates[index-1].token)||!select.cursor&&candidates.length!==Number(BigInt(count)>BigInt(select.limit)?BigInt(select.limit+1):BigInt(count)))return invalid();
      const page=candidates.slice(0,select.limit),proofs=page.length?await source.verifyWalletBalances(manifest,page.map(value=>value.market),select.wallet,block):[];
      if(!page.length)await source.verify(manifest,block);if(!Array.isArray(proofs)||proofs.length!==page.length)return invalid();
      const items:TokenWalletHolding[]=[];
      for(let index=0;index<page.length;index++){
        const candidate=page[index],proof=proofs[index],market=tokenMarketDto(proof.market),analytics=candidate.analytics;
        if(market.market!==candidate.market||market.token!==candidate.token||decimal(proof.balanceRaw)!==candidate.balanceRaw||market.totalSupplyRaw!==analytics.observedSupplyRaw)return invalid();
        for(const key of ['creator','poolId','executionFeeBps','liquidityAndBurn','tokenDecimals','initialSupplyRaw','observedMarketCodeHash','observedTokenCodeHash'] as const)if(analytics[key]!==market[key])return invalid();
        const positions=[{number:analytics.createdBlockNumber,hash:analytics.createdBlockHash},{number:analytics.lastBlockNumber,hash:analytics.lastBlockHash},{number:analytics.priceBlockNumber!,hash:analytics.priceBlockHash!}];
        const anchors=(await client.query('SELECT block_number::text,block_hash FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND block_number=ANY($2::numeric[])',[id,positions.map(position=>position.number)])).rows;if(positions.some(position=>!anchors.some(row=>row.block_number===position.number&&row.block_hash===position.hash)))return invalid();
        const event=(await client.query("SELECT value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='events' AND value->>'market'=$2 AND value->>'kind' IN('pool-initialized','pool-swap') ORDER BY (value->>'blockNumber')::numeric DESC,(value->>'logIndex')::integer DESC LIMIT 1",[id,candidate.market])).rows[0]?.value;
        if(!object(event)||event.blockNumber!==analytics.priceBlockNumber||event.blockHash!==analytics.priceBlockHash||event.sqrtPriceX96Raw!==analytics.sqrtPriceX96Raw||event.tick!==analytics.tick||event.poolId!==analytics.poolId||event.source!==manifest.poolManager.address||event.chainId!==manifest.chainId)return invalid();
        const sqrt=BigInt(analytics.sqrtPriceX96Raw!);items.push({market,balanceRaw:candidate.balanceRaw,price:{sqrtPriceX96Raw:analytics.sqrtPriceX96Raw!,tick:analytics.tick!,nativeRawPerWholeToken:{numerator:((1n<<192n)*100000000n).toString(),denominator:(sqrt*sqrt).toString()},blockNumber:analytics.priceBlockNumber!,blockHash:analytics.priceBlockHash!},lastBalanceBlockNumber:candidate.lastBalanceBlockNumber,lastBalanceBlockHash:candidate.lastBalanceBlockHash});
      }
      const height=await source.height(),canonical=await source.block(block.number);if(height<block.number||canonical.hash!==block.hash||canonical.parentHash!==block.parentHash||canonical.timestamp!==block.timestamp)return moved();
      const context:TokenAnalyticsContext={schemaVersion:1,kind:'canonical-event-journal',enabled:true,available:true,reason:null,deploymentId:id,network:nftExecutionNetwork(manifest),source:{chainId:manifest.chainId,genesisHash:manifest.genesisHash,factory:{...manifest.factory},poolManager:{...manifest.poolManager},oracle:{...manifest.oracle},quoter:{...manifest.quoter}},checkpoint:{number:block.number.toString(),hash:block.hash,parentHash:block.parentHash,timestamp:block.timestamp.toString()},observedHeadNumber:height.toString(),lagBlocks:(height-block.number).toString(),readonly:true,finalized:false};
      const nextCursor=candidates.length>select.limit?Buffer.from(JSON.stringify({id,number:block.number.toString(),hash:block.hash,wallet:select.wallet,limit:select.limit,after:page.at(-1)!.token})).toString('base64url'):null;
      await client.query('COMMIT');began=false;return json({context,wallet:select.wallet,scope:'registered-token-markets',holdingCount:count,items,nextCursor});
    }catch(error){if(began)await client?.query('ROLLBACK').catch(()=>undefined);if(error instanceof ApiError)throw error;if(object(error)&&error.code==='TOKEN_CHAIN_MOVED')return moved();return invalid();}
    finally{client?.release();}
  };
}
export const tokenWalletRead=createTokenWalletReader();
