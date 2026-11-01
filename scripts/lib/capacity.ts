import path from 'node:path';
import {mkdir,realpath,writeFile} from 'node:fs/promises';

export class CapacityError extends Error {
  constructor(public readonly code:string){super(code);}
}
export function testDatabaseUrl(value:string):string {
  try{
    const url=new URL(value);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      ||url.pathname!=='/oneshot_indexer_test'||url.search||url.hash||!url.username)throw new Error();
    return url.toString();
  }catch{throw new CapacityError('DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED');}
}
export function localReportPath(root:string,value:string):string {
  const local=path.resolve(root,'.local'),target=path.resolve(root,value),relative=path.relative(local,target);
  if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||path.extname(target)!=='.json')throw new CapacityError('LOCAL_JSON_REPORT_REQUIRED');
  return target;
}
export async function capacityLocalDirectory(root:string){
  const actualRoot=await realpath(root),local=path.resolve(root,'.local');await mkdir(local,{recursive:true});
  const actualLocal=await realpath(local),relative=path.relative(actualRoot,actualLocal);
  if(path.isAbsolute(relative)||relative==='..'||relative.startsWith(`..${path.sep}`))throw new CapacityError('LOCAL_JSON_REPORT_REQUIRED');
  return actualLocal;
}
export async function writeCapacityReport(root:string,output:string,report:unknown){
  const selected=localReportPath(root,output);
  const inside=(base:string,target:string)=>{const relative=path.relative(base,target);return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`);};
  const actualLocal=await capacityLocalDirectory(root);
  let ancestor=path.dirname(selected);
  for(;;){try{if(!inside(actualLocal,await realpath(ancestor)))throw new CapacityError('LOCAL_JSON_REPORT_REQUIRED');break;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw new CapacityError('LOCAL_JSON_REPORT_REQUIRED');ancestor=parent;}}
  await mkdir(path.dirname(selected),{recursive:true});
  if(!inside(actualLocal,await realpath(path.dirname(selected))))throw new CapacityError('LOCAL_JSON_REPORT_REQUIRED');
  await writeFile(selected,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
}
export const profiles={smoke:{requests:12,concurrency:[1,4],records:8},baseline:{requests:48,concurrency:[1,4,8],records:32},burst:{requests:128,concurrency:[1,4,8],records:64}} as const;
export type Profile=keyof typeof profiles;
export function parseCapacityArguments(args:string[],root:string){
  const flags=new Map<string,string>();
  for(let i=0;i<args.length;i++){
    const name=args[i];
    if(!['--database-url','--env-file','--output','--profile'].includes(name)||flags.has(name)||!args[i+1]||args[i+1].startsWith('--'))throw new CapacityError('ARGUMENTS_INVALID');
    flags.set(name,args[++i]);
  }
  if(flags.has('--database-url')===flags.has('--env-file'))throw new CapacityError('EXPLICIT_TEST_DATABASE_REQUIRED');
  const profile=flags.get('--profile')??'baseline';
  if(!Object.hasOwn(profiles,profile))throw new CapacityError('PROFILE_INVALID');
  return {profile:profile as Profile,databaseUrl:flags.get('--database-url'),envFile:flags.get('--env-file'),output:flags.has('--output')?localReportPath(root,flags.get('--output')!):undefined};
}
export function percentiles(values:readonly number[]){
  if(values.some(value=>!Number.isFinite(value)||value<0))throw new CapacityError('MEASUREMENT_INVALID');
  const sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted.length?Number(sorted[Math.max(0,Math.ceil(q*sorted.length)-1)].toFixed(3)):null;
  return {count:sorted.length,minMs:at(0),p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:at(1)};
}
export const httpOperations=['http.collections','http.collection','http.items','http.listings','http.activity','http.walletItems','http.launchCollection','http.authGate'] as const;
export type HttpOperation=typeof httpOperations[number];
export type HttpTarget={operation:HttpOperation;path:string;expectedStatus:200|401;shape:'page'|'collection'|'launch'|'auth'};
export type HttpSample={operation:HttpOperation;durationMs:number;status:number|null;ok:boolean;rateLimited:boolean;failure:null|'NETWORK_OR_TIMEOUT'|'BODY_INVALID'|'STATUS_INVALID'};
export async function boundedJson(response:Response){
  const reader=response.body?.getReader();if(!reader)throw new CapacityError('BODY_INVALID');
  let bytes=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1_048_576){await reader.cancel();throw new CapacityError('BODY_INVALID');}chunks.push(part.value);}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function validBody(body:unknown,target:HttpTarget){
  if(!object(body))return false;
  // These measurements verify useful responses rather than timing empty/gated reads.
  if(target.shape==='auth')return object(body.error)&&body.error.code==='AUTH_REQUIRED';
  if(target.shape==='launch')return typeof body.collection==='string'&&body.opened===true&&object(body.terms);
  if(!object(body.context)||body.context.available!==true)return false;
  return target.shape==='page'?Array.isArray(body.items)&&body.items.length>0:object(body.collection);
}
export async function runHttpPhase(input:{origin:string;targets:readonly HttpTarget[];requests:number;concurrency:number;fetcher?:typeof fetch;timeoutMs?:number;durationLimitMs?:number}){
  let origin:URL;try{origin=new URL(input.origin);}catch{throw new CapacityError('LOOPBACK_HTTP_REQUIRED');}
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new CapacityError('LOOPBACK_HTTP_REQUIRED');
  if(!Number.isInteger(input.requests)||input.requests<1||input.requests>1000||!Number.isInteger(input.concurrency)||input.concurrency<1||input.concurrency>16
    ||!input.targets.length||input.targets.length>16||input.targets.some(target=>{
      if(!httpOperations.includes(target.operation)||!target.path.startsWith('/api/oneshot/')||/[\\#\u0000-\u0020]/.test(target.path)||!['page','collection','launch','auth'].includes(target.shape)||![200,401].includes(target.expectedStatus))return true;
      const resolved=new URL(target.path,origin);return resolved.origin!==origin.origin||!resolved.pathname.startsWith('/api/oneshot/');
    })
    ||!Number.isInteger(input.timeoutMs??8000)||(input.timeoutMs??8000)<1||(input.timeoutMs??8000)>10_000
    ||!Number.isInteger(input.durationLimitMs??30_000)||(input.durationLimitMs??30_000)<1||(input.durationLimitMs??30_000)>60_000)throw new CapacityError('WORKLOAD_INVALID');
  const samples:HttpSample[]=[],fetcher=input.fetcher??fetch,started=performance.now();let cursor=0;
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),input.durationLimitMs??30_000);timer.unref();
  async function worker(){
    for(;;){const index=cursor++;if(index>=input.requests||deadline.signal.aborted)return;const target=input.targets[index%input.targets.length],start=performance.now();let status:number|null=null,failure:HttpSample['failure']=null,rateLimited=false;
      try{
        const response=await fetcher(new URL(target.path,origin),{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.any([deadline.signal,AbortSignal.timeout(input.timeoutMs??8000)])});status=response.status;
        let body:unknown;try{body=await boundedJson(response);}catch{throw new CapacityError('BODY_INVALID');}
        if(status===429&&object(body)&&object(body.error)&&body.error.code==='RATE_LIMITED')rateLimited=true;
        else if(status!==target.expectedStatus)failure='STATUS_INVALID';
        else if(!validBody(body,target)||!response.headers.get('cache-control')?.includes('no-store'))failure='BODY_INVALID';
      }catch(error){failure=error instanceof CapacityError&&error.code==='BODY_INVALID'?'BODY_INVALID':'NETWORK_OR_TIMEOUT';}
      samples.push({operation:target.operation,durationMs:performance.now()-start,status,ok:failure===null&&!rateLimited,rateLimited,failure});
    }
  }
  try{await Promise.all(Array.from({length:Math.min(input.concurrency,input.requests)},worker));}finally{clearTimeout(timer);}
  const elapsedMs=performance.now()-started,accepted=samples.filter(sample=>sample.ok),limited=samples.filter(sample=>sample.rateLimited);
  return {concurrency:input.concurrency,complete:samples.length===input.requests,notAttempted:input.requests-samples.length,attempted:samples.length,accepted:accepted.length,rateLimited:limited.length,unexpectedFailures:samples.length-accepted.length-limited.length,elapsedMs:Number(elapsedMs.toFixed(3)),acceptedPerSecond:Number((accepted.length/(elapsedMs/1000)).toFixed(3)),latency:percentiles(samples.map(sample=>sample.durationMs)),acceptedLatency:percentiles(accepted.map(sample=>sample.durationMs)),rateLimitedLatency:percentiles(limited.map(sample=>sample.durationMs)),operations:httpOperations.filter(operation=>samples.some(sample=>sample.operation===operation)).map(operation=>{
    const rows=samples.filter(sample=>sample.operation===operation);return {operation,attempted:rows.length,accepted:rows.filter(sample=>sample.ok).length,rateLimited:rows.filter(sample=>sample.rateLimited).length,unexpectedFailures:rows.filter(sample=>sample.failure!==null).length,latency:percentiles(rows.filter(sample=>sample.ok).map(sample=>sample.durationMs))};
  })};
}
