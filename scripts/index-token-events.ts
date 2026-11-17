/** Bounded canonical token event ingestion. No signing or transaction submission. */
import {loadEnvFile} from 'node:process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createVerifiedRpc,networkConfig,RpcError} from '@oneshot/evm';
import {loadTokenManifestFile} from '../apps/api/lib/server/indexed-tokens';
import {assertLocalWatchDatabase} from '../apps/indexer/src/cli-options';
import {VerifiedTokenEventSource} from '../apps/indexer/src/token-event-source';
import {PostgresTokenEventStore} from '../apps/indexer/src/token-event-store';
import {syncTokenEvents} from '../apps/indexer/src/token-event-worker';
import {IndexerError} from '../apps/indexer/src/types';
import {isManagedLocalDatabase,startLocalDatabaseKeeper} from '../deploy/local/local-runtime.mjs';

export function parseTokenEventArguments(args:readonly string[]){
  const values=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!['--manifest','--env-file','--max-blocks','--confirmations'].includes(key)||values.has(key)||!value?.trim()||value.startsWith('--'))throw new IndexerError('CLI_ARGUMENTS_INVALID');values.set(key,value);}
  const manifest=values.get('--manifest'),blocks=values.get('--max-blocks')??'8',confirmations=values.get('--confirmations')??'2';
  if(!manifest||! /^(?:[1-9]|[12]\d|3[0-2])$/.test(blocks)||! /^(?:0|[1-9]|[1-5]\d|6[0-4])$/.test(confirmations))throw new IndexerError('CLI_ARGUMENTS_INVALID');
  return{manifest,envFile:values.get('--env-file'),maximumBlocks:Number(blocks),confirmations:Number(confirmations)};
}
async function main(args:string[]){
  if(args.length===1&&args[0]==='--help'){console.log('Usage: npm run indexer:token-events -- --manifest PATH [--env-file PATH] [--max-blocks 1..32] [--confirmations 0..64]\nOne bounded canonical event pass. Explicit local/Base Sepolia profile and loopback PostgreSQL required. Every block is atomic; earlier complete blocks can remain if a later block fails. Maximum 1024 registered markets, 4 creations/block, 10000 logs/block, 768 logical RPC reads/45 seconds per capture, 16-block reorg recovery. No signing or submission. Confirmations do not imply finality.');return;}
  let pool:Pool|undefined,keeper:Awaited<ReturnType<typeof startLocalDatabaseKeeper>>|undefined;
  try{
    const options=parseTokenEventArguments(args);if(options.envFile)loadEnvFile(resolve(options.envFile));
    if(process.env.ONESHOT_NETWORK!=='local'&&process.env.ONESHOT_NETWORK!=='base-sepolia')throw new IndexerError('TEST_PROFILE_REQUIRED');
    assertLocalWatchDatabase(process.env.DATABASE_URL);
    const manifest=await loadTokenManifestFile(options.manifest);if(manifest.mode!==process.env.ONESHOT_NETWORK)throw new IndexerError('TOKEN_CHAIN_IDENTITY_MISMATCH');
    const source=new VerifiedTokenEventSource(await createVerifiedRpc(networkConfig(process.env)));
    if(isManagedLocalDatabase(process.env.DATABASE_URL))keeper=await startLocalDatabaseKeeper();
    pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:8000,query_timeout:8000});pool.on('error',()=>{});
    const result=await syncTokenEvents(source,new PostgresTokenEventStore(pool),manifest,options);
    console.log(JSON.stringify({status:'indexed',kind:'canonical-event-journal',readOnly:true,executionEnabled:false,...result}));
  }catch(error){console.error(JSON.stringify({status:'failed',readOnly:true,executionEnabled:false,code:error instanceof IndexerError||error instanceof RpcError?error.code:'TOKEN_EVENT_INDEXER_FAILED'}));process.exitCode=1;}
  finally{await pool?.end().catch(()=>undefined);await keeper?.stop();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2));
