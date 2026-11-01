import { parseUnits, formatUnits } from '@b20/sdk';
import { z } from 'zod';
import { allowlistTree, ownedDraft, type Draft } from './drafts';
import { contractView } from './read-model';
import { chainFetch, nftDeployment, nftPackage, normalizeAddress } from './config';
import { ApiError } from './http';
import { getRecord, putRecord, putVersionedRecord, mergeRecord, putIfAbsent } from './store';

export const transactionSchema = z.object({ action: z.enum(['create_collection','configure_mint','open_collection','mint','list','buy','cancel','claim']), sender: z.string(), collectionId: z.string().optional(), listingId: z.string().optional(), tokenId: z.string().optional(), quantity: z.coerce.number().int().min(1).max(20).default(1), priceApt: z.string().optional(), draftId: z.string().optional() });
const secs = (date: string | undefined) => String(Math.floor(Date.parse(date || '') / 1000));
const aptAmount = (value: string) => { const amount = parseUnits(value); if (amount > (1n << 64n) - 1n) throw new ApiError(400, 'AMOUNT_TOO_LARGE', 'The APT amount exceeds u64.'); return amount.toString(); };
export async function buildTransaction(input: z.infer<typeof transactionSchema>, signedInAddress?: string) {
  const sender = normalizeAddress(input.sender);
  const deployment = await nftDeployment();
  if (!deployment.ready) throw new ApiError(503, 'CONTRACT_NOT_DEPLOYED', deployment.reason);
  const pkg = nftPackage()!;
  let fn = ''; let args: unknown[] = []; let review: Record<string, unknown> = {};
  if (['create_collection','configure_mint','open_collection'].includes(input.action)) {
    if (signedInAddress !== sender) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with the collection creator wallet.');
    const draft = await ownedDraft(input.draftId || '', sender);
    if (!draft.baseUri || !draft.collectionUri) throw new ApiError(409, 'PREPARE_METADATA', 'Snapshot the collection artwork and metadata before creating it.');
    if (input.action === 'create_collection') {
      if (draft.collectionId) throw new ApiError(409, 'ALREADY_CREATED', 'This draft already has an on-chain collection.');
      fn = 'nft_launch::create_collection'; args = [draft.name,draft.description,draft.collectionUri,draft.baseUri,String(draft.maxSupply),String(draft.royaltyBps)];
      review = { name: draft.name, maxSupply: draft.maxSupply, royaltyBps: draft.royaltyBps, metadataBaseUri: draft.baseUri };
    } else {
      const id = normalizeAddress(draft.collectionId || input.collectionId || '');
      const [current] = await contractView('nft_launch','get_collection',[id]);
      if (normalizeAddress(current.creator) !== sender || current.opened) throw new ApiError(409, 'COLLECTION_FROZEN', 'This collection is already open or belongs to another creator.');
      if (input.action === 'configure_mint') {
        const allow = draft.allowlistAddresses.length > 0;
        const start = allow ? draft.allowlistStart : draft.publicStart;
        if (!start || Date.parse(start) <= Date.now()) throw new ApiError(409, 'SCHEDULE_EXPIRED', 'The scheduled mint start has passed. Create a new draft with future mint times.');
        fn = 'nft_launch::configure_mint';
        args = [id,allow ? secs(draft.allowlistStart) : '0',allow ? secs(draft.allowlistEnd) : '0',allow ? aptAmount(draft.allowlistPriceApt) : '0',allow ? String(draft.perWalletLimit) : '0',allow ? allowlistTree(id,draft.allowlistAddresses).root : '0x',secs(draft.publicStart),secs(draft.publicEnd),aptAmount(draft.publicPriceApt),String(draft.perWalletLimit)];
      } else { fn = 'nft_launch::open_collection'; args = [id]; }
      review = { collectionId: id, permanentFreeze: input.action === 'open_collection', publicPriceApt: draft.publicPriceApt, platformFeeBps: 200, royaltyBps: draft.royaltyBps };
    }
  } else if (input.action === 'mint') {
    const id = normalizeAddress(input.collectionId || ''); const [c] = await contractView('nft_launch','get_collection',[id]);
    if (!c.opened) throw new ApiError(409, 'MINT_NOT_OPEN', 'This collection has not opened for minting.');
    const now = Math.floor(Date.now()/1000);
    const allow = c.allowlist_root?.length && now >= Number(c.allowlist_start) && now < Number(c.allowlist_end);
    if (!allow && !(now >= Number(c.public_start) && now < Number(c.public_end))) throw new ApiError(409, 'NO_ACTIVE_STAGE', 'No mint stage is active.');
    let proof: string[] = [];
    if (allow) { const link=await getRecord('collection_drafts',id); const draft=link ? await getRecord<Draft>('drafts',link.draftId) : null; if (!draft) throw new ApiError(503,'ALLOWLIST_UNAVAILABLE','The collection allowlist proof is unavailable.'); proof = allowlistTree(id,draft.allowlistAddresses,sender).proof; }
    const total = BigInt(allow ? c.allowlist_price_octas : c.public_price_octas) * BigInt(input.quantity);
    if (total > (1n<<64n)-1n) throw new ApiError(400,'AMOUNT_TOO_LARGE','The total mint amount exceeds u64.');
    fn = 'nft_launch::mint_nft'; args = [id,String(input.quantity),proof,total.toString()];
    review = { quantity: input.quantity, totalPriceOctas: total.toString(), platformFeeBps: 200, phase: allow ? 'allowlist' : 'public' };
  } else if (input.action === 'list') {
    fn = 'marketplace::list'; const token = normalizeAddress(input.tokenId || '');
    const amount = aptAmount(input.priceApt || '0'); if (amount === '0') throw new ApiError(400,'INVALID_PRICE','Listing price must be greater than zero.');
    const [terms] = await contractView('nft_launch','is_b20_token',[token]); if (!terms) throw new ApiError(400,'NOT_B20_NFT','Only B20-launched NFTs can be listed.');
    args = [token,amount]; review = { tokenId: token, totalPriceOctas: amount, platformFeeBps: 200 };
  } else if (input.action === 'buy' || input.action === 'cancel') {
    const id = normalizeAddress(input.listingId || ''); const [listing] = await contractView('marketplace','get_listing',[id]);
    fn = `marketplace::${input.action}`; args = input.action === 'buy' ? [id,listing.price_octas] : [id];
    review = { listingId: id, totalPriceOctas: listing.price_octas, platformFeeOctas: listing.platform_fee_octas, royaltyOctas: listing.royalty_octas, sellerProceedsOctas: listing.seller_proceeds_octas };
  } else throw new ApiError(503,'TOKEN_FEATURE_GATED','Token earnings are unavailable until the Hyperion integration is verified.');
  return { payload: { function: `${pkg}::${fn}`, typeArguments: [], functionArguments: args }, network: 'testnet', chainId: 2, review };
}

export async function confirmTransaction(hash: string, draftId?: string, owner?: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new ApiError(400,'INVALID_HASH','Enter a valid Aptos transaction hash.');
  const tx = await chainFetch(`/transactions/by_hash/${hash}`);
  if (tx.type === 'pending_transaction') throw new ApiError(409,'TRANSACTION_PENDING','The transaction has not committed yet.');
  if (!tx.success) throw new ApiError(409,'TRANSACTION_FAILED','The submitted transaction failed on Aptos testnet.');
  const pkg = nftPackage(); if (!pkg) throw new ApiError(503,'CONTRACT_NOT_DEPLOYED','The NFT package is not configured.');
  const receipt = await getRecord('receipts',hash);
  if(receipt?.packageAddress===pkg) {
    if(draftId && owner && receipt.result.collectionId) await bindDraft(draftId,owner,receipt.result.collectionId);
    return receipt.result;
  }
  const events: any[] = (tx.events || []).map((e:any,index:number)=>({...e,originalIndex:index})).filter((e: any) => e.type.startsWith(`${pkg}::nft_launch::`) || e.type.startsWith(`${pkg}::marketplace::`));
  if (!events.length) {
    if(tx.payload?.function===`${pkg}::nft_launch::configure_mint` && draftId && owner && normalizeAddress(tx.sender)===owner) {
      const id=normalizeAddress(tx.payload.arguments?.[0]||'');
      const draft=await ownedDraft(draftId,owner);
      if(draft.collectionId!==id)throw new ApiError(409,'DRAFT_MISMATCH','This transaction configured another collection.');
      await bindDraft(draftId,owner,id);
      const result={success:true,transactionHash:hash,version:tx.version,collectionId:id,action:'configure_mint'};
      await putRecord('receipts',hash,{packageAddress:pkg,result,collectionCreator:owner});return result;
    }
    throw new ApiError(400,'UNRELATED_TRANSACTION','The transaction is not a recognized action from this B20 deployment.');
  }
  const result: any = { success: true, transactionHash: hash, version: tx.version };
  for (const event of events) {
    const index=event.originalIndex;
    const kind = event.type.split('::').pop(); const data = event.data;
    if (kind === 'CollectionCreated') {
      const id = normalizeAddress(data.collection); result.collectionId = id;
      let draft: Draft | null = null;
      if (draftId && owner && normalizeAddress(data.creator) === owner) draft=await bindDraft(draftId,owner,id);
      const prior=await getRecord('collections',id);
      if(!prior) await putVersionedRecord('collections',id,{ id,address:id,name:data.name,maxSupply:Number(data.max_supply),minted:0,royaltyBps:Number(data.royalty_bps),creator:normalizeAddress(data.creator),description:draft?.description,imageUrl:draft?.imageUrl,manifestHash:draft?.manifestHash,status:'created',metadataFrozen:false },tx.version);
    } else if (kind === 'CollectionOpened') {
      const id = normalizeAddress(data.collection); result.collectionId = id; const previous = await getRecord('collections',id) || {};
      await putVersionedRecord('collections',id,{id,status:'open',metadataFrozen:true,publicStart:new Date(Number(data.public_start)*1000).toISOString(),publicPriceApt:formatUnits(BigInt(data.public_price_octas))},tx.version);
      if (draftId && owner) { const draft = await ownedDraft(draftId,owner); if (draft.collectionId === id) await putRecord('drafts',draftId,{...draft,status:'open'}); }
    } else if (kind === 'Minted') {
      const token = normalizeAddress(data.token); result.tokenId = token;
      const prior=await getRecord('nfts',token);
      await putVersionedRecord('nfts',token,{id:token,collectionId:normalizeAddress(data.collection),owner:normalizeAddress(data.minter),serial:Number(data.serial)},tx.version);
      const id = normalizeAddress(data.collection); const previous = await getRecord('collections',id); if(previous) { const [view] = await contractView('nft_launch','get_collection',[id]); await putVersionedRecord('collections',id,{minted:Number(view.minted)},tx.version); }
    } else if (kind === 'Listed') {
      result.listingId = normalizeAddress(data.listing); const token = normalizeAddress(data.token); const previous = await getRecord('nfts',token) || {id:token,collectionId:normalizeAddress(data.collection)};
      await putVersionedRecord('nfts',token,{...previous,owner:result.listingId,seller:normalizeAddress(data.seller),listingId:result.listingId,priceApt:formatUnits(BigInt(data.price_octas))},tx.version);
    } else if (kind === 'Sold' || kind === 'Cancelled') {
      const token = normalizeAddress(data.token); const previous = await getRecord('nfts',token) || {id:token};
      await putVersionedRecord('nfts',token,{...previous,owner:normalizeAddress(data.buyer || data.seller),seller:null,listingId:null,priceApt:null},tx.version);
    }
    await putRecord('activity',`${tx.version}:${index}`,{id:`${tx.version}:${index}`,type:kind,name:data.name,wallet:data.creator||data.minter||data.buyer||data.seller,collectionId:data.collection,transactionHash:hash,timestamp:new Date(Number(BigInt(tx.timestamp)/1000n)).toISOString()});
  }
  const createdEvent=events.find(e=>e.type.endsWith('::CollectionCreated'));
  await putRecord('receipts',hash,{packageAddress:pkg,result,collectionCreator:createdEvent ? normalizeAddress(createdEvent.data.creator) : undefined});
  return result;
}

async function bindDraft(draftId:string,owner:string,id:string) {
  const draft=await ownedDraft(draftId,owner);
  const [current]=await contractView('nft_launch','get_collection',[id]);
  if(normalizeAddress(current.creator)!==owner||current.metadata_base_uri!==draft.baseUri||current.name!==draft.name||BigInt(current.max_supply)!==BigInt(draft.maxSupply)||Number(current.royalty_bps)!==draft.royaltyBps) throw new ApiError(409,'DRAFT_MISMATCH','The on-chain collection does not match this prepared draft.');
  if(draft.collectionId&&draft.collectionId!==id)throw new ApiError(409,'DRAFT_ALREADY_BOUND','This draft belongs to another collection.');
  if(current.configured){
    const actualRoot=typeof current.allowlist_root==='string'?current.allowlist_root.toLowerCase():`0x${Buffer.from(current.allowlist_root).toString('hex')}`;
    const expectedRoot=allowlistTree(id,draft.allowlistAddresses).root;
    const allow=draft.allowlistAddresses.length>0;
    if(actualRoot!==expectedRoot||String(current.public_start)!==secs(draft.publicStart)||String(current.public_end)!==secs(draft.publicEnd)||String(current.public_price_octas)!==aptAmount(draft.publicPriceApt)||Number(current.public_wallet_limit)!==draft.perWalletLimit||(allow&&(String(current.allowlist_start)!==secs(draft.allowlistStart)||String(current.allowlist_end)!==secs(draft.allowlistEnd)||String(current.allowlist_price_octas)!==aptAmount(draft.allowlistPriceApt)||Number(current.allowlist_wallet_limit)!==draft.perWalletLimit)))throw new ApiError(409,'MINT_TERMS_MISMATCH','The configured mint terms do not match this draft.');
  }
  const link=await putIfAbsent('collection_drafts',id,{draftId,owner});
  if(link?.draftId!==draftId||link?.owner!==owner)throw new ApiError(409,'COLLECTION_ALREADY_BOUND','This collection is already associated with another draft.');
  const bound:Draft={...draft,collectionId:id,status:current.opened?'open':current.configured?'configured':'created'};
  await putRecord('drafts',draftId,bound);
  const prior=await getRecord('collections',id);
  if(prior)await mergeRecord('collections',id,{imageUrl:draft.imageUrl,description:draft.description,manifestHash:draft.manifestHash});
  return bound;
}
