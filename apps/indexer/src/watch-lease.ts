import type {Pool,PoolClient} from 'pg';
import {IndexerError} from './types';

/** A dedicated session lock prevents two local watchers for the same deployment.
 * Losing that session stops its owner; transaction locks still protect each block.
 */
export async function acquireIndexerWatchLease(pool:Pool,manifestId:string,onLost:()=>void,heartbeatMs=5000){
  if(!/^[a-f0-9]{64}$/.test(manifestId)||!Number.isSafeInteger(heartbeatMs)||heartbeatMs<250||heartbeatMs>60_000)throw new IndexerError('WATCH_LEASE_OPTIONS_INVALID');
  let client:PoolClient;
  try{client=await pool.connect();}catch{throw new IndexerError('WATCH_LEASE_UNAVAILABLE');}
  let released=false,lost=false,locked=false,timer:ReturnType<typeof setTimeout>|undefined,heartbeat:Promise<void>|undefined,releaseTask:Promise<void>|undefined;
  const markLost=()=>{if(released||lost)return;lost=true;if(timer)clearTimeout(timer);try{onLost();}catch{/* A callback cannot turn a connection event into an unhandled error. */}};
  client.on('error',markLost);client.on('end',markLost);
  const removeListeners=()=>{client.removeListener('error',markLost);client.removeListener('end',markLost);};
  try{
    // This connection is reserved and destroyed on release; settings never leak to another borrower.
    await client.query("SET statement_timeout='5000ms'");
    const result=await client.query("SELECT pg_try_advisory_lock(hashtext('oneshot_evm_watch'),hashtext($1)) AS acquired",[manifestId]);
    if(result.rows[0]?.acquired!==true)throw new IndexerError('WATCH_ALREADY_RUNNING');
    locked=true;
    if(lost)throw new IndexerError('WATCH_LEASE_LOST');
  }catch(error){
    released=true;removeListeners();client.release(true);
    if(error instanceof IndexerError)throw error;
    throw new IndexerError('WATCH_LEASE_UNAVAILABLE');
  }
  function schedule(){if(released||lost)return;timer=setTimeout(()=>{
    heartbeat=(async()=>{try{await client.query('SELECT 1');}catch{markLost();}finally{schedule();}})();
  },heartbeatMs);timer.unref();}
  schedule();
  function release(){
    if(releaseTask)return releaseTask;
    released=true;if(timer)clearTimeout(timer);
    releaseTask=(async()=>{
      try{
        await heartbeat;
        if(locked&&!lost){const result=await client.query("SELECT pg_advisory_unlock(hashtext('oneshot_evm_watch'),hashtext($1)) AS released",[manifestId]);if(result.rows[0]?.released!==true)throw new Error();}
      }catch{throw new IndexerError('WATCH_LEASE_RELEASE_FAILED');}
      finally{removeListeners();client.release(true);}
    })();
    return releaseTask;
  }
  return {release};
}
