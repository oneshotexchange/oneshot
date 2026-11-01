import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {acquireIndexerWatchLease} from '../src/watch-lease';

const url=process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL watcher ownership',()=>{
  it('excludes only the same deployment and permits reacquisition after release',async()=>{
    const parsed=new URL(url!);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/oneshot_indexer_test'||parsed.search||parsed.hash)throw new Error('Dedicated loopback test database required.');
    const pool=new Pool({connectionString:url,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,query_timeout:8000});
    const firstId=randomBytes(32).toString('hex'),otherId=randomBytes(32).toString('hex');let first:Awaited<ReturnType<typeof acquireIndexerWatchLease>>|undefined,other:typeof first,restarted:typeof first;
    try{
      first=await acquireIndexerWatchLease(pool,firstId,()=>{});
      await expect(acquireIndexerWatchLease(pool,firstId,()=>{})).rejects.toMatchObject({code:'WATCH_ALREADY_RUNNING'});
      other=await acquireIndexerWatchLease(pool,otherId,()=>{});
      await first.release();restarted=await acquireIndexerWatchLease(pool,firstId,()=>{});expect(restarted).toBeTruthy();
    }finally{await Promise.all([first?.release(),other?.release(),restarted?.release()]);await pool.end();}
  });
  it('signals a terminated lease session and releases ownership for a replacement',async()=>{
    const parsed=new URL(url!);if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/oneshot_indexer_test'||parsed.search||parsed.hash)throw new Error('Dedicated loopback test database required.');
    const application=`oneshot-watch-lease-${randomUUID()}`,id=randomBytes(32).toString('hex');
    const pool=new Pool({connectionString:url,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,query_timeout:8000,application_name:application});
    const lost=vi.fn();let first:Awaited<ReturnType<typeof acquireIndexerWatchLease>>|undefined,restarted:typeof first;
    try{
      first=await acquireIndexerWatchLease(pool,id,lost,250);
      const sessions=await pool.query("SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name=$1 AND l.locktype='advisory' AND l.classid=(hashtext('oneshot_evm_watch')::bigint & 4294967295)::oid AND l.objid=(hashtext($2)::bigint & 4294967295)::oid",[application,id]);
      expect(sessions.rows).toHaveLength(1);
      await pool.query('SELECT pg_terminate_backend($1)',[sessions.rows[0].pid]);
      await vi.waitFor(()=>expect(lost).toHaveBeenCalledTimes(1));await first.release();
      restarted=await acquireIndexerWatchLease(pool,id,()=>{});expect(restarted).toBeTruthy();
    }finally{await Promise.all([first?.release(),restarted?.release()]);await pool.end();}
  });
});
