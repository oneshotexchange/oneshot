import type {Address} from 'viem';
import {IndexerError,type Block} from './types';
import type {TokenManifest} from './token-manifest';
import {TOKEN_EVENT_LIMITS,type VerifiedTokenEventSource} from './token-event-source';
import type {PostgresTokenEventStore} from './token-event-store';
import type {VerifiedTokenRegistration} from './token-event-types';

type Source=Pick<VerifiedTokenEventSource,'height'|'block'|'verify'|'capture'>;
type Store=Pick<PostgresTokenEventStore,'head'|'block'|'rollbackHead'|'registrations'|'applyBlock'>&{initialize(manifest:TokenManifest):Promise<void>};
const fail=(code:string):never=>{throw new IndexerError(code);};
const same=(a:Block,b:Block)=>a.number===b.number&&a.hash===b.hash&&a.parentHash===b.parentHash&&a.timestamp===b.timestamp;
/** One bounded pass; each complete canonical block is its own atomic checkpoint. */
export async function syncTokenEvents(source:Source,store:Store,manifest:TokenManifest,options:{maximumBlocks?:number;confirmations?:number}={}){
  const maximumBlocks=options.maximumBlocks??8,confirmations=options.confirmations??2;
  if(!Number.isSafeInteger(maximumBlocks)||maximumBlocks<1||maximumBlocks>32||!Number.isSafeInteger(confirmations)||confirmations<0||confirmations>64)return fail('TOKEN_EVENT_SOURCE_LIMIT');
  await store.initialize(manifest);
  const height=await source.height(),initial=await store.head();
  if(initial&&height<initial.number)return fail('TOKEN_SOURCE_BEHIND');
  const targetNumber=height-BigInt(confirmations);
  if(targetNumber<manifest.startBlock)return{applied:0,orphaned:0,complete:false,checkpoint:initial?.number.toString()??null};
  const target=await source.block(targetNumber);await source.verify(manifest,target);
  const orphans:Block[]=[];let ancestor=initial;
  while(ancestor&&!same(await source.block(ancestor.number),ancestor)){
    if(orphans.length>=16)return fail('TOKEN_EVENT_REORG_LIMIT');
    orphans.push(ancestor);
    if(ancestor.number===manifest.startBlock){
      if((await source.block(manifest.startBlock-1n)).hash!==manifest.anchorHash)return fail('TOKEN_DEPLOYMENT_ANCHOR_CHANGED');
      ancestor=null;
    }else{ancestor=await store.block(ancestor.number-1n);if(!ancestor)return fail('TOKEN_EVENT_JOURNAL_INVALID');}
  }
  // Find the complete replacement boundary before mutating stored state.
  if(!same(await source.block(target.number),target))return fail('TOKEN_CHAIN_MOVED');
  for(const orphan of orphans)await store.rollbackHead(orphan);
  let applied=0,head=ancestor;
  for(let next=head?head.number+1n:manifest.startBlock;next<=target.number&&applied<maximumBlocks;next++){
    const before=await store.head();if((before===null)!==(head===null)||before&&head&&!same(before,head))return fail('CONCURRENT_SYNC');
    const known:VerifiedTokenRegistration[]=[];let after:Address|null=null;
    for(;;){
      const page=await store.registrations(after,128);known.push(...page);
      if(known.length>TOKEN_EVENT_LIMITS.maximumMarkets)return fail('TOKEN_EVENT_SOURCE_LIMIT');
      if(page.length<128)break;
      const last=page.at(-1)!.market;if(after!==null&&last<=after)return fail('TOKEN_EVENT_PROJECTION_INVALID');after=last;
    }
    const block=await source.block(next);
    if(block.parentHash!==(head?.hash??manifest.anchorHash))return fail('TOKEN_CHAIN_MOVED');
    const captured=await source.capture(manifest,block,known,target);
    if(!same(captured.block,block))return fail('TOKEN_EVENT_RPC_INVALID');
    const result=await store.applyBlock(block,captured.logs,captured.registrations);
    if(!result.applied)return fail('CONCURRENT_SYNC');
    applied++;head=block;
  }
  return{applied,orphaned:orphans.length,complete:!!head&&head.number>=target.number,checkpoint:head?.number.toString()??null};
}
