import type {SqlClient,SqlPool} from '../../../indexer/src/store';
import {ApiError} from './errors';

export const NFT_EXPLORER_SQL_TIMEOUT_MS=10000;
const timeout=()=>new ApiError(504,'NFT_EXPLORER_TIMEOUT','Collection items could not be checked in time. Please try again.');

/** One explorer lease, including acquisition and rollback, has a fixed deadline.
 * A timed-out connection is destroyed rather than returned to the shared pool.
 * The other indexed resources continue using their existing ordinary leases. */
export async function acquireNftExplorerSql(pool:SqlPool,externalSignal?:AbortSignal):Promise<SqlClient>{
  const controller=new AbortController(),signal=externalSignal?AbortSignal.any([externalSignal,controller.signal]):controller.signal;
  let raw:SqlClient|undefined,released=false,closed=false,poisoned=false;
  const timer=setTimeout(()=>controller.abort(),NFT_EXPLORER_SQL_TIMEOUT_MS);
  let rejectDeadline!:(error:ApiError)=>void;
  const deadline=new Promise<never>((_resolve,reject)=>{rejectDeadline=reject;});
  // The deadline can fire while no query is awaiting it, for example during an
  // RPC recheck. Keep it observed until the request reaches its next lease use.
  void deadline.catch(()=>undefined);
  const detach=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  const releaseRaw=(destroy?:boolean|Error)=>{
    if(!raw||released)return;released=true;
    if(destroy===undefined)raw.release();else raw.release(destroy);
  };
  const abort=()=>{
    if(poisoned||closed)return;poisoned=true;
    try{releaseRaw(true);}catch{/* Destruction errors must not escape the abort event or expose driver details. */}
    detach();rejectDeadline(timeout());
  };
  const active=()=>{
    if(signal.aborted||poisoned){abort();throw timeout();}
    if(closed)throw new ApiError(503,'NFT_EXPLORER_SQL_CLOSED','Collection items are temporarily unavailable. Refresh this collection and try again.');
  };
  signal.addEventListener('abort',abort,{once:true});
  try{
    active();
    const pending=Promise.resolve().then(()=>{active();return pool.connect();}).then(client=>{
      raw=client;
      if(signal.aborted||poisoned||closed){try{releaseRaw(true);}catch{/* A lease acquired after cancellation must never re-enter the pool. */}throw timeout();}
      return client;
    });
    await Promise.race([pending,deadline]);active();
    return{
      async query(sql,values){
        active();
        const operation=Promise.resolve().then(()=>{active();return raw!.query(sql,values);});
        try{const result=await Promise.race([operation,deadline]);active();return result;}
        catch(error){if(signal.aborted||poisoned){abort();throw timeout();}throw error;}
      },
      release(destroy){
        if(closed)return;closed=true;detach();releaseRaw(poisoned||signal.aborted?true:destroy);
      },
    };
  }catch(error){
    if(signal.aborted||poisoned){abort();detach();throw timeout();}
    detach();throw error;
  }
}
