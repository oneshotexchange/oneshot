import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount, type IndexedNftItem } from '@oneshot/evm';
import { useWallet } from '../lib/client-wallet';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchAction, type NftLaunchContext, type NftLaunchState, type NftTransactionRecord, type PublicNftCollection, type PublicNftStage } from '../lib/client-nft-launch';
import { createNftPendingStore, type PendingNftTransaction } from '../lib/client-nft-recovery';
import { Address, Badge, Button, ErrorState, Field, InfoRow, SafetyNote } from './ui';
import { WalletButton } from './wallet-button';
import { NftFloorSettings } from './nft-floor-settings';
import { useNftIndexedSync } from '../lib/client-indexed-sync';
import { NftIndexedSyncNotice } from './nft-indexed-sync';
import Link from './navigation';
import { nftDeployedCollectionHref, nftDraftResumeHref } from '../lib/client-nft-handoff';
import { NftReviewSummary, NftTransactionData, nftTransactionPhase } from './nft-review-summary';

const money = (value: string) => `${formatIndexedAmount(value,18)} ETH`;
const busyPhases = ['reviewing','validating','signing','confirming'];
const actionName: Partial<Record<NftLaunchAction,string>> = {create:'Create collection',configure:'Set mint phases',open:'Open mint',mint:'Mint NFTs',approve:'Approve this NFT for resale',list:'List this NFT',buy:'Buy this NFT',cancel:'Cancel this listing',claim:'Claim proceeds',policy:'Update resale price floor'};
function date(seconds: string) { const value = BigInt(seconds); return value > 8_640_000_000_000n ? 'Outside the displayable date range' : new Date(Number(value)*1000).toLocaleString(); }
export function ReviewResult({state,onApprove,onCheck,canApprove,confirmationChanged=false}:{state:NftLaunchState;onApprove?:()=>void;onCheck:()=>void;canApprove?:boolean;confirmationChanged?:boolean}) {
  return <>
    {state.review && <div className="nft-launch-review section-gap">
      <div className="section-header"><h3>Transaction review</h3><Badge tone={state.phase==='success'&&!confirmationChanged?'mint':'amber'}>{confirmationChanged?'Confirmation changed':nftTransactionPhase(state.phase)}</Badge></div>
      <p className="field-hint">{actionName[state.review.action] || state.review.action}</p>
      <div className="review-rows"><InfoRow label="Network">Test network (31337), ETH</InfoRow><InfoRow label="From"><Address value={state.review.from} full /></InfoRow><InfoRow label="To"><Address value={state.review.to} full /></InfoRow><InfoRow label="Transaction value">{money(state.review.value)}<small className="indexed-subline">{state.review.value} wei</small></InfoRow><InfoRow label="Estimated gas">{state.review.simulation.gasEstimate} gas units, paid separately</InfoRow>
        <NftReviewSummary summary={state.review.summary} action={state.review.action} />
        <InfoRow label="Review expires">{new Date(state.review.expiresAt).toLocaleString()}</InfoRow>
      </div>
      <NftTransactionData data={state.review.data} />
      {state.phase==='review' && onApprove && <Button type="button" disabled={!canApprove} onClick={onApprove}>Approve in wallet</Button>}
    </div>}
    {state.message && !confirmationChanged && <div className="section-gap" aria-live="polite">{['error','rejected','reverted'].includes(state.phase)?<ErrorState message={state.message}/>:<p className="data-notice">{state.message}</p>}</div>}
    {state.hash && <div className="nft-launch-receipt"><InfoRow label="Transaction"><span className="indexed-hash">{state.hash}</span></InfoRow><p className="field-hint">Keep this transaction hash to check its confirmation later.</p><Button type="button" variant="secondary" disabled={busyPhases.includes(state.phase)} onClick={onCheck}>Check receipt</Button></div>}
  </>;
}
function Stage({name,stage}:{name:string;stage:PublicNftStage}) {
  return <div className="nft-checkout-stage"><h3>{name}</h3><InfoRow label="Price per NFT">{money(stage.priceRaw)}</InfoRow><InfoRow label="Starts">{date(stage.start)}</InfoRow><InfoRow label="Ends">{date(stage.end)}</InfoRow><InfoRow label="Per-wallet limit">{stage.walletLimitRaw}</InfoRow></div>;
}

/** Public collection terms and checkout. Every spender signs through their own linked Privy wallet. */
export function NftCheckout({collection,item,indexedDeploymentId,onRefresh}:{collection:string;item?:IndexedNftItem;indexedDeploymentId?:string|null;onRefresh?:()=>void}) {
  const wallet=useWallet(), latestWallet=useRef(wallet); latestWallet.current=wallet;
  const api=useMemo(()=>createNftLaunchApi({identityScope:()=>latestWallet.current.identityScope(),getAccessToken:()=>latestWallet.current.getAccessToken()}),[]);
  const [details,setDetails]=useState<PublicNftCollection|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
  const [action,setAction]=useState<NftLaunchAction>(item?.listing?.status==='active'?'buy':item?'approve':'mint');
  const [quantity,setQuantity]=useState('1'),[price,setPrice]=useState(''),[recipient,setRecipient]=useState(''),[claimSource,setClaimSource]=useState('marketplace'),[ack,setAck]=useState(false),[clock,setClock]=useState(Date.now());
  const currentCollection=useRef(collection); currentCollection.current=collection; const generation=useRef(0);
  const scope=wallet.identityScope();
  const selectionKey=item?JSON.stringify([collection.toLowerCase(),item.tokenId,item.owner,item.listing?.id,item.listing?.status]):collection.toLowerCase();
  const context=useRef<NftLaunchContext>({identityScope:scope,address:wallet.account?.address||null,chainId:wallet.network?.chainId||null,draftId:collection.toLowerCase(),revision:0,prepared:false,scope:'public',userId:wallet.userId});
  const matchingDeployment=Boolean(details && details.collection.toLowerCase()===collection.toLowerCase() && (!indexedDeploymentId || indexedDeploymentId===details.deploymentId));
  context.current={identityScope:scope,address:wallet.account?.address||null,chainId:wallet.network?.chainId||null,draftId:collection.toLowerCase(),revision:0,prepared:Boolean(matchingDeployment&&details?.opened),deploymentId:details?.deploymentId,scope:'public',userId:wallet.userId,selectionKey,termsHash:details?.termsHash};
  const controller=useMemo(()=>createNftLaunchController({api,context:()=>context.current,sendEvmTransaction:tx=>latestWallet.current.sendEvmTransaction(tx)}),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const busy=busyPhases.includes(state.phase),submitted=Boolean(state.hash&&!['confirmed','reverted'].includes(state.receipt?.status||''));
  const ready=Boolean(details?.opened&&matchingDeployment&&wallet.authenticated&&wallet.connected&&scope&&wallet.network?.chainId===31337);
  const localSender=wallet.account?.address.toLowerCase();
  const actions: NftLaunchAction[]=item?(item.listing?.status==='active'?(item.listing.seller.toLowerCase()===localSender?['cancel']:['buy']):item.owner?.toLowerCase()===localSender?['approve','list']:[]):['mint','claim'];
  async function refresh(){ const ticket=++generation.current,target=collection;setLoading(true);setError(null);try{const value=await api.collection(target);if(ticket!==generation.current||currentCollection.current!==target)return;setDetails(value);}catch(reason){if(ticket===generation.current){setDetails(null);setError(reason instanceof Error?reason.message:'Current collection terms are unavailable.');}}finally{if(ticket===generation.current)setLoading(false);}}
  useEffect(()=>{setDetails(null);void refresh();return()=>{generation.current+=1;};},[collection]);
  useEffect(()=>{controller.syncContext();setAck(false);},[controller,scope,collection,details?.deploymentId,details?.termsHash,details?.opened,matchingDeployment,selectionKey]);
  useEffect(()=>{if(actions.length&&!actions.includes(action)){controller.invalidate('Choose an action for the current wallet and NFT.');setAction(actions[0]);}},[localSender,item?.listing?.id,item?.listing?.status,item?.owner]);
  useEffect(()=>{if(state.phase!=='review')return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[state.phase]);
  const indexedSync=useNftIndexedSync({scope:scope?JSON.stringify([scope,wallet.userId,wallet.account?.address,wallet.network?.chainId,collection,details?.deploymentId,indexedDeploymentId,selectionKey]):null,
    review:state.review,receipt:state.receipt,hash:state.hash,enabled:state.phase==='success',readReceipt:api.receipt,onRefresh:()=>{void refresh();onRefresh?.();}});
  useEffect(()=>()=>controller.invalidate('The checkout was closed.'),[controller]);
  function change(callback:()=>void){controller.invalidate('The checkout details changed. Prepare a fresh review.');callback();}
  function prepare(){if(!ready||!ack||!wallet.account||!actions.includes(action))return;void controller.prepare({from:wallet.account.address,collection,action,localEthAcknowledged:true,
    ...(action==='mint'?{quantity,...(recipient.trim()?{recipient:recipient.trim()}:{})}:{}),
    ...(['approve','list'].includes(action)&&item?{tokenId:item.tokenId}:{}),...(action==='list'?{price}:{}),
    ...(['buy','cancel'].includes(action)&&item?.listing?{listingId:item.listing.id,...(recipient.trim()?{recipient:recipient.trim()}:{})}:{}),
    ...(action==='claim'?{...(claimSource==='collection'?{contract:collection}:{}),...(recipient.trim()?{recipient:recipient.trim()}:{})}:{}),
  });setClock(Date.now());}
  const chainTime=details?BigInt(details.blockTimestamp):0n;
  const allowlistActive=Boolean(details&&details.terms.allowlistRoot!==`0x${'0'.repeat(64)}`&&chainTime>=BigInt(details.terms.allowlist.start)&&chainTime<BigInt(details.terms.allowlist.end));
  const publicActive=Boolean(details&&chainTime>=BigInt(details.terms.publicMint.start)&&chainTime<BigInt(details.terms.publicMint.end));
  const heading = !item ? 'Mint from this collection' : item.listing?.status === 'active' ? item.listing.seller.toLowerCase() === localSender ? 'Your NFT listing' : 'Buy this NFT' : item.owner?.toLowerCase() === localSender ? 'List your NFT' : 'NFT availability';
  const introduction = !item ? 'Choose how many to mint, then check the total before wallet approval.' : item.listing?.status === 'active' ? item.listing.seller.toLowerCase() === localSender ? 'Review your listing or cancel it to recover the NFT.' : 'Review the price, fees and recipient before buying.' : item.owner?.toLowerCase() === localSender ? 'Approve marketplace access, then set your listing price.' : 'This NFT is not currently listed for sale.';
  return <section className="panel nft-launch-panel" aria-label={item?'NFT checkout':'Collection mint checkout'}>
    <div className="section-header"><div><h2>{heading}</h2><p>{introduction}</p></div><Button type="button" variant="ghost" loading={loading} onClick={()=>void refresh()}>Refresh terms</Button></div>
    {details && matchingDeployment && <SafetyNote amber>This collection uses test ETH on a local test network. Minting and trading on Zero are unavailable.</SafetyNote>}
    {error&&<ErrorState message={error} retry={()=>void refresh()}/>}
    {details&&details.collection.toLowerCase()===collection.toLowerCase()&&<><div className="review-rows"><InfoRow label="Collection"><Address value={details.collection} full/></InfoRow><InfoRow label="Minted / maximum supply">{details.totalMintedRaw} / {details.terms.maxSupplyRaw}</InfoRow><InfoRow label="Creator royalty">{details.terms.royaltyBps/100}% on resale</InfoRow><InfoRow label="Terms">{details.opened?'Permanently frozen':'Mint has not opened'}</InfoRow><InfoRow label="Current mint phase">{allowlistActive?'Allowlist':publicActive?'Public mint':'No active mint phase'}</InfoRow><InfoRow label="Last checked">{details.blockNumber}, {date(details.blockTimestamp)}</InfoRow></div><div className="field-grid section-gap">{details.terms.allowlistRoot!==`0x${'0'.repeat(64)}`&&<Stage name="Allowlist mint" stage={details.terms.allowlist}/>}<Stage name="Public mint" stage={details.terms.publicMint}/></div></>}
    {details&&!matchingDeployment&&<ErrorState message="This collection’s network changed. Refresh the page before continuing."/>}
    {details&&!details.opened&&<p className="data-notice">Minting opens after the creator locks the collection terms.</p>}
    {(!wallet.authenticated||!wallet.connected)&&<div className="button-row section-gap"><WalletButton/><span className="field-hint">Connect a wallet to continue.</span></div>}
    {wallet.authenticated&&wallet.connected&&wallet.network?.chainId!==31337&&<p className="data-notice">Switch your wallet to the test network (31337) to continue.</p>}
    {ready&&actions.length>0&&<><div className="field-grid section-gap"><Field label="Action"><select value={action} disabled={busy||submitted} onChange={event=>change(()=>setAction(event.target.value as NftLaunchAction))}>{actions.map(value=><option key={value} value={value}>{actionName[value]}</option>)}</select></Field>
      {action==='mint'&&<Field label="Quantity" required><input inputMode="numeric" value={quantity} disabled={busy||submitted} onChange={event=>change(()=>setQuantity(event.target.value))}/></Field>}
      {action==='list'&&<Field label="Listing amount (test ETH)" required hint="Review the final buyer total before wallet approval. Platform fee and royalty are included."><input inputMode="decimal" value={price} disabled={busy||submitted} onChange={event=>change(()=>setPrice(event.target.value))}/></Field>}
      {action==='claim'&&<Field label="Proceeds"><select value={claimSource} disabled={busy||submitted} onChange={event=>change(()=>setClaimSource(event.target.value))}><option value="marketplace">Resale proceeds</option><option value="collection">Mint proceeds</option></select></Field>}
      {['mint','buy','cancel','claim'].includes(action)&&<Field label="Recipient" hint="Leave blank for your selected wallet."><input value={recipient} placeholder={wallet.account?.address} disabled={busy||submitted} onChange={event=>change(()=>setRecipient(event.target.value))}/></Field>}
    </div><label className="checkbox-field"><input type="checkbox" checked={ack} disabled={busy||submitted} onChange={event=>{if(!event.target.checked)controller.invalidate('Local ETH acknowledgement was removed.');setAck(event.target.checked);}}/><span>I understand this uses test ETH on chain 31337 and requires gas.</span></label><Button type="button" variant="secondary" disabled={!ack||busy||submitted||(action==='mint'&&!allowlistActive&&!publicActive)} onClick={prepare}>Review transaction</Button></>}
    {ready&&item&&actions.length===0&&<p className="data-notice">Only its owner wallet can create a listing.</p>}
    <ReviewResult state={state} confirmationChanged={indexedSync.phase==='reorg'} canApprove={ready&&ack&&Boolean(state.review&&Date.parse(state.review.expiresAt)>clock)} onApprove={()=>void controller.approve()} onCheck={()=>void controller.refreshReceipt()}/>
    <NftIndexedSyncNotice state={indexedSync} onRetry={indexedSync.retry}/>
    <NftFloorSettings collection={collection}/>
  </section>;
}

/** Explicitly checks saved broadcasts; restoring this panel never opens a wallet prompt. */
export function NftTransactionRecovery({onRefresh}:{onRefresh?:()=>void} = {}){
  const wallet=useWallet(),latestWallet=useRef(wallet);latestWallet.current=wallet;
  const api=useMemo(()=>createNftLaunchApi({identityScope:()=>latestWallet.current.identityScope(),getAccessToken:()=>latestWallet.current.getAccessToken()}),[]),pending=useMemo(()=>createNftPendingStore(),[]);
  const [records,setRecords]=useState<NftTransactionRecord[]>([]),[fallback,setFallback]=useState<PendingNftTransaction[]>([]),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[deployment,setDeployment]=useState<string|null>(null);
  const [dataScope,setDataScope]=useState<string|null>(null),[checked,setChecked]=useState(false);
  const scope=wallet.identityScope(), generation=useRef(0);
  const context=useRef<NftLaunchContext>({identityScope:scope,address:wallet.account?.address||null,chainId:wallet.network?.chainId||null,draftId:'recovery',revision:0,prepared:false,userId:wallet.userId});
  context.current={identityScope:scope,address:wallet.account?.address||null,chainId:wallet.network?.chainId||null,draftId:'recovery',revision:0,prepared:Boolean(deployment),deploymentId:deployment,userId:wallet.userId};
  const controller=useMemo(()=>createNftLaunchController({api,context:()=>context.current,sendEvmTransaction:async()=>{throw new Error('Recovery never requests wallet submission.');},pendingStore:pending}),[api,pending]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const indexedSync=useNftIndexedSync({scope:scope?JSON.stringify([scope,wallet.userId,wallet.account?.address,wallet.network?.chainId,deployment,state.review?.id,state.review?.summary.collection]):null,
    review:state.review,receipt:state.receipt,hash:state.hash,enabled:state.phase==='success',readReceipt:api.receipt,onRefresh:()=>onRefresh?.()});
  useEffect(()=>{generation.current+=1;setRecords([]);setCursor(null);setError(null);setLoading(false);setChecked(false);setDeployment(null);setFallback(wallet.userId?pending.list(wallet.userId,wallet.account?.address):[]);setDataScope(scope);controller.syncContext();},[scope,wallet.userId,wallet.account?.address,controller,pending]);
  async function load(more=false){if(!wallet.userId||!wallet.account||!scope)return;const ticket=++generation.current,captured=scope;setLoading(true);setError(null);try{const [page,status]=await Promise.all([api.transactions({wallet:wallet.account.address,limit:20,...(more&&cursor?{cursor}:{})}),api.status()]);if(ticket!==generation.current||latestWallet.current.identityScope()!==captured)return;setRecords(previous=>{const values=more?[...previous,...page.items]:page.items;return [...new Map(values.map(item=>[item.review.id,item])).values()];});setCursor(page.nextCursor||null);setChecked(true);setDeployment(status.enabled?status.deploymentId:null);setFallback(pending.list(wallet.userId,wallet.account.address));if(!status.enabled)setError('The test network is unavailable. Please try again later.');}catch(reason){if(ticket===generation.current)setError(reason instanceof Error?reason.message:'Saved transactions could not be loaded.');}finally{if(ticket===generation.current)setLoading(false);}}
  async function recover(id:string,knownHash?:string){const captured=scope;setError(null);try{const status=await api.status();if(latestWallet.current.identityScope()!==captured)return;if(!status.enabled||!status.deploymentId)throw new Error('The test network is unavailable. Please try again later.');setDeployment(status.deploymentId);context.current={...context.current,prepared:true,deploymentId:status.deploymentId};const saved=await api.reviewRecord(id);if(latestWallet.current.identityScope()!==captured)return;await controller.recover(saved,knownHash);}catch(reason){if(latestWallet.current.identityScope()===captured)setError(reason instanceof Error?reason.message:'The transaction could not be recovered.');}}
  const visibleRecords=dataScope===scope&&wallet.userId?records:[],visibleFallback=dataScope===scope&&wallet.userId?fallback:[];
  const serverIds=new Set(visibleRecords.map(item=>item.review.id));
  const recoveredCreate = dataScope === scope && wallet.authenticated && state.phase === 'success' && state.receipt?.status === 'confirmed'
    && indexedSync.phase !== 'reorg' && state.review?.action === 'create' && state.review.deploymentId === deployment ? state.review : null;
  const recoveredDraftHref = recoveredCreate ? nftDraftResumeHref(recoveredCreate.draftId, recoveredCreate.id) : null;
  const recoveredCollectionHref = recoveredCreate ? nftDeployedCollectionHref(state.receipt?.collection, recoveredCreate.deploymentId) : null;
  return <section className="panel nft-launch-panel" aria-label="Transaction recovery"><div className="section-header"><div><h2>Your saved transactions</h2><p>Check pending and completed transactions for your selected wallet.</p></div>{wallet.authenticated&&wallet.connected&&<Button type="button" variant="secondary" loading={loading} onClick={()=>void load()}>Load saved transactions</Button>}</div>
    {!wallet.authenticated?<div className="button-row section-gap"><WalletButton/><span className="field-hint">Sign in with the account that submitted the transaction.</span></div>:!wallet.connected?<div className="button-row section-gap"><WalletButton/><span className="field-hint">Connect a wallet to check its saved transactions.</span></div>:<>
      {error&&<ErrorState message={error}/>}
      {!loading&&visibleRecords.length===0&&visibleFallback.length===0&&<p className="data-notice">{checked && dataScope===scope ? "No saved transactions for this wallet." : "Load your saved transactions to check their status."}</p>}
      {visibleRecords.map(item=>{const local=visibleFallback.find(saved=>saved.reviewId===item.review.id),hash=item.transactionHash||local?.hash;return <div className="nft-recovery-row" key={item.review.id}><div><strong>{actionName[item.review.action]||item.review.action}</strong><span className="indexed-subline">{money(item.review.value)}, last saved status: {{review:"Unsigned",submitted:"Submitted",confirmed:"Confirmed",reverted:"Failed"}[item.outcome]}</span><span className="indexed-hash">{hash||'Unsigned review'}</span></div>{hash?<Button type="button" variant="secondary" disabled={busyPhases.includes(state.phase)||wallet.network?.chainId!==31337} onClick={()=>void recover(item.review.id,local?.hash)}>Check confirmation</Button>:<span className="field-hint">Start a new review to approve this action.</span>}</div>;})}
      {visibleFallback.filter(item=>!serverIds.has(item.reviewId)).map(item=><div className="nft-recovery-row" key={item.reviewId}><div><strong>Transaction saved on this device</strong><span className="indexed-subline">Check the transaction’s latest confirmation.</span><span className="indexed-hash">{item.hash}</span></div><Button type="button" variant="secondary" disabled={busyPhases.includes(state.phase)||wallet.network?.chainId!==31337} onClick={()=>void recover(item.reviewId,item.hash)}>Check transaction</Button></div>)}
      {dataScope===scope&&cursor&&<Button type="button" variant="ghost" loading={loading} onClick={()=>void load(true)}>Load more transactions</Button>}
      {dataScope===scope&&<><ReviewResult state={state} confirmationChanged={indexedSync.phase==='reorg'} onCheck={()=>void controller.refreshReceipt()}/><NftIndexedSyncNotice state={indexedSync} onRetry={indexedSync.retry}/></>}
      {recoveredCreate && state.receipt?.collection && <div className="section-gap"><InfoRow label="Recovered collection"><Address value={String(state.receipt.collection)} full /></InfoRow><div className="button-row">
        {recoveredDraftHref && <Link className="text-link" href={recoveredDraftHref}>Continue collection launch</Link>}
        {recoveredCollectionHref && <Link className="text-link" href={recoveredCollectionHref}>View collection</Link>}
      </div><p className="field-hint">Resume your saved draft and check its launch progress.</p></div>}
    </>}
    <SafetyNote>Checking a receipt does not submit another transaction. Confirmations may change if the test network is reset.</SafetyNote>
  </section>;
}
