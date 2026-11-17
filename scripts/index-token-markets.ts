/** Explicit one-pass canonical token snapshots. No signing or transaction submission. */
import {loadEnvFile} from 'node:process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createVerifiedRpc,networkConfig,RpcError} from '@oneshot/evm';
import {loadTokenManifestFile} from '../apps/api/lib/server/indexed-tokens';
import {assertLocalWatchDatabase} from '../apps/indexer/src/cli-options';
import {VerifiedTokenSource} from '../apps/indexer/src/token-source';
import {PostgresTokenSnapshotStore,syncTokenSnapshot} from '../apps/indexer/src/token-store';
import {IndexerError} from '../apps/indexer/src/types';
import {isManagedLocalDatabase,startLocalDatabaseKeeper} from '../deploy/local/local-runtime.mjs';

export function parseTokenSnapshotArguments(args:readonly string[]){
  const values=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!['--manifest','--env-file','--max-markets'].includes(key)||values.has(key)||!value?.trim()||value.startsWith('--'))throw new IndexerError('CLI_ARGUMENTS_INVALID');values.set(key,value);}
  const manifest=values.get('--manifest'),count=values.get('--max-markets')??'10';
  if(!manifest||! /^(?:[1-9]|1\d|2[0-5])$/.test(count))throw new IndexerError('CLI_ARGUMENTS_INVALID');
  return{manifest,envFile:values.get('--env-file'),maximumMarkets:Number(count)};
}
async function main(args:string[]){
  if(args.length===1&&args[0]==='--help'){console.log('Usage: npm run indexer:token-snapshot -- --manifest PATH [--env-file PATH] [--max-markets 1..25]\nOne complete canonical contract snapshot. Explicit local/Base Sepolia profile and loopback PostgreSQL required. No partial result is stored, no history/price/volume is inferred, no transactions are submitted.');return;}
  let pool:Pool|undefined,keeper:Awaited<ReturnType<typeof startLocalDatabaseKeeper>>|undefined;
  try{
    const options=parseTokenSnapshotArguments(args);if(options.envFile)loadEnvFile(resolve(options.envFile));
    if(process.env.ONESHOT_NETWORK!=='local'&&process.env.ONESHOT_NETWORK!=='base-sepolia')throw new IndexerError('TEST_PROFILE_REQUIRED');
    // This initial operator path retains the existing loopback-only database safeguard.
    assertLocalWatchDatabase(process.env.DATABASE_URL);
    const manifest=await loadTokenManifestFile(options.manifest);
    if(manifest.mode!==process.env.ONESHOT_NETWORK)throw new IndexerError('TOKEN_CHAIN_IDENTITY_MISMATCH');
    const source=new VerifiedTokenSource(await createVerifiedRpc(networkConfig(process.env)));
    if(isManagedLocalDatabase(process.env.DATABASE_URL))keeper=await startLocalDatabaseKeeper();
    pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:8000,query_timeout:8000});
    pool.on('error',()=>{/* A failed connection aborts the bounded operation; never print credentials. */});
    const result=await syncTokenSnapshot(source,new PostgresTokenSnapshotStore(pool),manifest,options.maximumMarkets);
    console.log(JSON.stringify({status:'indexed',kind:'canonical-contract-snapshot',readOnly:true,executionEnabled:false,...result}));
  }catch(error){console.error(JSON.stringify({status:'failed',readOnly:true,executionEnabled:false,code:error instanceof IndexerError||error instanceof RpcError?error.code:'TOKEN_INDEXER_FAILED'}));process.exitCode=1;}
  finally{await pool?.end().catch(()=>undefined);await keeper?.stop();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2));
