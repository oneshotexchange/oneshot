import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir,readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {createVerifiedRpc,networkConfig} from '@oneshot/evm';
import {parseManifest} from '../apps/indexer/src/manifest';
import {VerifiedRpcSource} from '../apps/indexer/src/rpc-source';
import {requestMetricRoute,type RequestMetric} from '../apps/api/lib/server/request-metrics';
import {startLocalDatabaseKeeper} from '../deploy/local/local-runtime.mjs';
import {capacityStoreWorkload} from './lib/capacity-store-workload';
import {runCapacityIndexerWorkload} from './lib/capacity-indexer-workload';
import {sampleOwnedProcess} from './lib/capacity-process-metrics';
import {CapacityError,capacityLocalDirectory,parseCapacityArguments,percentiles,profiles,runHttpPhase,testDatabaseUrl,writeCapacityReport,type HttpTarget} from './lib/capacity';

const root=fileURLToPath(new URL('../',import.meta.url));
type Fixture={status:string;rpcUrl:string;manifestPath:string;collection:string;privateEnvironmentPath:string;wallets:{creator:string;minter:string}};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const childEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([name])=>/^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(name)));
async function freePort(){const listener=createServer();await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=(listener.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));return port;}
async function stopChild(child:ChildProcess|undefined,stdin=false){
  if(!child||!child.pid||child.exitCode!==null||child.signalCode!==null)return true;
  const stopped=new Promise<boolean>(resolve=>child.once('exit',()=>resolve(true)));
  if(stdin)child.stdin?.end();else child.kill();
  const timeout=(ms:number)=>new Promise<boolean>(resolve=>{setTimeout(()=>resolve(false),ms).unref();});
  const graceful=await Promise.race([stopped,timeout(10_000)]);
  if(!graceful&&child.exitCode===null&&child.signalCode===null){child.kill();return await Promise.race([stopped,timeout(2000)]);}
  return graceful;
}
async function databaseSnapshot(pool:Pool){
  const result=await pool.query("SELECT pg_database_size(current_database())::text AS bytes, xact_commit::text, xact_rollback::text, deadlocks::text, temp_bytes::text FROM pg_stat_database WHERE datname=current_database()");
  const row=result.rows[0];return Object.fromEntries(['bytes','xact_commit','xact_rollback','deadlocks','temp_bytes'].map(key=>{const value=Number(row?.[key]);if(!Number.isSafeInteger(value)||value<0)throw new CapacityError('DATABASE_METRICS_INVALID');return [key,value];}));
}
let fixtureChild:ChildProcess|undefined,apiChild:ChildProcess|undefined,pool:Pool|undefined,recoveryPool:Pool|undefined;
let keeper:Awaited<ReturnType<typeof startLocalDatabaseKeeper>>=null,fixture:Fixture|undefined,fixturePath:string|undefined,output:string|undefined;
let stage='arguments',interrupted=false,report:Record<string,unknown>|undefined,failureCode:string|undefined;
const cleanup={apiStopped:false,fixtureStopped:false,fixtureDataRemoved:false,privateKeyRemoved:false,poolsClosed:false,keeperStopped:false};
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{interrupted=true;});
const checkStop=()=>{if(interrupted)throw new CapacityError('INTERRUPTED');};
const metrics:RequestMetric[]=[];
try{
  const options=parseCapacityArguments(process.argv.slice(2),root),profile=profiles[options.profile];
  let selected=options.databaseUrl;
  if(options.envFile){const file=await readFile(path.resolve(root,options.envFile));if(file.length>65_536)throw new CapacityError('ENV_FILE_INVALID');selected=parseEnv(file.toString()).ONESHOT_INDEXER_TEST_DATABASE_URL;}
  const connectionString=testDatabaseUrl(selected??'');
  const directory=path.join(await capacityLocalDirectory(root),`capacity-${randomUUID()}`);await mkdir(directory);
  fixturePath=path.join(directory,'manifest.json');output=options.output??path.join(directory,'report.json');
  const apiServer=path.resolve(root,'apps/api/.next/standalone/apps/api/server.js');
  try{if(!(await stat(apiServer)).isFile())throw new Error();}catch{throw new CapacityError('BUILD_API_FIRST');}
  stage='database';keeper=await startLocalDatabaseKeeper({onUnexpectedExit:()=>{interrupted=true;}});checkStop();
  const config={connectionString,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10_000,query_timeout:12_000};
  pool=new Pool(config);recoveryPool=new Pool(config);await pool.query('SELECT 1');
  await pool.query(await readFile(path.join(root,'db/schema.sql'),'utf8'));
  const databaseBefore=await databaseSnapshot(pool);
  stage='guarded-fixture';
  fixtureChild=spawn(process.execPath,[path.resolve(root,'node_modules/tsx/dist/cli.mjs'),path.resolve(root,'scripts/local-indexed-fixture.ts'),'--guarded','--database-url',connectionString,'--manifest',fixturePath],{cwd:root,env:childEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let fixtureFailed=false;fixtureChild.once('error',()=>{fixtureFailed=true;});fixtureChild.stdout?.resume();fixtureChild.stderr?.resume();fixtureChild.stdin?.on('error',()=>{});
  const fixtureDeadline=performance.now()+45_000;
  while(performance.now()<fixtureDeadline){checkStop();if(fixtureFailed||fixtureChild.exitCode!==null)throw new CapacityError('FIXTURE_START_FAILED');try{const state=JSON.parse(await readFile(`${fixturePath}.state.json`,'utf8'));if(state.status==='ready'){fixture=state as Fixture;break;}}catch{}await pause(100);}
  if(!fixture)throw new CapacityError('FIXTURE_START_TIMEOUT');
  if(fixture.manifestPath!==fixturePath||fixture.privateEnvironmentPath!==`${fixturePath}.guarded.env`||!/^0x[\da-f]{40}$/i.test(fixture.collection)||!/^0x[\da-f]{40}$/i.test(fixture.wallets?.creator)||!/^0x[\da-f]{40}$/i.test(fixture.wallets?.minter))throw new CapacityError('FIXTURE_INVALID');
  const manifest=parseManifest(JSON.parse(await readFile(fixturePath,'utf8'))),privateEnv=parseEnv(await readFile(fixture.privateEnvironmentPath,'utf8'));
  const network=networkConfig({ONESHOT_NETWORK:'local',ONESHOT_RPC_URL:fixture.rpcUrl});
  let upstreamReads=0;
  const verifiedRpc=await createVerifiedRpc(network,{fetch:async(...args)=>{upstreamReads++;return fetch(...args);}});
  const initialRpcReads=upstreamReads;
  stage='indexer-replay';const indexer=await runCapacityIndexerWorkload({manifest,source:new VerifiedRpcSource(verifiedRpc),pool});checkStop();
  const indexerRpcReads=upstreamReads-initialRpcReads;
  stage='store-contention';let poolPeak={connections:pool.totalCount,waiting:pool.waitingCount};
  const poolTimer=setInterval(()=>{poolPeak={connections:Math.max(poolPeak.connections,pool!.totalCount),waiting:Math.max(poolPeak.waiting,pool!.waitingCount)};},2);poolTimer.unref();
  let storage:Awaited<ReturnType<typeof capacityStoreWorkload>>;
  try{storage=await capacityStoreWorkload({pool,recoveryPool,records:profile.records,concurrency:8});}finally{clearInterval(poolTimer);}
  const {samples,...storageSummary}=storage;
  const storageOperations=[...new Set(samples.map(sample=>sample.operation))].map(operation=>{const values=samples.filter(sample=>sample.operation===operation);return {operation,attempted:values.length,failed:values.filter(sample=>!sample.ok).length,latency:percentiles(values.map(sample=>sample.durationMs))};});checkStop();
  stage='production-api';const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  apiChild=spawn(process.execPath,[apiServer],{cwd:path.dirname(apiServer),env:{...childEnvironment(),...privateEnv,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:String(port),NEXT_PUBLIC_APP_URL:'https://oneshot.app',ONESHOT_API_URL:'https://api.oneshot.app',DATABASE_URL:connectionString,PRIVY_APP_ID:'capacity_fixture',PRIVY_APP_SECRET:'fixture_auth_rejection_only',NEXT_PUBLIC_PRIVY_APP_ID:'capacity_fixture',ONESHOT_REQUEST_METRICS:'true',S3_BUCKET:'',S3_SECRET_ACCESS_KEY:''},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let apiFailed=false,line='';apiChild.once('error',()=>{apiFailed=true;});apiChild.stderr?.resume();
  apiChild.stdout?.setEncoding('utf8');apiChild.stdout?.on('data',(chunk:string)=>{line+=chunk;if(line.length>65_536){line='';return;}for(;;){const end=line.indexOf('\n');if(end<0)break;const part=line.slice(0,end);line=line.slice(end+1);try{const value=JSON.parse(part);if(value.event==='oneshot_request'&&typeof value.route==='string'&&(requestMetricRoute(value.route.replace(/:collection|:wallet/g,'0x'+'1'.repeat(40)))===value.route||value.route==='unmatched')&&['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE','OTHER'].includes(value.method)&&Number.isInteger(value.status)&&value.status>=100&&value.status<=599&&finite(value.durationMs)&&metrics.length<5000)metrics.push({event:'oneshot_request',route:value.route,method:value.method,status:value.status,durationMs:value.durationMs});}catch{}}});
  let ready=false;for(let attempt=0;attempt<100;attempt++){checkStop();if(apiFailed||apiChild.exitCode!==null)throw new CapacityError('API_START_FAILED');try{const response=await fetch(`${origin}/api/oneshot/launch/status`,{signal:AbortSignal.timeout(1000)});const state=await response.json();if(response.ok&&state.enabled===true){ready=true;break;}}catch{}await pause(100);}
  if(!ready)throw new CapacityError('API_START_TIMEOUT');
  const collection=fixture.collection;
  const targets:HttpTarget[]=[
    {operation:'http.collections',path:'/api/oneshot/indexed/collections?limit=20',shape:'page',expectedStatus:200},
    {operation:'http.collection',path:`/api/oneshot/indexed/collections/${collection}`,shape:'collection',expectedStatus:200},
    {operation:'http.items',path:`/api/oneshot/indexed/collections/${collection}/items?limit=20`,shape:'page',expectedStatus:200},
    {operation:'http.listings',path:'/api/oneshot/indexed/listings?status=active&limit=20',shape:'page',expectedStatus:200},
    {operation:'http.activity',path:'/api/oneshot/indexed/activity?limit=20',shape:'page',expectedStatus:200},
    {operation:'http.walletItems',path:`/api/oneshot/indexed/wallets/${fixture.wallets.minter}/items?limit=20`,shape:'page',expectedStatus:200},
    {operation:'http.launchCollection',path:`/api/oneshot/launch/collections/${collection}`,shape:'launch',expectedStatus:200},
    {operation:'http.authGate',path:`/api/oneshot/launch/floor/${collection}?wallet=${fixture.wallets.creator}`,shape:'auth',expectedStatus:401},
  ];
  stage='warmup';const warmup=await runHttpPhase({origin,targets,requests:targets.length,concurrency:1});
  if(!warmup.complete||warmup.unexpectedFailures||warmup.accepted!==targets.length)throw new CapacityError('WARMUP_FAILED');
  const resourcesBefore=await sampleOwnedProcess(apiChild.pid!);
  stage='http-load';const http=[];
  for(const concurrency of profile.concurrency){checkStop();http.push(await runHttpPhase({origin,targets:targets.filter(target=>target.shape!=='auth'),requests:profile.requests,concurrency}));}
  const resourcesAfter=await sampleOwnedProcess(apiChild.pid!);
  const databaseAfter=await databaseSnapshot(pool);
  const metricGroups=[...new Set(metrics.map(metric=>`${metric.method} ${metric.route}`))].map(key=>{const group=metrics.filter(metric=>`${metric.method} ${metric.route}`===key);return {route:group[0].route,method:group[0].method,count:group.length,statusCounts:Object.fromEntries([...new Set(group.map(metric=>metric.status))].map(status=>[String(status),group.filter(metric=>metric.status===status).length])),duration:percentiles(group.map(metric=>metric.durationMs))};});
  report={schemaVersion:1,checkedAt:new Date().toISOString(),timezone:'Asia/Dhaka',profile:options.profile,environment:{node:process.version,platform:process.platform,arch:process.arch},scope:'disposable-loopback-v2-and-dedicated-test-postgresql',limitations:['Small fixed fixture; not a production capacity or monthly volume estimate.','HTTP covers public reads and authentication rejection; Privy login and authenticated wallet approval are not exercised.','Storage uses internal fixture identities; it does not bypass HTTP authentication.','Request duration ends when the API wrapper constructs a response; client latency includes body consumption.','Rate-limited requests are counted separately from accepted work; existing limits stay enabled.','Process memory is sampled before and after load; database metrics are database-wide snapshots.','No hosted R2, media-upload load, remote RPC, independent audit or live deployment is verified.'],fixture:{collections:2,items:4,seedTransactions:21},indexer:{...indexer,upstreamReadCalls:indexerRpcReads},storage:{...storageSummary,operations:storageOperations,poolObservedPeak:poolPeak},http,warmup,requestMetrics:{events:metrics.length,groups:metricGroups},resources:{before:resourcesBefore,after:resourcesAfter,cpuDeltaMs:resourcesBefore.cpuMs!==null&&resourcesAfter.cpuMs!==null?Math.max(0,resourcesAfter.cpuMs-resourcesBefore.cpuMs):null,sampledMaxRssBytes:Math.max(resourcesBefore.rssBytes??0,resourcesAfter.rssBytes??0)||null},database:{before:databaseBefore,after:databaseAfter,sizeDeltaBytes:databaseAfter.bytes-databaseBefore.bytes}};
  if(storage.failures.length||Object.values(storage.checks).some(value=>!value)||http.some(phase=>!phase.complete||phase.unexpectedFailures||!phase.accepted)||http[0].operations.some(operation=>!operation.accepted)||!metrics.length)failureCode='WORKLOAD_CHECK_FAILED';
}catch(error){failureCode=error instanceof CapacityError?error.code:error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^CAPACITY_[A-Z_]{1,64}$/.test(error.code)?error.code:'REHEARSAL_FAILED';}
finally{
  cleanup.apiStopped=await stopChild(apiChild);
  cleanup.fixtureStopped=await stopChild(fixtureChild,true);
  if(fixturePath){try{const state=JSON.parse(await readFile(`${fixturePath}.state.json`,'utf8'));cleanup.fixtureDataRemoved=state.status==='stopped'&&state.cleanupSucceeded===true&&state.chainStopped===true;}catch{}try{await stat(`${fixturePath}.guarded.env`);}catch(error){cleanup.privateKeyRemoved=(error as NodeJS.ErrnoException).code==='ENOENT';}}
  cleanup.poolsClosed=(await Promise.allSettled([recoveryPool?.end(),pool?.end()])).every(result=>result.status==='fulfilled');
  try{await keeper?.stop();cleanup.keeperStopped=true;}catch{}
  if(report){report.cleanup=cleanup;report.passed=!failureCode&&Object.values(cleanup).every(Boolean);if(!report.passed&&!failureCode)failureCode='CLEANUP_INCOMPLETE';report.failureCode=failureCode??null;}
  if(output){try{await writeCapacityReport(root,output,report??{schemaVersion:1,checkedAt:new Date().toISOString(),passed:false,stage,failureCode,cleanup});}catch{failureCode='REPORT_WRITE_FAILED';}}
  if(failureCode){console.error(JSON.stringify({service:'oneshot-local-capacity',status:'failed',stage,code:failureCode,cleanup}));process.exitCode=1;}
  else console.log(JSON.stringify({service:'oneshot-local-capacity',status:'passed',reportPath:output}));
}
