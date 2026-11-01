import {describe,it,expect,vi} from 'vitest';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {localReportPath,parseCapacityArguments,percentiles,runHttpPhase,testDatabaseUrl,writeCapacityReport,type HttpTarget} from './lib/capacity';

describe('bounded local capacity rehearsal',()=>{
  it('requires an explicitly selected loopback test database, never a production-looking database',()=>{
    expect(testDatabaseUrl('postgresql://test:secret@127.0.0.1:5433/oneshot_indexer_test')).toContain('oneshot_indexer_test');
    for(const value of ['postgresql://test:secret@remote.example/oneshot_test','postgresql://test:secret@127.0.0.1/oneshot_dev','postgresql://test:secret@127.0.0.1/oneshot_test?host=remote','postgresql://test:secret@127.0.0.1/oneshot_test#private','invalid-secret']){
      try{testDatabaseUrl(value);throw new Error('expected guard');}catch(error){expect(String(error)).toContain('DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED');expect(String(error)).not.toContain('secret');}
    }
    expect(()=>parseCapacityArguments([],process.cwd())).toThrow('EXPLICIT_TEST_DATABASE_REQUIRED');
    expect(()=>parseCapacityArguments(['--database-url','x','--env-file','y'],process.cwd())).toThrow('EXPLICIT_TEST_DATABASE_REQUIRED');
    expect(()=>parseCapacityArguments(['--database-url','x','--profile','unbounded'],process.cwd())).toThrow('PROFILE_INVALID');
    expect(()=>parseCapacityArguments(['--database-url','x','--database-url','y'],process.cwd())).toThrow('ARGUMENTS_INVALID');
  });
  it('restricts reports to fresh local JSON paths',()=>{
    expect(localReportPath(process.cwd(),'.local/qa/capacity.json')).toBe(path.resolve('.local/qa/capacity.json'));
    for(const value of ['../outside.json','.local/../outside.json','.local/qa/secrets.env','.local'])expect(()=>localReportPath(process.cwd(),value)).toThrow('LOCAL_JSON_REPORT_REQUIRED');
  });
  it('preserves existing reports and rejects a linked report directory outside its workspace',async()=>{
    const parent=path.resolve('.local/capacity-unit-tests');await mkdir(parent,{recursive:true});const owned=await mkdtemp(path.join(parent,'case-'));
    const workspace=path.join(owned,'workspace'),outside=path.join(owned,'outside');await mkdir(path.join(workspace,'.local/qa'),{recursive:true});await mkdir(outside);
    try{
      const report=path.join(workspace,'.local/qa/report.json');await writeCapacityReport(workspace,report,{passed:true});
      await expect(writeCapacityReport(workspace,report,{passed:false})).rejects.toMatchObject({code:'EEXIST'});
      expect(JSON.parse(await readFile(report,'utf8'))).toEqual({passed:true});
      await symlink(outside,path.join(workspace,'.local/qa/linked'),process.platform==='win32'?'junction':'dir');
      await expect(writeCapacityReport(workspace,path.join(workspace,'.local/qa/linked/new/report.json'),{})).rejects.toThrow('LOCAL_JSON_REPORT_REQUIRED');
      await expect(readFile(path.join(outside,'new/report.json'))).rejects.toMatchObject({code:'ENOENT'});
    }finally{if(path.dirname(path.resolve(owned))!==parent)throw new Error('Unsafe capacity test cleanup.');await rm(owned,{recursive:true,force:true});}
  });
  it('computes nearest-rank percentiles and rejects impossible timings',()=>{
    expect(percentiles([])).toMatchObject({count:0,p95Ms:null});
    expect(percentiles(Array.from({length:100},(_,i)=>i+1))).toMatchObject({minMs:1,p50Ms:50,p95Ms:95,p99Ms:99,maxMs:100});
    for(const value of [NaN,Infinity,-1])expect(()=>percentiles([value])).toThrow('MEASUREMENT_INVALID');
  });
  const targets:HttpTarget[]=[{operation:'http.collections',path:'/api/oneshot/indexed/collections?limit=20',shape:'page',expectedStatus:200}];
  const response=(status:number,body:unknown)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  it('bounds concurrency, checks bodies, separates rate limits and omits request/response contents',async()=>{
    let active=0,peak=0,calls=0;
    const fetcher=vi.fn(async()=>{const number=++calls;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
      return number%3===0?response(429,{error:{code:'RATE_LIMITED',message:'private-provider-secret'}}):response(200,{context:{available:true},items:[{owner:'private-owner'}]});
    });
    const result=await runHttpPhase({origin:'http://127.0.0.1:1234',targets,requests:12,concurrency:3,fetcher});
    expect(peak).toBe(3);expect(result).toMatchObject({attempted:12,accepted:8,rateLimited:4,unexpectedFailures:0});
    for(const value of ['private-owner','private-provider-secret','?limit','127.0.0.1'])expect(JSON.stringify(result)).not.toContain(value);
  });
  it('fails gated empty reads, malformed bodies, redirects, timeouts and unexpected statuses',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response(200,{context:{available:false},items:[]})).mockResolvedValueOnce(new Response('not json')).mockResolvedValueOnce(response(503,{error:{code:'UNAVAILABLE'}})).mockRejectedValueOnce(new Error('secret-api-token'));
    const result=await runHttpPhase({origin:'http://127.0.0.1:1234',targets,requests:4,concurrency:1,fetcher});
    expect(result).toMatchObject({accepted:0,rateLimited:0,unexpectedFailures:4});expect(JSON.stringify(result)).not.toContain('secret-api-token');
    await expect(runHttpPhase({origin:'https://external.example',targets,requests:1,concurrency:1,fetcher})).rejects.toThrow('LOOPBACK_HTTP_REQUIRED');
    await expect(runHttpPhase({origin:'http://127.0.0.1:1234',targets,requests:1,concurrency:17,fetcher})).rejects.toThrow('WORKLOAD_INVALID');
    await expect(runHttpPhase({origin:'http://127.0.0.1:1234',targets:[{...targets[0],path:'/api/oneshot/../../secret'}],requests:1,concurrency:1,fetcher})).rejects.toThrow('WORKLOAD_INVALID');
  });
  it('stops scheduling after a phase deadline and reports incomplete work',async()=>{
    const fetcher=vi.fn(async(_url:unknown,options?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{options!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
    const result=await runHttpPhase({origin:'http://127.0.0.1:1234',targets,requests:100,concurrency:2,durationLimitMs:10,fetcher});
    expect(result).toMatchObject({complete:false,attempted:2,notAttempted:98,unexpectedFailures:2});expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
