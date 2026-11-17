import type { Pool } from 'pg';
import { z } from 'zod';
import type { Hex, Address } from 'viem';
import { isNftExecutionNetwork, type NftExecutionNetwork, type TokenExecutionReview } from '@oneshot/evm';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';

const NAMESPACE = 'oneshot_token_reviews';
const RETENTION_MS = 30 * 86_400_000;
const address = z.string().regex(/^0x[\da-f]{40}$/).refine(value=>!/^0x0{40}$/.test(value)).transform(value=>value as Address);
const hash = z.string().regex(/^0x[\da-f]{64}$/).transform(value=>value as Hex);
const amount = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
export const tokenExecutionReviewSchema = z.object({
  id:z.string().uuid(), reviewHash:z.string().regex(/^[\da-f]{64}$/), expiresAt:z.string().datetime(),
  action:z.enum(['launch','approve','buy','sell','claim']), chainId:z.union([z.literal(31337),z.literal(84532)]),
  deploymentId:z.string().regex(/^[\da-f]{64}$/), network:z.custom<NftExecutionNetwork>(isNftExecutionNetwork),
  from:address, to:address, value:amount, data:z.string().max(32770).regex(/^0x(?:[\da-f]{2})+$/).transform(value=>value as Hex),
  summary:z.record(z.string().max(64),z.string().max(2048)),
  simulation:z.object({blockNumber:amount,blockHash:hash,gasEstimate:amount}).strict(),
}).strict().refine(value => value.chainId === value.network.chainId && Object.keys(value.summary).length <= 64);
export type { TokenExecutionReview } from '@oneshot/evm';
const storedSchema = z.object({
  owner:z.string().min(1).max(256), session:z.string().min(1).max(256), createdAt:z.number().int().nonnegative(),
  review:tokenExecutionReviewSchema, intent:z.record(z.string(),z.unknown()),
  transactionHash:hash.optional(), outcome:z.enum(['submitted','confirmed','reverted']).optional(), updatedAt:z.string().datetime().optional(),
}).strict().superRefine((value,ctx) => {
  const expiry=Date.parse(value.review.expiresAt);
  if (expiry <= value.createdAt || expiry > value.createdAt + 120000 || Boolean(value.transactionHash) !== Boolean(value.outcome)) ctx.addIssue({code:'custom',message:'Invalid review lifetime or transaction binding.'});
});
export type StoredTokenExecutionReview = z.infer<typeof storedSchema>;
const integrity = (): never => { throw new ApiError(503,'TOKEN_REVIEW_INTEGRITY','This transaction review could not be read. Refresh and try again.'); };
const missing = (): never => { throw new ApiError(404,'TOKEN_REVIEW_NOT_FOUND','This transaction review was not found in your account.'); };
function parse(value:unknown) { const parsed=storedSchema.safeParse(value); if(!parsed.success)return integrity(); return parsed.data; }
function bounded(value:unknown) { const bytes=JSON.stringify(value); if(Buffer.byteLength(bytes)>32768)throw new ApiError(400,'TOKEN_REVIEW_TOO_LARGE','This transaction review exceeds its size limit.'); return bytes; }
function time(now:number) { if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)throw new TypeError('Invalid review timestamp.'); }
function expired(item:StoredTokenExecutionReview,now:number) { return item.createdAt<=now-RETENTION_MS; }

/** Durable account-scoped transaction tracking; no signatures, keys or access tokens are stored. */
export function createTokenExecutionRepository(options:{database?:()=>Pool|null;activeLimit?:number;retainedLimit?:number}={}) {
  const db=options.database??database,activeLimit=options.activeLimit??20,retainedLimit=options.retainedLimit??100000;
  if(!Number.isSafeInteger(activeLimit)||activeLimit<1||!Number.isSafeInteger(retainedLimit)||retainedLimit<1)throw new TypeError('Invalid review capacity.');
  const capacity=(total:number,active:number)=>{if(total>=retainedLimit||active>=activeLimit)throw new ApiError(429,'TOKEN_REVIEW_LIMIT','You have several active transaction reviews. Wait for one to expire and try again.');};
  async function create(raw:StoredTokenExecutionReview,now:number) {
    time(now);const item=parse(structuredClone(raw));
    if(item.createdAt>now||expired(item,now)||item.transactionHash||Date.parse(item.review.expiresAt)<=now)throw new ApiError(400,'TOKEN_REVIEW_INVALID','Create a fresh transaction review.');
    const bytes=bounded(item),pool=db();
    if(pool){const client=await pool.connect();try{
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[NAMESPACE]);
      await client.query(`DELETE FROM b20_app_records WHERE namespace=$1 AND id IN (SELECT id FROM b20_app_records WHERE namespace=$1 AND (value->>'createdAt')::bigint <= $2 ORDER BY id LIMIT 1000)`,[NAMESPACE,now-RETENTION_MS]);
      const counts=await client.query(`SELECT count(*)::integer AS total,count(*) FILTER (WHERE value->>'owner'=$3 AND value->>'transactionHash' IS NULL AND (value->'review'->>'expiresAt')::timestamptz>$4::timestamptz)::integer AS active FROM b20_app_records WHERE namespace=$1 AND (value->>'createdAt')::bigint>$2`,[NAMESPACE,now-RETENTION_MS,item.owner,new Date(now).toISOString()]);
      capacity(counts.rows[0].total,counts.rows[0].active);
      await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb)',[NAMESPACE,item.review.id,bytes]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}return;}
    await withLocalNamespace<StoredTokenExecutionReview,void>(NAMESPACE,records=>{
      for(const [id,value] of Object.entries(records))if(expired(parse(value),now))delete records[id];
      const all=Object.values(records).map(parse);capacity(all.length,all.filter(value=>value.owner===item.owner&&!value.transactionHash&&Date.parse(value.review.expiresAt)>now).length);
      if(records[item.review.id])throw new ApiError(409,'TOKEN_REVIEW_EXISTS','This review already exists. Create a new review.');
      records[item.review.id]=JSON.parse(bytes);
    },true);
  }
  async function get(id:string,owner:string,now:number) {
    time(now);if(!z.string().uuid().safeParse(id).success||!owner||owner.length>256)return missing();
    const pool=db();const value=pool?(await pool.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2',[NAMESPACE,id])).rows[0]?.value
      :await withLocalNamespace<StoredTokenExecutionReview,StoredTokenExecutionReview|undefined>(NAMESPACE,records=>records[id],false);
    if(!value)return missing();const item=parse(value);if(item.owner!==owner||expired(item,now))return missing();return structuredClone(item);
  }
  async function update(id:string,owner:string,transactionHash:string,outcome:'submitted'|'confirmed'|'reverted',now:number) {
    time(now);if(!z.string().uuid().safeParse(id).success||!hash.safeParse(transactionHash).success||!['submitted','confirmed','reverted'].includes(outcome))throw new ApiError(400,'TOKEN_TRANSACTION_INVALID','Use a valid transaction reference.');
    const apply=(raw:unknown)=>{
      if(!raw)return missing();const previous=parse(raw);if(previous.owner!==owner||expired(previous,now))return missing();
      if(previous.transactionHash&&previous.transactionHash!==transactionHash)throw new ApiError(409,'TOKEN_TRANSACTION_CHANGED','This review is tracking a different transaction.');
      return parse({...previous,transactionHash,outcome,updatedAt:new Date(now).toISOString()});
    };
    const pool=db();if(pool){const client=await pool.connect();try{
      await client.query('BEGIN');const current=await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2 FOR UPDATE',[NAMESPACE,id]);
      const item=apply(current.rows[0]?.value);await client.query('UPDATE b20_app_records SET value=$3::jsonb,updated_at=now() WHERE namespace=$1 AND id=$2',[NAMESPACE,id,bounded(item)]);
      await client.query('COMMIT');return structuredClone(item);
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
    return withLocalNamespace<StoredTokenExecutionReview,StoredTokenExecutionReview>(NAMESPACE,records=>{const item=apply(records[id]);records[id]=item;return structuredClone(item);},true);
  }
  return {create,get,update};
}
export const tokenExecutionRepository=createTokenExecutionRepository();
