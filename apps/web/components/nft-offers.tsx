import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount, type IndexedNftItem } from '@oneshot/evm';
import { useWallet } from '../lib/client-wallet';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchContext, type NftLaunchAction, type PublicNftCollection } from '../lib/client-nft-launch';
import type { NftOffer, NftOffersPage } from '../lib/client-nft-offers';
import { nftTestAcknowledgement, nftNetworkLabel, readNftNetwork } from '../lib/nft-network';
import { ReviewResult } from './nft-checkout';
import { WalletButton } from './wallet-button';
import { Address, Button, ErrorState, Field, InfoRow, SafetyNote } from './ui';

const money=(value:string)=>`${formatIndexedAmount(value,18)} ETH`;
export function NftOffers({collection,item,indexedDeploymentId,onRefresh}:{collection:string;item?:IndexedNftItem;indexedDeploymentId?:string|null;onRefresh?:()=>void}){
  const wallet=useWallet(),latest=useRef(wallet);latest.current=wallet;
  const api=useMemo(()=>createNftLaunchApi({identityScope:()=>latest.current.identityScope(),getAccessToken:()=>latest.current.getAccessToken()}),[]);
  const [details,setDetails]=useState<PublicNftCollection|null>(null),[page,setPage]=useState<NftOffersPage|null>(null),[items,setItems]=useState<NftOffer[]>([]),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[mine,setMine]=useState(false);
  const [price,setPrice]=useState(''),[quantity,setQuantity]=useState('1'),[days,setDays]=useState('3'),[recipient,setRecipient]=useState(''),[ack,setAck]=useState(false),[selected,setSelected]=useState<NftOffer|null>(null);
  const generation=useRef(0),scope=wallet.identityScope(),from=wallet.account?.address.toLowerCase();
  const context=useRef<NftLaunchContext>({identityScope:scope,address:from??null,chainId:wallet.network?.chainId??null,draftId:collection.toLowerCase(),revision:0,prepared:false,scope:'public'});
  const match=Boolean(details&&details.collection.toLowerCase()===collection.toLowerCase()&&details.deploymentId===indexedDeploymentId&&details.marketplace?.fundedOffers);
  const ready=Boolean(match&&!loading&&!error&&wallet.authenticated&&wallet.connected&&scope&&wallet.network?.chainId===details?.network.chainId);
  context.current={identityScope:scope,address:from??null,chainId:wallet.network?.chainId??null,draftId:collection.toLowerCase(),revision:0,prepared:match,scope:'public',userId:wallet.userId,deploymentId:details?.deploymentId,marketplace:details?.marketplace,expectedOffer:selected??undefined,selectionKey:JSON.stringify([item,price,quantity,days,recipient])};
  const controller=useMemo(()=>createNftLaunchController({api,context:()=>context.current,sendEvmTransaction:tx=>latest.current.sendEvmTransaction(tx)}),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const busy=['reviewing','validating','signing','confirming'].includes(state.phase)||Boolean(state.hash&&!['confirmed','reverted'].includes(state.receipt?.status??''));
  async function refresh(more=false){
    const ticket=++generation.current;setLoading(true);setError(null);
    try{
      const info=await api.collection(collection);if(ticket!==generation.current)return;setDetails(info);
      if(!info.marketplace?.fundedOffers){setPage(null);setItems([]);return;}
      if(info.deploymentId!==indexedDeploymentId)throw new Error('The collection network changed. Refresh the collection before making an offer.');
      const result=await api.offers({collection,...(item?{tokenId:item.tokenId}:{}),...(mine&&from?{bidder:from}:{}),...(more&&page?.nextCursor?{cursor:page.nextCursor}:{})});
      if(ticket!==generation.current)return;
      if(result.deploymentId!==info.deploymentId||result.network.chainId!==info.network.chainId||result.marketplace.address.toLowerCase()!==info.marketplace.address.toLowerCase())throw new Error('The offers network changed. Refresh offers.');
      if(more&&page&&(result.blockHash!==page.blockHash||result.blockNumber!==page.blockNumber))throw new Error('The offers checkpoint changed. Refresh from the first page.');
      setPage(result);setItems(previous=>more?[...previous,...result.items]:result.items);
    }catch(reason){if(ticket===generation.current)setError(reason instanceof Error?reason.message:'Offers could not be loaded. Try again.');}
    finally{if(ticket===generation.current)setLoading(false);}
  }
  useEffect(()=>{setDetails(null);setItems([]);setPage(null);setSelected(null);void refresh();return()=>{generation.current++;};},[collection,item?.tokenId,mine,from,indexedDeploymentId]);
  useEffect(()=>{controller.syncContext();setAck(false);},[controller,scope,details?.deploymentId,item,price,quantity,days,recipient]);
  useEffect(()=>()=>controller.invalidate('The offers panel was closed.'),[controller]);
  const refreshed=useRef<string|null>(null);
  useEffect(()=>{if(state.phase==='success'&&state.hash&&refreshed.current!==state.hash){refreshed.current=state.hash;void refresh();onRefresh?.();}},[state.phase,state.hash]);
  function prepare(action:NftLaunchAction,offer?:NftOffer){
    if(!ready||!ack||busy||!from||!details)return;
    if(offer){setSelected(offer);context.current={...context.current,expectedOffer:offer};}
    // Selection is captured synchronously before the controller prepares its exact call.
    void controller.prepare({from,collection,action,...nftTestAcknowledgement(details.network.chainId),
      ...(action==='offer-create'?{price,quantity:item?'1':quantity,expiresAt:(BigInt(details.blockTimestamp)+BigInt(days)*86400n).toString(),...(item?{tokenId:item.tokenId}:{}),...(recipient.trim()?{recipient:recipient.trim()}:{})}:{}),
      ...(offer?{offerId:offer.id}:{}),...(['offer-accept','approve'].includes(action)&&item?{tokenId:item.tokenId}:{}),...(action==='claim'?{contract:details.marketplace!.address}:{})});
  }
  if(details&&!details.marketplace?.fundedOffers)return null;
  const owns=item&&(item.listing?.status==='active'?item.listing.seller.toLowerCase()===from:item.owner?.toLowerCase()===from);
  return <section className="panel nft-launch-panel" aria-label="NFT offers"><div className="section-header"><div><h2>{item?'Offers for this NFT':'Collection offers'}</h2><p>Offers reserve the full amount in test ETH. Sellers choose whether to accept.</p></div><Button variant="ghost" loading={loading} onClick={()=>void refresh()}>Refresh offers</Button></div>
    {error&&<ErrorState message={error} retry={()=>void refresh()}/>}
    {details&&match&&<><SafetyNote amber>Funded offers use {nftNetworkLabel(readNftNetwork(details.network))} test ETH. Canceling releases unused funds to your marketplace balance; claim that balance separately.</SafetyNote>
      {(!wallet.authenticated||!wallet.connected||!scope||wallet.network?.chainId!==details.network.chainId)&&<div className="button-row section-gap"><WalletButton/><p className="field-hint">Select a linked wallet on {nftNetworkLabel(readNftNetwork(details.network))} to make or manage offers.</p></div>}
      <label className="checkbox-field"><input type="checkbox" checked={mine} disabled={busy||!from} onChange={e=>setMine(e.target.checked)}/><span>Show my funded offers</span></label>
      {items.map(offer=><div className="nft-offer-row" key={offer.id}><div><strong>{money(offer.unitPriceRaw)} per NFT</strong><p className="field-hint">{offer.tokenId==='0'?'Any NFT in this collection':`NFT #${offer.tokenId}`} · {offer.remaining} remaining{offer.expired?' · Expired':''}</p><InfoRow label="Offer maker"><Address value={offer.bidder}/></InfoRow><InfoRow label="Recipient"><Address value={offer.recipient}/></InfoRow><InfoRow label="Reserved">{money(offer.escrowRaw)}</InfoRow><InfoRow label="Expires">{BigInt(offer.expiresAt)<=8640000000000n?new Date(Number(offer.expiresAt)*1000).toLocaleString():'Outside the displayable date range'}</InfoRow></div><div className="button-row">
        {owns&&!offer.expired&&offer.bidder.toLowerCase()!==from&&<Button variant="secondary" disabled={!ready||!ack||busy} onClick={()=>prepare('offer-accept',offer)}>Review acceptance</Button>}
        {offer.bidder.toLowerCase()===from&&<Button variant="secondary" disabled={!ready||!ack||busy} onClick={()=>prepare('offer-cancel',offer)}>Review cancellation</Button>}
        {offer.expired&&<Button variant="secondary" disabled={!ready||!ack||busy} onClick={()=>prepare('offer-expire',offer)}>Review fund release</Button>}
      </div></div>)}
      {page&&!loading&&!error&&items.length===0&&<p className="data-notice">No funded offers on this page. You can make an offer below{page.nextCursor?' or check older offers':''}.</p>}
      {page?.nextCursor&&<Button variant="ghost" loading={loading} onClick={()=>void refresh(true)}>Load older offers</Button>}
      <h3 className="section-gap">{item?'Make an item offer':'Make a collection offer'}</h3><div className="field-grid"><Field label="Price per NFT (test ETH)"><input value={price} inputMode="decimal" disabled={busy} onChange={e=>setPrice(e.target.value)}/></Field>{!item&&<Field label="Quantity" hint="Reserve funds for 1–20 NFTs."><input value={quantity} inputMode="numeric" disabled={busy} onChange={e=>setQuantity(e.target.value)}/></Field>}<Field label="Offer duration"><select value={days} disabled={busy} onChange={e=>setDays(e.target.value)}>{[1,3,7,14,30].map(day=><option key={day} value={day}>{day} day{day>1?'s':''}</option>)}</select></Field><Field label="NFT recipient" hint="Leave blank for your selected wallet. This recipient cannot change after funding."><input value={recipient} disabled={busy} placeholder={from} onChange={e=>setRecipient(e.target.value)}/></Field></div>
      <label className="checkbox-field"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>{setAck(e.target.checked);if(!e.target.checked)controller.invalidate('Acknowledge test ETH before continuing.');}}/><span>I understand this uses test ETH and requires gas. The 2% platform fee and frozen creator royalty are included in an accepted offer.</span></label>
      <div className="button-row"><Button variant="secondary" disabled={!ready||!ack||busy} onClick={()=>prepare('offer-create')}>Review funded offer</Button>{owns&&item.listing?.status!=='active'&&<Button variant="secondary" disabled={!ready||!ack||busy} onClick={()=>prepare('approve')}>Review NFT approval</Button>}<Button variant="ghost" disabled={!ready||!ack||busy} onClick={()=>prepare('claim')}>Review balance claim</Button></div>
      {owns&&item.listing?.status!=='active'&&<p className="field-hint">Approve this NFT for marketplace transfer before accepting an offer. Approval is a separate transaction.</p>}
      <ReviewResult state={state} canApprove={ready&&ack&&!busy} onApprove={()=>void controller.approve()} onCheck={()=>void controller.refreshReceipt()}/>
    </>}
  </section>;
}
