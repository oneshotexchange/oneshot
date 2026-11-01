import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {acquireIndexerWatchLease} from '../src/watch-lease';

const id='ab'.repeat(32);
function fixture(acquired=true){
  const client=Object.assign(new EventEmitter(),{query:vi.fn(async(sql:string)=>sql.startsWith('SELECT pg_try')?{rows:[{acquired}]}:sql.startsWith('SELECT pg_advisory_unlock')?{rows:[{released:true}]}:{rows:[]}),release:vi.fn()});
  const pool={connect:vi.fn(async()=>client)} as unknown as Pool;return {client,pool};
}
afterEach(()=>vi.useRealTimers());
describe('dedicated local indexer watch lease',()=>{
  it('rejects malformed identities before opening a connection',async()=>{const test=fixture();await expect(acquireIndexerWatchLease(test.pool,'private-invalid-id',()=>{})).rejects.toMatchObject({code:'WATCH_LEASE_OPTIONS_INVALID'});expect(test.pool.connect).not.toHaveBeenCalled();});
  it('refuses a second owner without exposing identity and destroys only its borrowed connection',async()=>{const test=fixture(false);await expect(acquireIndexerWatchLease(test.pool,id,()=>{})).rejects.toMatchObject({code:'WATCH_ALREADY_RUNNING'});expect(test.client.release).toHaveBeenCalledExactlyOnceWith(true);});
  it('releases once after heartbeat settles and never calls the loss callback on normal close',async()=>{
    vi.useFakeTimers();const test=fixture(),lost=vi.fn(),lease=await acquireIndexerWatchLease(test.pool,id,lost,250);await vi.advanceTimersByTimeAsync(250);expect(test.client.query).toHaveBeenCalledWith('SELECT 1');
    const one=lease.release(),two=lease.release();expect(one).toBe(two);await one;await vi.advanceTimersByTimeAsync(1000);expect(test.client.release).toHaveBeenCalledTimes(1);expect(lost).not.toHaveBeenCalled();expect(test.client.listenerCount('error')).toBe(0);
  });
  it('signals loss once for a terminated session and skips unlock on an unusable connection',async()=>{
    const test=fixture(),lost=vi.fn(),lease=await acquireIndexerWatchLease(test.pool,id,lost);test.client.emit('error',new Error('postgresql://secret'));test.client.emit('end');expect(lost).toHaveBeenCalledTimes(1);await lease.release();expect(test.client.query.mock.calls.filter(([sql])=>sql.startsWith('SELECT pg_advisory_unlock'))).toHaveLength(0);
  });
  it('stops heartbeat after a query failure and keeps errors static',async()=>{
    vi.useFakeTimers();const test=fixture(),lost=vi.fn(),lease=await acquireIndexerWatchLease(test.pool,id,lost,250);test.client.query.mockImplementation(async()=>{throw new Error('private-password');});await vi.advanceTimersByTimeAsync(1000);expect(lost).toHaveBeenCalledTimes(1);await lease.release();
  });
});
