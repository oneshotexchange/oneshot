import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { formatIndexedAmount, type IndexedItemResponse } from '@oneshot/evm';
import { useWallet } from '../lib/client-wallet';
import { indexedApi } from '../lib/client-indexed-api';
import { useNftCart, nftCartScopeFromSearch, nftCartHref, type NftCartItem } from '../lib/client-nft-cart';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchContext, type NftLaunchStatus, type PublicNftCollection } from '../lib/client-nft-launch';
import { nftTestAcknowledgement, nftNetworkLabel, readNftNetwork } from '../lib/nft-network';
import { ReviewResult } from './nft-checkout';
import { WalletButton } from './wallet-button';
import { Address, Button, ButtonLink, ErrorState, Field, InfoRow, PageHeading, SafetyNote } from './ui';

export function NftCartSelection({details,item}:{details:PublicNftCollection;item:NonNullable<IndexedItemResponse['item']>}){
  const wallet=useWallet();
  const cart=useNftCart({deploymentId:details.deploymentId,chainId:details.network.chainId});
  if(!details.marketplace?.batchBuy||item.listing?.status!=='active')return null;
  return <div className="section-gap"><div className="button-row"><Button variant="secondary" disabled={item.listing.seller.toLowerCase()===wallet.account?.address.toLowerCase()} onClick={()=>cart.add(item.listing!)}>Add to cart</Button><ButtonLink variant="ghost" href={nftCartHref({deploymentId:details.deploymentId,chainId:details.network.chainId})}>View cart ({cart.items.length})</ButtonLink></div>{cart.error&&<ErrorState message={cart.error}/>}<p className="field-hint">Your cart saves this listing and its estimated price on this browser. Prices are checked again before purchase.</p></div>;
}
export function NftCartPage(){
  const location=useLocation(),scope=useMemo(()=>nftCartScopeFromSearch(location.search),[location.search]),cart=useNftCart(scope);
  const wallet=useWallet(),latest=useRef(wallet);latest.current=wallet;
  const api=useMemo(()=>createNftLaunchApi({identityScope:()=>latest.current.identityScope(),getAccessToken:()=>latest.current.getAccessToken()}),[]);
  const [status,setStatus]=useState<NftLaunchStatus|null>(null),[quotes,setQuotes]=useState<NftCartItem[]|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[ack,setAck]=useState(false),[recipient,setRecipient]=useState('');
  const generation=useRef(0),identity=wallet.identityScope(),selectionKey=JSON.stringify(cart.items);
  const match=Boolean(scope&&status?.enabled&&status.deploymentId===scope.deploymentId&&status.network?.chainId===scope.chainId&&status.marketplace?.batchBuy);
  const ready=Boolean(match&&quotes?.length===cart.items.length&&quotes?.length&&identity&&wallet.authenticated&&wallet.connected&&wallet.network?.chainId===scope?.chainId&&!cart.error&&!error&&!loading);
  const context=useRef<NftLaunchContext>({identityScope:identity,address:wallet.account?.address??null,chainId:wallet.network?.chainId??null,draftId:'cart',revision:0,prepared:false,scope:'public'});
  context.current={identityScope:identity,address:wallet.account?.address??null,chainId:wallet.network?.chainId??null,draftId:status?.marketplace?.address??'cart',revision:0,prepared:ready,scope:'public',userId:wallet.userId,deploymentId:status?.deploymentId,marketplace:status?.marketplace,expectedListings:quotes??undefined,selectionKey:JSON.stringify([scope,selectionKey,recipient])};
  const controller=useMemo(()=>createNftLaunchController({api,context:()=>context.current,sendEvmTransaction:tx=>latest.current.sendEvmTransaction(tx)}),[api]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),busy=['reviewing','validating','signing','confirming'].includes(state.phase)||Boolean(state.hash&&!['confirmed','reverted'].includes(state.receipt?.status??''));
  async function refresh(){
    const ticket=++generation.current;setLoading(true);setQuotes(null);setError(null);setAck(false);controller.invalidate('Review the current total before preparing your purchase.');
    try{
      const info=await api.status();if(ticket!==generation.current)return;setStatus(info);
      if(!scope||!info.enabled||info.deploymentId!==scope.deploymentId||info.network?.chainId!==scope.chainId||!info.marketplace?.batchBuy)throw new Error('This cart’s marketplace is unavailable. Return to NFT collections to choose current listings.');
      const results=await Promise.all(cart.items.map(async selected=>{
        const response=await indexedApi<IndexedItemResponse>(`/api/oneshot/indexed/collections/${selected.collection}/items/${selected.tokenId}`),listing=response.item?.listing;
        if(!response.context.available||response.context.deploymentId!==scope.deploymentId||response.context.network?.chainId!==scope.chainId||!listing||listing.status!=='active'||listing.id!==selected.id||listing.collection.toLowerCase()!==selected.collection.toLowerCase()||listing.tokenId!==selected.tokenId||!/^[1-9]\d{0,77}$/.test(listing.totalPriceRaw)||BigInt(listing.totalPriceRaw)>=2n**256n)throw new Error('A selected listing is no longer available. Remove it or refresh after the collection updates.');
        if(listing.seller?.toLowerCase()===latest.current.account?.address.toLowerCase())throw new Error('A selected listing belongs to your wallet. Remove it before buying.');
        return {id:listing.id,collection:listing.collection,tokenId:listing.tokenId,totalPriceRaw:listing.totalPriceRaw};
      }));
      if(ticket===generation.current)setQuotes(results);
    }catch(reason){if(ticket===generation.current)setError(reason instanceof Error?reason.message:'Cart prices could not be loaded. Try again.');}
    finally{if(ticket===generation.current)setLoading(false);}
  }
  useEffect(()=>{setQuotes(null);setError(null);setAck(false);generation.current++;controller.syncContext();return()=>{generation.current++;};},[selectionKey,scope?.deploymentId,scope?.chainId]);
  useEffect(()=>{controller.syncContext();setAck(false);},[identity,wallet.network?.chainId,recipient]);
  useEffect(()=>()=>controller.invalidate('The cart was closed.'),[controller]);
  const total=quotes?.reduce((sum,item)=>sum+BigInt(item.totalPriceRaw),0n);
  return <><PageHeading title="Your NFT cart" description="Buy up to 20 NFTs from one marketplace in a single transaction." action={<ButtonLink variant="ghost" href="/nfts">Browse collections</ButtonLink>}/><section className="panel nft-launch-panel">
    {!scope?<ErrorState message="Open your cart from a verified NFT listing to select its network."/>:<>
      <SafetyNote amber>This cart uses {scope.chainId===84532?'Base Sepolia':'local test-network'} test ETH. If any purchase fails, the whole purchase reverts. Gas is separate.</SafetyNote>
      {cart.error&&<ErrorState message={cart.error}/>}
      {error&&<ErrorState message={error} retry={()=>void refresh()}/>}
      {cart.items.length===0&&!cart.error?<p className="data-notice">Your cart is empty. Open a listed NFT and choose Add to cart.</p>:cart.items.map(item=><div className="nft-offer-row" key={item.id}><div><ButtonLink variant="ghost" href={`/nfts/${item.collection}/${item.tokenId}?deployment=${scope.deploymentId}`}>NFT #{item.tokenId}</ButtonLink><Address value={item.collection}/><p className="field-hint">Saved estimate: {formatIndexedAmount(item.totalPriceRaw,18)} ETH</p>{quotes?.find(v=>v.id===item.id)&&<p>Current price: {formatIndexedAmount(quotes.find(v=>v.id===item.id)!.totalPriceRaw,18)} ETH</p>}</div><Button variant="ghost" disabled={busy} onClick={()=>cart.remove(item.id)}>Remove</Button></div>)}
      {cart.error&&<Button variant="secondary" onClick={cart.reset}>Reset this cart</Button>}
      {cart.items.length>0&&<Button variant="secondary" loading={loading} disabled={busy||!!cart.error} onClick={()=>void refresh()}>Check current prices</Button>}
      {total!==undefined&&<InfoRow label="Current total">{formatIndexedAmount(total.toString(),18)} ETH</InfoRow>}
      {match&&<p className="field-hint">The 2% platform fee and each collection’s frozen royalty are included in its price. Your review shows the totals before wallet approval.</p>}
      {!wallet.connected&&<WalletButton/>}{match&&wallet.connected&&wallet.network?.chainId!==scope.chainId&&<p className="data-notice">Switch your wallet to {nftNetworkLabel(readNftNetwork(status?.network))} to continue.</p>}
      <Field label="NFT recipient" hint="Leave blank for your selected wallet."><input value={recipient} disabled={busy} placeholder={wallet.account?.address} onChange={e=>setRecipient(e.target.value)}/></Field>
      <label className="checkbox-field"><input type="checkbox" checked={ack} disabled={busy||!ready} onChange={e=>{setAck(e.target.checked);if(!e.target.checked)controller.invalidate('Acknowledge test ETH before continuing.');}}/><span>I reviewed the current total and understand this uses test ETH and requires gas.</span></label>
      <Button disabled={!ready||!ack||busy} onClick={()=>{if(wallet.account&&status?.marketplace&&scope)void controller.prepare({from:wallet.account.address,action:'buy-batch',contract:status.marketplace.address,listingIds:cart.items.map(v=>v.id),...(recipient.trim()?{recipient:recipient.trim()}:{}),...nftTestAcknowledgement(scope.chainId)});}}>Review selected NFTs</Button>
      <ReviewResult state={state} canApprove={ready&&ack&&!busy} onApprove={()=>void controller.approve()} onCheck={()=>void controller.refreshReceipt()}/>
      {state.phase==='success'&&<Button variant="secondary" onClick={cart.reset}>Remove purchased selections</Button>}
    </>}
  </section></>;
}
