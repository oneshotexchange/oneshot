import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGenesisReferral, genesisAccountRequest, loadGenesisCampaign, readGenesisReferral } from './client-genesis-api';

afterEach(()=>vi.unstubAllGlobals());
describe('Genesis client identity and failure recovery',()=>{
  it('discards an earlier stored invitation when an explicit malformed referral is opened',()=>{
    const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
    readGenesisReferral('?ref=abcdefghijklmnop',storage);
    expect(readGenesisReferral('?ref=invalid',storage)).toBeNull();expect(readGenesisReferral('',storage)).toBeNull();
  });
  it('rejects an account switch before any request can be sent',async()=>{let scope:string|null='first';const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);await expect(genesisAccountRequest('me',{scope:()=>scope,getToken:async()=>{scope='second';return 'private-token';}})).rejects.toThrow('account changed');expect(fetcher).not.toHaveBeenCalled();});
  it('does not turn unreadable or failed campaign loads into an empty campaign',async()=>{vi.stubGlobal('fetch',async()=>new Response('<html>down</html>',{status:200}));await expect(loadGenesisCampaign()).rejects.toThrow();vi.stubGlobal('fetch',async()=>Response.json({error:{message:'Try later'}},{status:503}));await expect(loadGenesisCampaign()).rejects.toThrow('Try later');});
  it('keeps a valid referral through the OAuth return and works when storage is denied',()=>{const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};expect(readGenesisReferral('?ref=abcdefghijklmnop',storage)).toBe('abcdefghijklmnop');expect(readGenesisReferral('',storage)).toBe('abcdefghijklmnop');clearGenesisReferral(storage);expect(readGenesisReferral('',storage)).toBeNull();expect(readGenesisReferral('?ref=abcdefghijklmnop',{...storage,setItem:()=>{throw new Error('denied');}})).toBe('abcdefghijklmnop');expect(readGenesisReferral('?ref=malformed',storage)).toBeNull();});
});
