import {createHash} from 'node:crypto';
import type {SqlPool,SqlClient} from './store';
import {IndexerError,type Block,type ProjectionValue,type RawLog} from './types';
import {isHash} from './manifest';
import {parseTokenManifest,tokenManifestId,tokenManifestJson,type TokenManifest} from './token-manifest';
import {normalizeTokenRegistration,projectTokenEvents,tokenMarketAnalytics,validateTokenEventLogs} from './token-event-projector';
import {TOKEN_EVENT_KINDS,type TokenEventKind,type TokenEventTransaction,type TokenEventUndo} from './token-event-types';

/** Event analytics are isolated from NFT projections and the bounded token snapshot reader. */
export const TOKEN_EVENT_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS oneshot_evm_token_event_deployments(manifest_id text PRIMARY KEY,manifest jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS oneshot_evm_token_event_journal(
 manifest_id text NOT NULL REFERENCES oneshot_evm_token_event_deployments(manifest_id),
 block_number numeric(78,0) NOT NULL CHECK(block_number>=0),block_hash text NOT NULL,parent_hash text NOT NULL,block_timestamp numeric(78,0) NOT NULL CHECK(block_timestamp>=0),
 input_digest text NOT NULL,undo jsonb NOT NULL,PRIMARY KEY(manifest_id,block_number),UNIQUE(manifest_id,block_hash)
);
ALTER TABLE oneshot_evm_token_event_journal ADD COLUMN IF NOT EXISTS producer_version integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS oneshot_evm_token_event_older_producers ON oneshot_evm_token_event_journal(manifest_id) WHERE producer_version<>2;
CREATE TABLE IF NOT EXISTS oneshot_evm_token_event_logs(
 manifest_id text NOT NULL,block_number numeric(78,0) NOT NULL,log_index integer NOT NULL CHECK(log_index>=0),payload jsonb NOT NULL,
 PRIMARY KEY(manifest_id,block_number,log_index),FOREIGN KEY(manifest_id,block_number) REFERENCES oneshot_evm_token_event_journal(manifest_id,block_number) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS oneshot_evm_token_event_projections(
 manifest_id text NOT NULL REFERENCES oneshot_evm_token_event_deployments(manifest_id),kind text NOT NULL CHECK(kind IN('markets','tokens','pools','balances','events')),
 entity_id text NOT NULL,value jsonb NOT NULL,PRIMARY KEY(manifest_id,kind,entity_id)
);
CREATE TABLE IF NOT EXISTS oneshot_evm_token_event_wallets(
 manifest_id text NOT NULL REFERENCES oneshot_evm_token_event_deployments(manifest_id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind='wallets'),entity_id text NOT NULL,value jsonb NOT NULL,PRIMARY KEY(manifest_id,kind,entity_id)
);
CREATE INDEX IF NOT EXISTS oneshot_evm_token_event_market_events ON oneshot_evm_token_event_projections(manifest_id,(value->>'market'),(value->>'kind'),((value->>'blockNumber')::numeric) DESC,((value->>'logIndex')::integer) DESC) WHERE kind='events';
CREATE INDEX IF NOT EXISTS oneshot_evm_token_event_token_balances ON oneshot_evm_token_event_projections(manifest_id,(value->>'token'),(value->>'wallet')) WHERE kind='balances';
CREATE INDEX IF NOT EXISTS oneshot_evm_token_event_wallet_balances ON oneshot_evm_token_event_projections(manifest_id,(value->>'wallet'),(value->>'token')) WHERE kind='balances';`;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const projectionTable=(kind:TokenEventKind)=>kind==='wallets'?'oneshot_evm_token_event_wallets':'oneshot_evm_token_event_projections';
const fail=(code:string):never=>{throw new IndexerError(code);};
function canonicalJson(value:unknown):string{
  const normalize=(item:unknown):unknown=>{
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'&&Number.isSafeInteger(item))return item;
    if(Array.isArray(item))return item.map(normalize);
    if(object(item))return Object.fromEntries(Object.keys(item).sort().map(key=>[key,normalize(item[key])]));
    return fail('TOKEN_EVENT_PROJECTION_INVALID');
  };
  return JSON.stringify(normalize(value));
}
const decimal=(value:unknown)=>typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<2n**256n?BigInt(value):fail('TOKEN_EVENT_JOURNAL_INVALID');
function journalBlock(row:Record<string,unknown>):Block{
  if(!isHash(row.block_hash)||!isHash(row.parent_hash))return fail('TOKEN_EVENT_JOURNAL_INVALID');
  return{number:decimal(row.block_number),hash:row.block_hash.toLowerCase() as Block['hash'],parentHash:row.parent_hash.toLowerCase() as Block['parentHash'],timestamp:decimal(row.block_timestamp)};
}
const blockColumns='block_number::text,block_hash,parent_hash,block_timestamp::text,input_digest,undo';
const normalizedBlock=(block:Block):Block=>({number:block.number,hash:block.hash.toLowerCase() as Block['hash'],parentHash:block.parentHash.toLowerCase() as Block['parentHash'],timestamp:block.timestamp});
function normalizeInput(block:Block,logs:readonly RawLog[],registrations:readonly unknown[]){
  if(!Array.isArray(registrations)||registrations.length>1000)return fail('TOKEN_EVENT_SOURCE_LIMIT');
  const normalizedLogs=validateTokenEventLogs(block,logs).map(log=>({...log,address:log.address.toLowerCase() as RawLog['address'],data:log.data.toLowerCase() as RawLog['data'],blockHash:log.blockHash.toLowerCase() as RawLog['blockHash'],transactionHash:log.transactionHash.toLowerCase() as RawLog['transactionHash'],topics:log.topics.map(topic=>topic.toLowerCase() as typeof topic)}));
  const proof=registrations.map(normalizeTokenRegistration).sort((a,b)=>a.market.localeCompare(b.market));
  const rawLogs=normalizedLogs.map(log=>({...log,blockNumber:log.blockNumber.toString()}));
  const inputDigest=createHash('sha256').update(canonicalJson({block:{...block,number:block.number.toString(),timestamp:block.timestamp.toString()},logs:rawLogs,registrations:proof})).digest('hex');
  return{logs:normalizedLogs,rawLogs,registrations:proof,inputDigest};
}
class ProjectionTransaction implements TokenEventTransaction{
  readonly undo=new Map<string,TokenEventUndo>();private readonly cache=new Map<string,ProjectionValue|null>();
  constructor(private readonly client:SqlClient,private readonly id:string,private readonly deadline:number){}
  private check(kind:TokenEventKind,id:string){if(Date.now()>this.deadline)return fail('TOKEN_EVENT_SOURCE_LIMIT');if(!TOKEN_EVENT_KINDS.includes(kind)||!id||id.length>256)return fail('TOKEN_EVENT_PROJECTION_INVALID');}
  async get(kind:TokenEventKind,id:string){
    this.check(kind,id);const key=`${kind}:${id}`;
    if(!this.cache.has(key)){const row=(await this.client.query(`SELECT value FROM ${projectionTable(kind)} WHERE manifest_id=$1 AND kind=$2 AND entity_id=$3`,[this.id,kind,id])).rows[0];if(row&&!object(row.value))return fail('TOKEN_EVENT_PROJECTION_INVALID');this.cache.set(key,row?structuredClone(row.value as ProjectionValue):null);}
    return structuredClone(this.cache.get(key)??null);
  }
  async put(kind:TokenEventKind,id:string,value:ProjectionValue){
    this.check(kind,id);const key=`${kind}:${id}`,json=canonicalJson(value);if(Buffer.byteLength(json)>65536)return fail('TOKEN_EVENT_SOURCE_LIMIT');
    if(!this.undo.has(key))this.undo.set(key,{kind,id,before:await this.get(kind,id)});
    if(this.undo.size>40000)return fail('TOKEN_EVENT_SOURCE_LIMIT');
    await this.client.query(`INSERT INTO ${projectionTable(kind)}(manifest_id,kind,entity_id,value) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(manifest_id,kind,entity_id) DO UPDATE SET value=EXCLUDED.value`,[this.id,kind,id,json]);this.cache.set(key,structuredClone(value));
  }
  async countWalletHoldings(wallet:import('viem').Address){this.check('wallets',wallet);const row=(await this.client.query("SELECT count(*) FILTER(WHERE (value->>'balanceRaw')::numeric>0)::text AS count FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'wallet'=$2",[this.id,wallet])).rows[0];return decimal(row?.count);}
}
export class PostgresTokenEventStore{
  private manifest:TokenManifest|null=null;
  private initializing:Promise<void>|null=null;
  constructor(private readonly pool:SqlPool){}
  async initialize(input:TokenManifest){
    const manifest=parseTokenManifest(tokenManifestJson(input)),id=tokenManifestId(manifest);
    if(this.initializing)await this.initializing;
    if(this.manifest&&tokenManifestId(this.manifest)!==id)return fail('TOKEN_MANIFEST_MISMATCH');
    if(this.manifest)return;
    this.initializing=this.initializeDatabase(manifest);
    try{await this.initializing;}finally{this.initializing=null;}
  }
  private async initializeDatabase(manifest:TokenManifest){
    const id=tokenManifestId(manifest);
    const client=await this.pool.connect();try{
      await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_token_events_schema'),0)");await client.query(TOKEN_EVENT_SCHEMA_SQL);
      await client.query('INSERT INTO oneshot_evm_token_event_deployments(manifest_id,manifest) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[id,JSON.stringify(tokenManifestJson(manifest))]);
      const value=(await client.query('SELECT manifest FROM oneshot_evm_token_event_deployments WHERE manifest_id=$1',[id])).rows[0]?.manifest;
      if(tokenManifestId(parseTokenManifest(value))!==id)return fail('TOKEN_MANIFEST_MISMATCH');
      await client.query('COMMIT');this.manifest=manifest;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
  private identity(){if(!this.manifest)return fail('STORE_NOT_INITIALIZED');return{manifest:this.manifest,id:tokenManifestId(this.manifest)};}
  async head():Promise<Block|null>{
    const{id}=this.identity(),client=await this.pool.connect();try{const row=(await client.query(`SELECT ${blockColumns} FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_token_event_journal.block_number DESC LIMIT 1`,[id])).rows[0];return row?journalBlock(row):null;}finally{client.release();}
  }
  async block(number:bigint):Promise<Block|null>{
    if(typeof number!=='bigint'||number<0n||number>=2n**256n)return fail('TOKEN_EVENT_CHECKPOINT_INVALID');
    const{id}=this.identity(),client=await this.pool.connect();try{const row=(await client.query(`SELECT ${blockColumns} FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND block_number=$2::numeric`,[id,number.toString()])).rows[0];return row?journalBlock(row):null;}finally{client.release();}
  }
  /** Keyset scan of registered addresses. No contract enumeration or snapshot market limit. */
  async registrations(after:string|null=null,limit=128){
    if(after!==null&&!/^0x[\da-f]{40}$/.test(after)||!Number.isSafeInteger(limit)||limit<1||limit>128)return fail('TOKEN_EVENT_SOURCE_LIMIT');
    const{manifest,id}=this.identity(),client=await this.pool.connect();try{
      const rows=(await client.query("SELECT entity_id,value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='markets' AND ($2::text IS NULL OR entity_id>$2) ORDER BY entity_id LIMIT $3",[id,after,limit])).rows;
      return rows.map(row=>{if(typeof row.entity_id!=='string'||!object(row.value))return fail('TOKEN_EVENT_PROJECTION_INVALID');return normalizeTokenRegistration(tokenMarketAnalytics(row.value,manifest,row.entity_id));});
    }finally{client.release();}
  }
  async projection(kind:TokenEventKind,entity:string):Promise<ProjectionValue|null>{
    if(!TOKEN_EVENT_KINDS.includes(kind)||!entity||entity.length>256)return fail('TOKEN_EVENT_PROJECTION_INVALID');
    const{id}=this.identity(),client=await this.pool.connect();try{const row=(await client.query(`SELECT value FROM ${projectionTable(kind)} WHERE manifest_id=$1 AND kind=$2 AND entity_id=$3`,[id,kind,entity])).rows[0];if(row&&!object(row.value))return fail('TOKEN_EVENT_PROJECTION_INVALID');return row?structuredClone(row.value as ProjectionValue):null;}finally{client.release();}
  }
  async applyBlock(inputBlock:Block,inputLogs:readonly RawLog[],registrations:readonly unknown[]=[]){
    const{manifest,id}=this.identity();validateTokenEventLogs(inputBlock,inputLogs);const block=normalizedBlock(inputBlock),input=normalizeInput(block,inputLogs,registrations);
    if(block.number<manifest.startBlock)return fail('TOKEN_EVENT_CHECKPOINT_INVALID');
    const client=await this.pool.connect();try{
      await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_token_events'),hashtext($1))",[id]);
      const previous=(await client.query(`SELECT ${blockColumns} FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_token_event_journal.block_number DESC LIMIT 1`,[id])).rows[0],head=previous?journalBlock(previous):null;
      if(head&&head.number===block.number&&head.hash===block.hash){if(previous.input_digest!==input.inputDigest)return fail('TOKEN_EVENT_INPUT_CHANGED');await client.query('COMMIT');return{applied:false,created:0,logs:input.logs.length};}
      if(block.number!==(head?head.number+1n:manifest.startBlock)||block.parentHash!==(head?.hash??manifest.anchorHash))return fail('NON_CONTIGUOUS_BLOCK');
      const deadline=Date.now()+30000,tx=new ProjectionTransaction(client,id,deadline),result=await projectTokenEvents(tx,manifest,block,input.logs,input.registrations),undo=canonicalJson([...tx.undo.values()]);
      if(Buffer.byteLength(undo)>16*1024*1024)return fail('TOKEN_EVENT_SOURCE_LIMIT');
      if(Date.now()>deadline)return fail('TOKEN_EVENT_SOURCE_LIMIT');
      await client.query('INSERT INTO oneshot_evm_token_event_journal(manifest_id,block_number,block_hash,parent_hash,block_timestamp,input_digest,undo,producer_version) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,2)',[id,block.number.toString(),block.hash,block.parentHash,block.timestamp.toString(),input.inputDigest,undo]);
      for(const log of input.rawLogs){if(Date.now()>deadline)return fail('TOKEN_EVENT_SOURCE_LIMIT');await client.query('INSERT INTO oneshot_evm_token_event_logs(manifest_id,block_number,log_index,payload) VALUES($1,$2,$3,$4::jsonb)',[id,block.number.toString(),log.logIndex,canonicalJson(log)]);}
      await client.query('COMMIT');return{applied:true,...result};
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
  async rollbackHead(expected?:Block){
    const{id}=this.identity(),client=await this.pool.connect();try{
      await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='5000ms'");await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_token_events'),hashtext($1))",[id]);
      const row=(await client.query(`SELECT ${blockColumns} FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_token_event_journal.block_number DESC LIMIT 1`,[id])).rows[0];
      if(!row){if(expected)return fail('CONCURRENT_SYNC');await client.query('COMMIT');return null;}
      const block=journalBlock(row);if(expected&&(block.number!==expected.number||block.hash!==expected.hash))return fail('CONCURRENT_SYNC');
      if(!Array.isArray(row.undo)||row.undo.length>40000||Buffer.byteLength(canonicalJson(row.undo))>16*1024*1024)return fail('TOKEN_EVENT_JOURNAL_INVALID');
      const seen=new Set<string>(),deadline=Date.now()+30000;
      for(const raw of row.undo){
        if(Date.now()>deadline)return fail('TOKEN_EVENT_SOURCE_LIMIT');
        if(!object(raw)||!TOKEN_EVENT_KINDS.includes(raw.kind as TokenEventKind)||typeof raw.id!=='string'||!raw.id||raw.id.length>256||(raw.before!==null&&!object(raw.before)))return fail('TOKEN_EVENT_JOURNAL_INVALID');
        const key=`${raw.kind}:${raw.id}`;if(seen.has(key))return fail('TOKEN_EVENT_JOURNAL_INVALID');seen.add(key);
        if(raw.before===null)await client.query(`DELETE FROM ${projectionTable(raw.kind as TokenEventKind)} WHERE manifest_id=$1 AND kind=$2 AND entity_id=$3`,[id,raw.kind,raw.id]);
        else await client.query(`INSERT INTO ${projectionTable(raw.kind as TokenEventKind)}(manifest_id,kind,entity_id,value) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(manifest_id,kind,entity_id) DO UPDATE SET value=EXCLUDED.value`,[id,raw.kind,raw.id,canonicalJson(raw.before)]);
      }
      await client.query('DELETE FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND block_number=$2::numeric',[id,block.number.toString()]);
      await client.query('COMMIT');return block;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
}
