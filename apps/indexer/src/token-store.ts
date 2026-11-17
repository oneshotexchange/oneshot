import {IndexerError,type Block} from './types';
import type {SqlPool} from './store';
import {isHash} from './manifest';
import {parseTokenManifest,tokenManifestId,tokenManifestJson,type TokenManifest} from './token-manifest';
import {tokenMarketDto,validateTokenSnapshot,type TokenSnapshot} from './token-snapshot';

/** Separate additive tables; existing NFT and legacy records are never migrated or reset. */
export const TOKEN_INDEXER_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS oneshot_evm_token_deployments (
 manifest_id text PRIMARY KEY, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oneshot_evm_token_checkpoints (
 manifest_id text NOT NULL REFERENCES oneshot_evm_token_deployments(manifest_id),
 block_number numeric(78,0) NOT NULL CHECK(block_number>=0), block_hash text NOT NULL,
 parent_hash text NOT NULL, block_timestamp numeric(78,0) NOT NULL CHECK(block_timestamp>=0),
 market_count integer NOT NULL CHECK(market_count BETWEEN 0 AND 25),
 PRIMARY KEY(manifest_id,block_number), UNIQUE(manifest_id,block_hash)
);
CREATE TABLE IF NOT EXISTS oneshot_evm_token_market_snapshots (
 manifest_id text NOT NULL, block_number numeric(78,0) NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 24),
 market text NOT NULL, token text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(manifest_id,block_number,market), UNIQUE(manifest_id,block_number,ordinal), UNIQUE(manifest_id,block_number,token),
 FOREIGN KEY(manifest_id,block_number) REFERENCES oneshot_evm_token_checkpoints(manifest_id,block_number) ON DELETE CASCADE
);`;
const textAmount=(value:unknown):bigint=>{
  if(typeof value!=='string'||!/^(0|[1-9]\d{0,77})$/.test(value)||BigInt(value)>=2n**256n)throw new IndexerError('TOKEN_DATA_INVALID');return BigInt(value);
};
export function tokenCheckpoint(row:Record<string,unknown>):Block{
  if(!isHash(row.block_hash)||!isHash(row.parent_hash))throw new IndexerError('TOKEN_DATA_INVALID');
  return{number:textAmount(row.block_number),hash:row.block_hash.toLowerCase() as Block['hash'],parentHash:row.parent_hash.toLowerCase() as Block['parentHash'],timestamp:textAmount(row.block_timestamp)};
}
const same=(a:Block|null,b:Block|null)=>a===null?b===null:b!==null&&a.number===b.number&&a.hash===b.hash&&a.parentHash===b.parentHash&&a.timestamp===b.timestamp;
export class PostgresTokenSnapshotStore {
  constructor(private readonly pool:SqlPool){}
  async initialize(input:TokenManifest){
    const manifest=parseTokenManifest(tokenManifestJson(input)),id=tokenManifestId(manifest),client=await this.pool.connect();let began=false;
    try{
      await client.query('BEGIN');began=true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_token_schema'),0)");
      await client.query(TOKEN_INDEXER_SCHEMA_SQL);
      await client.query('INSERT INTO oneshot_evm_token_deployments(manifest_id,manifest) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[id,JSON.stringify(tokenManifestJson(manifest))]);
      const stored=(await client.query('SELECT manifest FROM oneshot_evm_token_deployments WHERE manifest_id=$1',[id])).rows[0]?.manifest;
      if(tokenManifestId(parseTokenManifest(stored))!==id)throw new IndexerError('TOKEN_MANIFEST_MISMATCH');
      await client.query('COMMIT');began=false;
    }catch(error){if(began)await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
  async heads(manifest:TokenManifest):Promise<Block[]>{
    const client=await this.pool.connect();try{
      const result=await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 ORDER BY oneshot_evm_token_checkpoints.block_number DESC LIMIT 17',[tokenManifestId(manifest)]);
      return result.rows.map(tokenCheckpoint);
    }finally{client.release();}
  }
  /** Caller supplies the observed head and verified common ancestor; concurrent sync cannot overwrite it. */
  async commit(manifest:TokenManifest,input:TokenSnapshot,expectedHead:Block|null,ancestor:Block|null){
    const id=tokenManifestId(manifest),snapshot=validateTokenSnapshot(input);
    if(snapshot.block.number<manifest.startBlock||ancestor&&ancestor.number>snapshot.block.number)throw new IndexerError('TOKEN_CHECKPOINT_INVALID');
    const client=await this.pool.connect();let began=false;
    try{
      await client.query('BEGIN');began=true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_token_snapshot'),hashtext($1))",[id]);
      const rows=(await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 ORDER BY oneshot_evm_token_checkpoints.block_number DESC LIMIT 1',[id])).rows;
      const current=rows[0]?tokenCheckpoint(rows[0]):null;
      if(!same(current,expectedHead))throw new IndexerError('CONCURRENT_SYNC');
      if(ancestor){
        const row=(await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 AND block_number=$2::numeric',[id,ancestor.number.toString()])).rows[0];
        if(!row||!same(tokenCheckpoint(row),ancestor))throw new IndexerError('TOKEN_CHECKPOINT_INVALID');
      }
      if(current&&!same(current,ancestor))await client.query('DELETE FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 AND block_number>$2::numeric',[id,ancestor?.number.toString()??'-1']);
      if(same(snapshot.block,ancestor)){
        // A checkpoint is immutable: do not let a second writer replace its market records.
        const rows=(await client.query('SELECT ordinal,value FROM oneshot_evm_token_market_snapshots WHERE manifest_id=$1 AND block_number=$2::numeric ORDER BY ordinal',[id,snapshot.block.number.toString()])).rows;
        if(rows.length!==snapshot.markets.length||rows.some((row,index)=>row.ordinal!==index||JSON.stringify(tokenMarketDto(row.value))!==JSON.stringify(snapshot.markets[index])))throw new IndexerError('TOKEN_CHECKPOINT_INVALID');
      }else{
        await client.query('INSERT INTO oneshot_evm_token_checkpoints(manifest_id,block_number,block_hash,parent_hash,block_timestamp,market_count) VALUES($1,$2,$3,$4,$5,$6)',[id,snapshot.block.number.toString(),snapshot.block.hash,snapshot.block.parentHash,snapshot.block.timestamp.toString(),snapshot.markets.length]);
        for(const [ordinal,market]of snapshot.markets.entries())await client.query('INSERT INTO oneshot_evm_token_market_snapshots(manifest_id,block_number,ordinal,market,token,value) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[id,snapshot.block.number.toString(),ordinal,market.market,market.token,JSON.stringify(market)]);
      }
      await client.query('COMMIT');began=false;
    }catch(error){if(began)await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
}
export type TokenSnapshotSource={snapshot(manifest:TokenManifest,maximumMarkets?:number):Promise<TokenSnapshot>;block(number:bigint):Promise<Block>};
/** No partial scans are committed. Every retained branch decision is verified before mutation. */
export async function syncTokenSnapshot(source:TokenSnapshotSource,store:PostgresTokenSnapshotStore,manifest:TokenManifest,maximumMarkets=10){
  const snapshot=validateTokenSnapshot(await source.snapshot(manifest,maximumMarkets));
  await store.initialize(manifest);
  const heads=await store.heads(manifest),expectedHead=heads[0]??null;
  if(expectedHead&&snapshot.block.number<expectedHead.number)throw new IndexerError('TOKEN_SOURCE_BEHIND');
  let ancestor:Block|null=null,orphaned=0;
  for(const head of heads){
    if(head.number<=snapshot.block.number&&(await source.block(head.number)).hash===head.hash){ancestor=head;break;}
    if(++orphaned>16)throw new IndexerError('REORG_TOO_DEEP');
  }
  if((await source.block(snapshot.block.number)).hash!==snapshot.block.hash)throw new IndexerError('TOKEN_CHAIN_MOVED');
  await store.commit(manifest,snapshot,expectedHead,ancestor);
  return{deploymentId:tokenManifestId(manifest),blockNumber:snapshot.block.number.toString(),blockHash:snapshot.block.hash,markets:snapshot.markets.length,orphaned};
}
