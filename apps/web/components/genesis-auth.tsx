import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { customerFetch, customerResponseJson, customerErrorDetails } from '../lib/customer-http';
import { readGenesisReferral } from '../lib/client-genesis-api';

const statusSchema = z.object({ available: z.boolean(), user: z.object({ userId:z.string(),sessionId:z.string(),expiresAt:z.number(),profile:z.object({id:z.string().regex(/^\d{1,32}$/),username:z.string(),name:z.string(),avatarUrl:z.string().nullable()}) }).nullable() });
type Status = z.infer<typeof statusSchema>;
async function request(path:string, body?:unknown, sessionId?:string) {
  const response = await customerFetch('/api/oneshot/genesis/auth/' + path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',...(body===undefined?{}:{headers:{'Content-Type':'application/json',...(sessionId?{'X-Genesis-Session':sessionId}:{})},body:JSON.stringify(body)})});
  const value = await customerResponseJson(response); if(!response.ok)throw new Error(customerErrorDetails(value).message || 'X sign-in is temporarily unavailable. Please try again.'); return value;
}
type Auth = { configured:boolean;isLoading:boolean;authenticated:boolean;userId:string|null;sessionId:string|null;xAccount:NonNullable<Status['user']>['profile']|null;error:string|null;connectX():Promise<void>;disconnect():Promise<void>;refresh():Promise<void>;getAccessToken():Promise<string|null> };
const context = createContext<Auth|null>(null);
export function GenesisAuthProvider({children}:{children:ReactNode}) {
  const [status,setStatus]=useState<Status|null>(null); const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);
  const requests=useRef(0);
  const refresh=useCallback(async()=>{const current=++requests.current;setLoading(true);setError(null);try{const value=statusSchema.parse(await request('session'));if(current===requests.current)setStatus(value);}catch{if(current===requests.current){setStatus(null);setError('X sign-in could not be checked. Please try again.');}}finally{if(current===requests.current)setLoading(false);}},[]);
  useEffect(()=>{void refresh();const reload=()=>void refresh();window.addEventListener('focus',reload);return()=>window.removeEventListener('focus',reload);},[refresh]);
  const connectX=async()=>{
    let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{/* Referral can travel through server OAuth state. */}
    const referral=readGenesisReferral(window.location.search,storage);
    const value=z.object({url:z.string().url()}).parse(await request('start',referral?{referral}:{}));const url=new URL(value.url);
    if(url.origin!=='https://x.com'||url.pathname!=='/i/oauth2/authorize')throw new Error('X sign-in could not open. Please try again.');
    window.location.assign(url.href);
  };
  const disconnect=async()=>{await request('logout',{},status?.user?.sessionId);requests.current++;setLoading(false);setStatus(previous=>previous?{...previous,user:null}:null);};
  const value:Auth={configured:status?.available||false,isLoading:loading,authenticated:Boolean(status?.user),userId:status?.user?.userId||null,sessionId:status?.user?.sessionId||null,xAccount:status?.user?.profile||null,error,connectX,disconnect,refresh,getAccessToken:async()=>null};
  return <context.Provider value={value}>{children}</context.Provider>;
}
export function useGenesisAuth(){const value=useContext(context);if(!value)throw new Error('Genesis sign-in is unavailable.');return value;}
