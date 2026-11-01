import { randomUUID, createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { encodeFunctionData, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, decodeEventLog, type Abi, type Address, type Hex } from 'viem';
import { createVerifiedRpc, networkConfig, NFT_FACTORY_ABI, NFT_COLLECTION_ABI, NFT_MARKETPLACE_ABI, NFT_TERMS_PARAMETER, prepareNftTerms, NftLaunchError, parseAssetAmount, splitNftSettlement, type NetworkConfig, type NftLaunchDraft, type NftTerms, type NftCreatorWorkspace, type NftCreatorProgress, type NftEarningsPage } from '@oneshot/evm';
import { parseManifest, manifestId, isHash, isData } from '../../../indexer/src/manifest';
import { VerifiedRpcSource } from '../../../indexer/src/rpc-source';
import type { Manifest } from '../../../indexer/src/types';
import { assertLinkedEvmAddress, type OneshotSession } from './oneshot-auth';
import { getOneshotDraft, verifyPreparedOneshotSnapshot } from './oneshot-drafts';
import { ApiError } from './errors';
import { stableJson } from './media';
import { nftLaunchRepository, type StoredNftReview, type NftPublication } from './nft-launch-store';
import { GUARDED_MARKETPLACE_ABI, applyProtectedFloor } from '@oneshot/evm';
import { createNftFloorPolicyService } from './nft-floor-policy';
import { nftLaunchProgressRepository, type NftLaunchAssociation } from './nft-launch-progress-store';

const network = { mode: 'local', chainId: 31337, name: 'Local Anvil', nativeSymbol: 'ETH', nativeDecimals: 18 } as const;
const address = z.string().regex(/^0x[\da-fA-F]{40}$/).transform(value => value.toLowerCase() as Address).refine(value => !/^0x0{40}$/.test(value));
const uint = z.string().regex(/^[1-9]\d{0,77}$/).refine(value => /^[1-9]\d{0,77}$/.test(value) && BigInt(value) < (1n << 256n));
const actions = ['create','configure','open','mint','approve','list','buy','cancel','claim','policy'] as const;
export const nftReviewInput = z.object({
  draftId: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(), from: address,
  action: z.enum(actions), collection: address.optional(), tokenId: uint.optional(), listingId: uint.optional(),
  quantity: uint.optional(), recipient: address.optional(), price: z.string().max(118).optional(), contract: address.optional(),
  floorEnabled: z.boolean().optional(), floorPrice: z.string().max(118).optional(),
  localEthAcknowledged: z.literal(true),
}).strict().superRefine((input,context) => {
  if (Boolean(input.draftId) !== Boolean(input.expectedRevision)) context.addIssue({code:'custom',path:['draftId'],message:'Provide the draft and its expected revision together.'});
  if (['create','configure','open'].includes(input.action) && !input.draftId) context.addIssue({code:'custom',path:['draftId'],message:'Creator actions require an owned prepared draft.'});
  if (!input.draftId && !input.collection && !(input.action==='claim' && input.contract)) context.addIssue({code:'custom',path:['collection'],message:'Public checkout requires a collection, or an explicit marketplace claim contract.'});
  if (input.action==='policy' && (input.draftId || input.floorEnabled===undefined || input.floorPrice===undefined)) context.addIssue({code:'custom',path:['floorEnabled'],message:'Settings require a collection, enable choice and minimum, without a draft.'});
  if (input.action!=='policy' && (input.floorEnabled!==undefined || input.floorPrice!==undefined)) context.addIssue({code:'custom',path:['floorEnabled'],message:'Floor fields are limited to private creator settings.'});
});
export type NftReviewInput = z.infer<typeof nftReviewInput>;
export type NftReview = {
  id: string; reviewHash: string; expiresAt: string; chainId: 31337; from: Address; to: Address; data: Hex; value: string;
  action: NftReviewInput['action']; network: typeof network; summary: Record<string,string>; deploymentId: string;
  scope: 'draft' | 'public'; draftId: string; revision: number; simulation: { blockNumber: string; blockHash: Hex; gasEstimate: string };
};
type Rpc = Awaited<ReturnType<typeof createVerifiedRpc>>;
type Dependencies = {
  environment?: () => Record<string,string|undefined>;
  loadManifest?: (path: string) => Promise<Manifest>;
  rpc?: (config: NetworkConfig) => Promise<Rpc>;
  getDraft?: typeof getOneshotDraft;
  verifySnapshot?: typeof verifyPreparedOneshotSnapshot;
  now?: () => number;
  repository?: typeof nftLaunchRepository;
  progressRepository?: typeof nftLaunchProgressRepository;
};
const conflict = (code: string, message: string): never => { throw new ApiError(409, code, message); };
const record = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rpcQuantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/.test(value)) throw new ApiError(503, 'RPC_DATA_INVALID', 'The local chain returned invalid data.');
  return BigInt(value);
};
// PostgreSQL jsonb preserves values, but deliberately does not preserve object-key order.
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const hex = (value: bigint) => `0x${value.toString(16)}`;
const earningsInteger=z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value=>BigInt(value)<2n**256n);
const earningsCursorSchema=z.object({v:z.literal(1),deploymentId:z.string().regex(/^[a-f0-9]{64}$/),wallet:address,
  blockNumber:earningsInteger,blockHash:z.string().regex(/^0x[\da-f]{64}$/),offset:earningsInteger,count:earningsInteger}).strict();
type EarningsCursor=z.infer<typeof earningsCursorSchema>;
function parseEarningsCursor(input:string|undefined):EarningsCursor|null {
  if(input===undefined)return null;
  const invalid=():never=>{throw new ApiError(400,'EARNINGS_CURSOR_INVALID','Refresh proceeds from the first page.');};
  try {
    if(!input || input.length>2048 || !/^[\w-]+$/.test(input))return invalid();
    const bytes=Buffer.from(input,'base64url');
    if(bytes.toString('base64url')!==input)return invalid();
    const value=earningsCursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if(BigInt(value.offset)===0n || BigInt(value.offset)>BigInt(Number.MAX_SAFE_INTEGER) || BigInt(value.offset)>=BigInt(value.count) || BigInt(value.offset)%10n!==0n)return invalid();
    return value;
  } catch {return invalid();}
}
function rpcAmount(value:unknown):bigint {
  if(typeof value!=='bigint' || value<0n || value>=2n**256n)throw new ApiError(503,'RPC_DATA_INVALID','The local chain returned an invalid amount.');
  return value;
}
function rpcAddress(value:unknown):Address {
  const parsed=address.safeParse(value);
  if(!parsed.success)throw new ApiError(503,'RPC_DATA_INVALID','The local chain returned an invalid contract reference.');
  return parsed.data;
}
async function loadManifest(path: string) {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > 16_384) throw new Error();
    const bytes = Buffer.alloc(16_385); const {bytesRead} = await file.read(bytes,0,bytes.length,0);
    if (bytesRead > 16_384) throw new Error();
    return parseManifest(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')));
  } finally { await file.close(); }
}

/** Derives local wallet calls; the private authority signs permits, never wallet transactions. */
export function createNftLaunchService(deps: Dependencies = {}) {
  const env = deps.environment ?? (() => process.env), now = deps.now ?? Date.now;
  const repository = deps.repository ?? nftLaunchRepository;
  const progressRepository = deps.progressRepository ?? nftLaunchProgressRepository;
  const policies = createNftFloorPolicyService(env);
  async function connect() {
    const config = env();
    if (config.ONESHOT_LOCAL_NFT_EXECUTION_ENABLED !== 'true' || config.ONESHOT_NETWORK !== 'local') conflict('EXECUTION_DISABLED', 'Local NFT execution is disabled. Zero transactions remain unavailable.');
    const path = config.ONESHOT_INDEXER_MANIFEST_PATH;
    if (!path) conflict('DEPLOYMENT_REQUIRED', 'Select a verified local NFT deployment manifest.');
    try {
      const manifest = await (deps.loadManifest ?? loadManifest)(path!);
      const rpc = await (deps.rpc ?? createVerifiedRpc)(networkConfig(config));
      const source = new VerifiedRpcSource(rpc);
      await source.verify(manifest);
      const block = await source.block(await source.height());
      return { manifest, rpc, source, block, deploymentId: manifestId(manifest) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'DEPLOYMENT_UNAVAILABLE', 'The local chain, deployment anchor, and contract code must verify before execution.');
    }
  }
  async function status() {
    try { const chain = await connect(); return {enabled:true,reason:null,network,deploymentId:chain.deploymentId}; }
    catch (error) { return {enabled:false,reason:error instanceof ApiError ? error.message : 'Local execution is unavailable.',network:null,deploymentId:null}; }
  }
  type Chain = Awaited<ReturnType<typeof connect>>;
  async function readContract(chain: Chain, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    const value = await chain.rpc.readRpc('eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},{blockHash:chain.block.hash,requireCanonical:true}]);
    if (!isData(value)) throw new ApiError(503,'RPC_DATA_INVALID','The local chain returned invalid contract data.');
    try { return decodeFunctionResult({abi,functionName,data:value}); }
    catch { throw new ApiError(503,'RPC_DATA_INVALID','The local chain returned invalid contract data.'); }
  }
  async function collectionState(chain: Chain, collection: Address) {
    const {manifest} = chain;
    if (!await readContract(chain,manifest.factory.address,NFT_FACTORY_ABI,'isCollection',[collection])) conflict('UNKNOWN_COLLECTION','Choose a collection registered by this deployment.');
    const [factory,treasury,expectedTreasury,creator,name,symbol,opened,totalMinted,terms] = await Promise.all([
      readContract(chain,collection,NFT_COLLECTION_ABI,'factory'),readContract(chain,collection,NFT_COLLECTION_ABI,'treasury'),
      readContract(chain,manifest.factory.address,NFT_FACTORY_ABI,'treasury'),readContract(chain,collection,NFT_COLLECTION_ABI,'creator'),
      readContract(chain,collection,NFT_COLLECTION_ABI,'name'),readContract(chain,collection,NFT_COLLECTION_ABI,'symbol'),
      readContract(chain,collection,NFT_COLLECTION_ABI,'opened'),readContract(chain,collection,NFT_COLLECTION_ABI,'totalMinted'),
      readContract(chain,collection,NFT_COLLECTION_ABI,'terms'),
    ]);
    if (String(factory).toLowerCase() !== manifest.factory.address || String(treasury).toLowerCase() !== String(expectedTreasury).toLowerCase()) conflict('COLLECTION_MISMATCH','The collection references differ from this deployment.');
    const frozen = terms as NftTerms;
    return {collection,creator:address.parse(creator),name:String(name),symbol:String(symbol),opened:opened as boolean,totalMinted:totalMinted as bigint,
      terms:frozen,termsHash:keccak256(encodeAbiParameters([NFT_TERMS_PARAMETER],[frozen]))};
  }
  async function collection(raw: string) {
    const selected = address.parse(raw), chain = await connect(), state = await collectionState(chain,selected);
    if ((await chain.source.block(chain.block.number)).hash !== chain.block.hash) conflict('CHAIN_MOVED','The collection block changed. Refresh its terms.');
    const stage = (value:NftTerms['publicMint']) => ({start:value.start.toString(),end:value.end.toString(),walletLimitRaw:value.walletLimit.toString(),priceRaw:value.price.toString()});
    return {network,deploymentId:chain.deploymentId,collection:selected,creator:state.creator,name:state.name,symbol:state.symbol,opened:state.opened,
      totalMintedRaw:state.totalMinted.toString(),terms:{maxSupplyRaw:state.terms.maxSupply.toString(),royaltyBps:state.terms.royaltyBps,allowlistRoot:state.terms.allowlistRoot,
        contentHash:state.terms.contentHash,metadataBaseURI:state.terms.metadataBaseURI,collectionURI:state.terms.collectionURI,
        allowlist:stage(state.terms.allowlist),publicMint:stage(state.terms.publicMint)},termsHash:state.termsHash,
      blockNumber:chain.block.number.toString(),blockHash:chain.block.hash,blockTimestamp:chain.block.timestamp.toString()};
  }
  async function earnings(raw:unknown,session:OneshotSession):Promise<NftEarningsPage> {
    if(session.expiresAt*1000<=now())throw new ApiError(401,'AUTH_REQUIRED','Sign in again to inspect your proceeds.');
    const input=z.object({from:address,cursor:z.string().min(1).max(2048).optional()}).strict().parse(raw);
    const from=assertLinkedEvmAddress(session,input.from),cursor=parseEarningsCursor(input.cursor);
    if(cursor && cursor.wallet!==from)throw new ApiError(400,'EARNINGS_CURSOR_INVALID','Use a proceeds cursor for the selected linked wallet.');
    const current=await connect();
    const moved=():never=>conflict('EARNINGS_CURSOR_STALE','The proceeds checkpoint changed. Refresh from the first page.');
    if(cursor && (cursor.deploymentId!==current.deploymentId || BigInt(cursor.blockNumber)<current.manifest.startBlock || BigInt(cursor.blockNumber)>current.block.number))return moved();
    const block=cursor?await current.source.block(BigInt(cursor.blockNumber)):current.block;
    if(cursor && block.hash!==cursor.blockHash)return moved();
    const chain={...current,block};
    if((await chain.source.block(block.number)).hash!==block.hash)return moved();
    const count=rpcAmount(await readContract(chain,chain.manifest.factory.address,NFT_FACTORY_ABI,'collectionCount'));
    if(cursor && count!==BigInt(cursor.count))return moved();
    const offset=cursor?BigInt(cursor.offset):0n,last=offset+10n<count?offset+10n:count;
    if(last>BigInt(Number.MAX_SAFE_INTEGER))throw new ApiError(400,'EARNINGS_CURSOR_INVALID','The proceeds scan exceeds its exact supported counter range.');
    const treasury=rpcAddress(await readContract(chain,chain.manifest.factory.address,NFT_FACTORY_ABI,'treasury'));
    const marketplaceAmount=rpcAmount(await readContract(chain,chain.manifest.marketplace.address,NFT_MARKETPLACE_ABI,'pending',[from]));
    const collections:NftEarningsPage['collections']=[],seen=new Set<string>();
    for(let index=offset;index<last;index++) {
      const contract=rpcAddress(await readContract(chain,chain.manifest.factory.address,NFT_FACTORY_ABI,'collections',[index]));
      if(seen.has(contract) || contract===chain.manifest.factory.address || contract===chain.manifest.marketplace.address)throw new ApiError(503,'RPC_DATA_INVALID','The local registry returned an invalid collection reference.');
      seen.add(contract);
      if(await readContract(chain,chain.manifest.factory.address,NFT_FACTORY_ABI,'isCollection',[contract])!==true)conflict('COLLECTION_MISMATCH','The collection is absent from this verified factory.');
      const [collectionFactory,collectionTreasury,name,opened,pending]=await Promise.all([
        readContract(chain,contract,NFT_COLLECTION_ABI,'factory'),readContract(chain,contract,NFT_COLLECTION_ABI,'treasury'),
        readContract(chain,contract,NFT_COLLECTION_ABI,'name'),readContract(chain,contract,NFT_COLLECTION_ABI,'opened'),
        readContract(chain,contract,NFT_COLLECTION_ABI,'pending',[from]),
      ]);
      if(rpcAddress(collectionFactory)!==chain.manifest.factory.address || rpcAddress(collectionTreasury)!==treasury)conflict('COLLECTION_MISMATCH','The collection references differ from this verified deployment.');
      if(typeof name!=='string' || typeof opened!=='boolean')throw new ApiError(503,'RPC_DATA_INVALID','The local registry returned invalid collection data.');
      collections.push({contract,name:name.slice(0,200),opened,amountRaw:rpcAmount(pending).toString()});
    }
    if((await chain.source.height())<block.number || (await chain.source.block(block.number)).hash!==block.hash)return moved();
    if(session.expiresAt*1000<=now())throw new ApiError(401,'AUTH_REQUIRED','Sign in again to inspect your proceeds.');
    const nextCursor=last<count?Buffer.from(JSON.stringify({v:1,deploymentId:chain.deploymentId,wallet:from,blockNumber:block.number.toString(),blockHash:block.hash,offset:last.toString(),count:count.toString()} satisfies EarningsCursor)).toString('base64url'):null;
    return {network,deploymentId:chain.deploymentId,wallet:from,blockNumber:block.number.toString(),blockHash:block.hash,blockTimestamp:block.timestamp.toString(),
      marketplace:{contract:chain.manifest.marketplace.address,amountRaw:marketplaceAmount.toString()},collections,scannedCount:Number(last),totalCollectionsRaw:count.toString(),nextCursor};
  }
  const progressInput = z.object({ expectedRevision:z.number().int().positive(), from:address, launchId:z.string().uuid().optional(), cursor:z.string().min(1).max(2048).optional() }).strict();
  function sameLaunchScope(item:NftLaunchAssociation, scope:{owner:string;draftId:string;revision:number;deploymentId:string;from:string}) {
    return item.owner===scope.owner && item.draftId===scope.draftId && item.revision===scope.revision
      && item.deploymentId===scope.deploymentId && item.from===scope.from;
  }
  async function creatorProgress(chain:Chain, item:NftLaunchAssociation, draft:NftLaunchDraft):Promise<NftCreatorProgress> {
    const state = (phase:NftCreatorProgress['phase'], termsMatch=false, nextAction:NftCreatorProgress['nextAction']=null):NftCreatorProgress => ({
      id:item.id,collection:item.collection,createHash:item.createHash,phase,nextAction,termsMatch,blockNumber:chain.block.number.toString(),blockHash:chain.block.hash,
    });
    const creationHeight=BigInt(item.blockNumber);
    if (creationHeight>chain.block.number || (await chain.source.block(creationHeight)).hash!==item.blockHash) return state('orphaned');
    const tx=await chain.rpc.readRpc('eth_getTransactionByHash',[item.createHash]);
    const receipt=await chain.rpc.readRpc('eth_getTransactionReceipt',[item.createHash]);
    if (tx===null || receipt===null) return state('pending');
    const data=encodeFunctionData({abi:NFT_FACTORY_ABI,functionName:'createCollection',args:[draft.name,draft.symbol!]});
    if (!record(tx) || tx.hash!==item.createHash || typeof tx.from!=='string' || tx.from.toLowerCase()!==item.from
      || typeof tx.to!=='string' || tx.to.toLowerCase()!==chain.manifest.factory.address || !isData(tx.input) || tx.input.toLowerCase()!==data
      || rpcQuantity(tx.value)!==0n || rpcQuantity(tx.chainId)!==31337n
      || !record(receipt) || receipt.transactionHash!==item.createHash || receipt.blockHash!==item.blockHash
      || tx.blockHash!==receipt.blockHash || rpcQuantity(receipt.blockNumber)!==creationHeight
      || rpcQuantity(tx.blockNumber)!==creationHeight || rpcQuantity(receipt.status)!==1n || !Array.isArray(receipt.logs)) return state('mismatch');
    let found=false;
    for (const log of receipt.logs) {
      if (!record(log) || typeof log.address!=='string' || log.address.toLowerCase()!==chain.manifest.factory.address
        || !isData(log.data) || !Array.isArray(log.topics) || !log.topics.every(isHash)) continue;
      try {
        const event=decodeEventLog({abi:NFT_FACTORY_ABI,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
        if (event.eventName==='CollectionCreated' && String(event.args.collection).toLowerCase()===item.collection
          && String(event.args.creator).toLowerCase()===item.from && event.args.name===draft.name && event.args.symbol===draft.symbol) { found=true; break; }
      } catch { /* Only the exact factory creation event admits this saved association. */ }
    }
    if (!found) return state('mismatch');
    let current:Awaited<ReturnType<typeof collectionState>>;
    try { current=await collectionState(chain,item.collection as Address); }
    catch(error) { if(error instanceof ApiError && ['UNKNOWN_COLLECTION','COLLECTION_MISMATCH'].includes(error.code)) return state('mismatch'); throw error; }
    if(current.creator!==item.from || current.name!==draft.name || current.symbol!==draft.symbol) return state('mismatch');
    const plan=prepareNftTerms(draft,{chainId:31337,nativeDecimals:18,collection:item.collection as Address,nowSeconds:0n});
    const termsMatch=current.termsHash===plan.termsHash;
    if(current.opened) return state(termsMatch?'opened':'mismatch',termsMatch);
    if(plan.summary.firstStart<chain.block.timestamp) return state('schedule-expired',termsMatch);
    return state(termsMatch?'configured':'created',termsMatch,termsMatch?'open':'configure');
  }
  async function progress(draftId:string, raw:unknown, session:OneshotSession):Promise<NftCreatorWorkspace> {
    if(session.expiresAt*1000<=now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again to continue this launch.');
    z.string().uuid().parse(draftId);
    const input=progressInput.parse(raw),from=assertLinkedEvmAddress(session,input.from);
    const draft=await (deps.getDraft??getOneshotDraft)(draftId,session);
    if(draft.revision!==input.expectedRevision) conflict('DRAFT_CHANGED','Reload the current draft before continuing its launch.');
    if(draft.status!=='prepared' || !draft.snapshot) conflict('SNAPSHOT_REQUIRED','Prepare this saved draft before continuing its launch.');
    if(draft.creatorWallet?.toLowerCase()!==from) conflict('CREATOR_REQUIRED','Select the linked creator wallet saved in this prepared draft.');
    await (deps.verifySnapshot??verifyPreparedOneshotSnapshot)(draft);
    const chain=await connect(),scope={owner:session.userId,draftId,revision:draft.revision,deploymentId:chain.deploymentId,from};
    const [page,pending]=await Promise.all([
      progressRepository.list(session.userId,{draftId,revision:draft.revision,deploymentId:chain.deploymentId,from,limit:10,cursor:input.cursor}),
      progressRepository.pending(session.userId,{draftId,revision:draft.revision,deploymentId:chain.deploymentId,from},now()),
    ]);
    if(page.items.some(item=>!sameLaunchScope(item,scope))) throw new ApiError(503,'LAUNCH_PROGRESS_INTEGRITY','The saved launch does not match this workspace.');
    let selected:NftCreatorProgress|null=null;
    if(input.launchId) {
      const item=await progressRepository.get(input.launchId);
      if(!item || !sameLaunchScope(item,scope)) throw new ApiError(404,'LAUNCH_NOT_FOUND','This launch is unavailable in this saved draft.');
      selected=await creatorProgress(chain,item,draft);
    }
    if((await chain.source.block(chain.block.number)).hash!==chain.block.hash) conflict('CHAIN_MOVED','The local launch checkpoint changed. Refresh launch progress.');
    if(session.expiresAt*1000<=now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again to continue this launch.');
    return {draftId,revision:draft.revision,from,deploymentId:chain.deploymentId,
      items:page.items.map(item=>({id:item.id,collection:item.collection,createHash:item.createHash,createdAt:new Date(item.createdAt).toISOString()})),
      nextCursor:page.nextCursor??null,pending,selected};
  }
  async function floor(raw:string,wallet:string,session:OneshotSession) {
    if(session.expiresAt*1000<=now())throw new ApiError(401,'AUTH_REQUIRED','Sign in again to view settings.');
    const from=assertLinkedEvmAddress(session,address.parse(wallet)),selected=address.parse(raw),chain=await connect();
    const state=await collectionState(chain,selected);
    if(state.creator!==from || chain.manifest.deploymentVersion!=='oneshot-nft-v2')throw new ApiError(404,'NOT_FOUND','Settings not available.');
    const commitment=await readContract(chain,chain.manifest.marketplace.address,GUARDED_MARKETPLACE_ABI,'policyCommitment',[selected]) as Hex;
    const current=await policies.resolve({deploymentId:chain.deploymentId,collection:selected,creator:state.creator},commitment);
    const eligible=policies.eligible(state.creator);
    if(!eligible&&!current.enabled)throw new ApiError(404,'NOT_FOUND','Settings not available.');
    if((await chain.source.block(chain.block.number)).hash!==chain.block.hash)conflict('CHAIN_MOVED','The settings block changed. Refresh settings.');
    return {eligible,creator:state.creator,collection:selected,deploymentId:chain.deploymentId,enabled:current.enabled,floorRaw:current.floorRaw,policyCommitment:commitment,guarded:true,network};
  }
  function quotedCall(previous:NftReview|undefined,functionName:string) {
    if(!previous)return undefined;
    try {
      const decoded=decodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,data:previous.data});
      if(decoded.functionName!==functionName)throw new Error();
      return decoded.args as readonly unknown[];
    }catch{return conflict('REVIEW_CHANGED','The saved authorization changed. Prepare a fresh review.');}
  }
  async function listingCall(chain:Chain,from:Address,collection:Address,creator:Address,tokenId:bigint,priceText:string,previous?:NftReview) {
    let entered:bigint;
    try{entered=parseAssetAmount(priceText,18);}catch{return conflict('INVALID_PRICE','Use an exact ETH amount with at most 18 decimals.');}
    const to=chain.manifest.marketplace.address;
    if(chain.manifest.deploymentVersion==='oneshot-nft-v1') {
      if(entered<=0n)conflict('INVALID_PRICE','Set a positive resale price.');
      return {to,data:encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'list',args:[collection,tokenId,entered]}),summary:{priceRaw:entered.toString(),effect:'Move this NFT into marketplace escrow.'}};
    }
    const [commitment,nonce]=await Promise.all([
      readContract(chain,to,GUARDED_MARKETPLACE_ABI,'policyCommitment',[collection]) as Promise<Hex>,
      readContract(chain,to,GUARDED_MARKETPLACE_ABI,'listingNonces',[from]) as Promise<bigint>,
    ]);
    const policy=await policies.resolve({deploymentId:chain.deploymentId,collection,creator},commitment);
    let price:bigint;
    try{price=applyProtectedFloor(entered,BigInt(policy.floorRaw)).listingRaw;}catch{return conflict('PRICE_OVERFLOW','The final listing amount exceeds uint256.');}
    if(price<=0n)conflict('INVALID_PRICE','Set a positive resale price.');
    const old=quotedCall(previous,'listAuthorized'),deadline=old?old[5] as bigint:chain.block.timestamp+120n;
    if(old&&(old[3]!==nonce||old[4]!==commitment))conflict('REVIEW_CHANGED','Listing settings or the wallet nonce changed. Prepare a fresh review.');
    if(deadline<chain.block.timestamp)conflict('REVIEW_EXPIRED','This listing authorization expired. Prepare a fresh review.');
    const {authority,salt}=chain.manifest.listingAuthorization;
    const signature=old?old[6] as Hex:await policies.signListing(to,authority,{seller:from,collection,tokenId,totalPrice:price,nonce,policyCommitment:commitment,deadline,deploymentSalt:salt});
    return {to,data:encodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,functionName:'listAuthorized',args:[collection,tokenId,price,nonce,commitment,deadline,signature]}),
      summary:{enteredPriceRaw:entered.toString(),floorPriceRaw:policy.floorRaw,priceRaw:price.toString(),policyCommitment:commitment,effect:'Move this NFT into marketplace escrow at the final price shown.'}};
  }
  async function policyCall(chain:Chain,input:NftReviewInput,from:Address,creator:Address,previous?:NftReview) {
    if(from!==creator||chain.manifest.deploymentVersion!=='oneshot-nft-v2')throw new ApiError(404,'NOT_FOUND','Settings not available.');
    const collection=input.collection!,to=chain.manifest.marketplace.address;
    const expected=await readContract(chain,to,GUARDED_MARKETPLACE_ABI,'policyCommitment',[collection]) as Hex;
    const context={deploymentId:chain.deploymentId,collection,creator},current=await policies.resolve(context,expected);
    if(!policies.eligible(creator)&&(!current.enabled||input.floorEnabled))throw new ApiError(404,'NOT_FOUND','Settings not available.');
    const old=quotedCall(previous,'setPolicyCommitment'),deadline=old?old[3] as bigint:chain.block.timestamp+120n;
    if(old&&old[2]!==expected)conflict('REVIEW_CHANGED','The current settings changed. Prepare a fresh review.');
    if(deadline<chain.block.timestamp)conflict('REVIEW_EXPIRED','This settings authorization expired. Prepare a fresh review.');
    if(!old)policies.assertAuthority(chain.manifest.listingAuthorization.authority);
    const proposed=await policies.stage(context,input.floorEnabled!,input.floorPrice!,old?.[1] as Hex|undefined);
    const {authority,salt}=chain.manifest.listingAuthorization;
    const signature=old?old[4] as Hex:await policies.signPolicy(to,authority,{creator,collection,commitment:proposed.commitment,expectedCommitment:expected,deadline,deploymentSalt:salt});
    return {to,data:encodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,functionName:'setPolicyCommitment',args:[collection,proposed.commitment,expected,deadline,signature]}),
      summary:{floorEnabled:String(proposed.enabled),floorPriceRaw:proposed.floorRaw,policyCommitment:proposed.commitment,previousCommitment:expected,effect:'Applies to new listings. Existing orders keep their approved prices.'}};
  }
  async function publicCall(input:NftReviewInput,from:Address,chain:Chain,previous?:NftReview) {
    if(!input.collection) {
      const to=chain.manifest.marketplace.address;
      if(input.action!=='claim' || input.contract!==to)conflict('INVALID_CONTRACT','Standalone claims are limited to this deployment’s verified marketplace.');
      const recipient=input.recipient??from;
      if(recipient===to)conflict('INVALID_RECIPIENT','Choose a recipient wallet that can receive the proceeds.');
      const amount=rpcAmount(await readContract(chain,to,NFT_MARKETPLACE_ABI,'pending',[from]));
      if(amount===0n)conflict('NOTHING_TO_CLAIM','This wallet has no pending proceeds at the marketplace.');
      const data=encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'claimTo',args:[recipient]});
      return {scope:'public' as const,draftId:to,revision:0,from,to,data,value:'0',action:input.action,
        summary:{contract:to,recipient,claimAmountRaw:amount.toString(),nativeAsset:'Local ETH (18 decimals)',effect:'Claim this wallet’s aggregate marketplace proceeds.'}};
    }
    const collection = input.collection!, {manifest,block} = chain, state = await collectionState(chain,collection);
    if (!state.opened && input.action!=='policy') conflict('NOT_OPEN','This collection has not opened its frozen mint terms.');
    const read = (to:Address,abi:Abi,name:string,args:readonly unknown[]=[]) => readContract(chain,to,abi,name,args);
    const recipient = input.recipient ?? from;
    if (recipient === collection || recipient === manifest.marketplace.address) conflict('INVALID_RECIPIENT','Choose a recipient wallet that can receive this asset.');
    const required = (key:'quantity'|'tokenId'|'listingId'|'price') => {
      if (input[key] === undefined) throw new ApiError(400,'FIELD_REQUIRED',`Provide ${key} for this action.`);
      return input[key]!;
    };
    const summary:Record<string,string> = {name:state.name,symbol:state.symbol,creator:state.creator,collection,nativeAsset:'Local ETH (18 decimals)',
      maxSupply:state.terms.maxSupply.toString(),royaltyBps:String(state.terms.royaltyBps),contentHash:state.terms.contentHash,termsHash:state.termsHash};
    let to:Address = collection, data:Hex, value=0n;
    switch(input.action) {
      case 'policy': {
        const call=await policyCall(chain,input,from,state.creator,previous);to=call.to;data=call.data;Object.assign(summary,call.summary);break;
      }
      case 'mint': {
        const quantity=BigInt(required('quantity'));
        if (quantity>20n) conflict('INVALID_QUANTITY','Mint between 1 and 20 NFTs in one transaction.');
        const allowlist=state.terms.allowlist, activeAllowlist=state.terms.allowlistRoot !== `0x${'0'.repeat(64)}` && block.timestamp>=allowlist.start && block.timestamp<allowlist.end;
        const stage=activeAllowlist?allowlist:state.terms.publicMint;
        if (block.timestamp<stage.start || block.timestamp>=stage.end) conflict('NO_ACTIVE_STAGE','No mint stage is active at the simulated block.');
        let proof:Hex[]=[];
        if (activeAllowlist) {
          const publication=await repository.publication(`${chain.deploymentId}:${collection}`);
          if (!publication || publication.termsHash !== state.termsHash) conflict('PROOF_UNAVAILABLE','The creator must confirm this collection opening before allowlist checkout is available.');
          const plan=prepareNftTerms(publication!.draft,{chainId:31337,nativeDecimals:18,collection,nowSeconds:0n});
          if (plan.termsHash!==state.termsHash || plan.summary.creator!==state.creator) conflict('PROOF_UNAVAILABLE','The saved allowlist does not match the frozen collection.');
          proof=plan.allowlist.proofs[from];
          if (!proof) conflict('NOT_ALLOWLISTED','The selected wallet is absent from this allowlist.');
        }
        value=stage.price*quantity;
        if (value >= (1n<<256n)) conflict('PRICE_OVERFLOW','The total mint price exceeds uint256.');
        data=encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'mint',args:[quantity,recipient,value,proof]});
        const platform=value*200n/10000n;
        Object.assign(summary,{quantity:quantity.toString(),recipient,stage:activeAllowlist?'allowlist':'public',unitPriceRaw:stage.price.toString(),totalPriceRaw:value.toString(),platformFeeRaw:platform.toString(),creatorProceedsRaw:(value-platform).toString()});
        break;
      }
      case 'approve': case 'list': {
        const tokenId=BigInt(required('tokenId'));
        if (String(await read(collection,NFT_COLLECTION_ABI,'ownerOf',[tokenId])).toLowerCase()!==from) conflict('NOT_OWNER','The selected wallet no longer owns this NFT.');
        summary.tokenId=tokenId.toString();
        if (input.action==='approve') {
          data=encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'approve',args:[manifest.marketplace.address,tokenId]});
          summary.approvedSpender=manifest.marketplace.address;
        } else {
          const call=await listingCall(chain,from,collection,state.creator,tokenId,required('price'),previous);
          to=call.to;data=call.data;Object.assign(summary,call.summary);
        }
        break;
      }
      case 'buy': case 'cancel': {
        const listingId=BigInt(required('listingId'));
        const listing=await read(manifest.marketplace.address,NFT_MARKETPLACE_ABI,'listings',[listingId]) as readonly [Address,Address,bigint,bigint,boolean];
        if (!listing[4] || listing[0].toLowerCase()!==collection) conflict('LISTING_CHANGED','This listing is inactive or belongs to another collection.');
        to=manifest.marketplace.address;
        Object.assign(summary,{listingId:listingId.toString(),tokenId:listing[2].toString(),seller:listing[1].toLowerCase(),recipient,priceRaw:listing[3].toString()});
        if (input.action==='buy') {
          value=listing[3]; const split=splitNftSettlement(value,state.terms.royaltyBps);
          Object.assign(summary,{platformFeeRaw:split.platform.toString(),royaltyRaw:split.royalty.toString(),sellerProceedsRaw:split.seller.toString()});
          data=encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'buy',args:[listingId,value,recipient]});
        } else {
          if (listing[1].toLowerCase()!==from) conflict('NOT_SELLER','Select the wallet that owns this listing.');
          data=encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'cancelTo',args:[listingId,recipient]});
        }
        break;
      }
      case 'claim': {
        to=input.contract??manifest.marketplace.address;
        if (to!==collection && to!==manifest.marketplace.address) conflict('INVALID_CONTRACT','Claims are limited to this collection and its verified marketplace.');
        const amount=await read(to,to===collection?NFT_COLLECTION_ABI:NFT_MARKETPLACE_ABI,'pending',[from]) as bigint;
        if (amount<=0n) conflict('NOTHING_TO_CLAIM','This wallet has no pending proceeds at this contract.');
        data=encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'claimTo',args:[recipient]});
        Object.assign(summary,{recipient,claimAmountRaw:amount.toString()});break;
      }
      default:return conflict('INVALID_ACTION','Creator actions require an owned prepared draft.');
    }
    return {scope:'public' as const,draftId:collection,revision:0,from,to,data,value:value.toString(),action:input.action,summary};
  }
  async function derive(input: NftReviewInput, session: OneshotSession, previous?:NftReview) {
    if (session.expiresAt * 1000 <= now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again before reviewing a transaction.');
    const from = assertLinkedEvmAddress(session,input.from);
    const chain = await connect();
    if (!input.draftId) {
      const call=await publicCall(input,from,chain,previous);
      let simulation:Awaited<ReturnType<Rpc['simulateCall']>>;
      try { simulation=await chain.rpc.simulateCall({from,to:call.to,data:call.data,value:hex(BigInt(call.value))},{number:hex(chain.block.number),hash:chain.block.hash}); }
      catch { return conflict('SIMULATION_FAILED','The exact transaction could not execute at the reviewed local block. Refresh balances, approvals, listing state and schedule before trying again.'); }
      if ((await chain.source.block(chain.block.number)).hash!==chain.block.hash) conflict('CHAIN_MOVED','The simulated block changed. Build a fresh review.');
      if (session.expiresAt*1000<=now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again before reviewing a transaction.');
      return {...call,chainId:31337 as const,network,deploymentId:chain.deploymentId,
        simulation:{blockNumber:chain.block.number.toString(),blockHash:chain.block.hash,gasEstimate:simulation.gasEstimate},publicationDraft:undefined as NftLaunchDraft|undefined};
    }
    const draft = await (deps.getDraft ?? getOneshotDraft)(input.draftId,session);
    if (draft.revision !== input.expectedRevision) conflict('DRAFT_CHANGED','Reload the current draft before reviewing another transaction.');
    await (deps.verifySnapshot ?? verifyPreparedOneshotSnapshot)(draft);
    const {manifest,rpc,source,block} = chain;
    const blockTag = {blockHash:block.hash,requireCanonical:true};
    const read = async (to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
      const data = encodeFunctionData({abi,functionName,args});
      const value = await rpc.readRpc('eth_call',[{to,data},blockTag]);
      if (!isData(value)) throw new ApiError(503,'RPC_DATA_INVALID','The local chain returned invalid contract data.');
      return decodeFunctionResult({abi,functionName,data:value});
    };
    const creatorAction = ['create','configure','open'].includes(input.action);
    const creator = draft.creatorWallet?.toLowerCase();
    if (!creator || (creatorAction && creator !== from)) return conflict('CREATOR_REQUIRED','Select the linked creator wallet saved in this prepared draft.');
    // A nonzero placeholder is used only to check pre-creation fields; roots are rebuilt for the actual collection.
    const collection = input.collection ?? manifest.factory.address;
    let plan: ReturnType<typeof prepareNftTerms>;
    try { plan = prepareNftTerms(draft,{chainId:31337,nativeDecimals:18,collection,nowSeconds:creatorAction ? block.timestamp : 0n}); }
    catch (error) { if (error instanceof NftLaunchError) conflict(error.code,error.message); throw error; }
    const summary: Record<string,string> = {
      name: draft.name, symbol: plan.summary.symbol, creator,
      nativeAsset: 'Local ETH (18 decimals)', maxSupply: String(draft.maxSupply), royaltyBps: String(draft.royaltyBps),
      contentHash: draft.snapshot!.contentHash,
    };
    let to: Address = collection, data: Hex, value = 0n;
    const requireField = <K extends keyof NftReviewInput>(key: K): NonNullable<NftReviewInput[K]> => {
      const item = input[key]; if (item === undefined) throw new ApiError(400,'FIELD_REQUIRED',`Provide ${key} for this action.`);
      return item as NonNullable<NftReviewInput[K]>;
    };
    const recipient = input.recipient ?? from;
    if (input.action === 'create') {
      if (input.collection) conflict('INVALID_ACTION','Create derives its destination from the verified factory.');
      to = manifest.factory.address;
      data = encodeFunctionData({abi:NFT_FACTORY_ABI,functionName:'createCollection',args:[draft.name,plan.summary.symbol]});
      summary.factory = to;
    } else {
      requireField('collection');
      if (!await read(manifest.factory.address,NFT_FACTORY_ABI,'isCollection',[collection])) conflict('UNKNOWN_COLLECTION','Choose a collection registered by this deployment.');
      const expected = [manifest.factory.address,creator,draft.name,plan.summary.symbol];
      const actual = await Promise.all(['factory','creator','name','symbol'].map(name => read(collection,NFT_COLLECTION_ABI,name)));
      if (actual.some((item,index) => typeof item !== 'string' || (index < 2 ? item.toLowerCase() : item) !== expected[index])) conflict('COLLECTION_MISMATCH','The collection identity differs from this prepared draft.');
      summary.collection = collection;
      if (recipient === collection || recipient === manifest.marketplace.address) conflict('INVALID_RECIPIENT','Choose a recipient wallet that can receive this asset.');
      if (input.action === 'configure') {
        data = encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'configure',args:[plan.terms]});
        summary.termsHash = plan.termsHash;
        summary.publicPriceRaw = plan.terms.publicMint.price.toString();
        summary.allowlistPriceRaw = plan.terms.allowlist.price.toString();
        summary.publicStart = draft.publicStart; summary.publicEnd = draft.publicEnd;
        if (draft.allowlistStart) { summary.allowlistStart = draft.allowlistStart; summary.allowlistEnd = draft.allowlistEnd!; }
      } else {
        const configured = await read(collection,NFT_COLLECTION_ABI,'terms');
        const observedHash = keccak256(encodeAbiParameters([NFT_TERMS_PARAMETER],[configured as typeof plan.terms]));
        if (observedHash !== plan.termsHash) conflict('TERMS_CHANGED','The on-chain terms differ from this prepared draft. Configure the exact draft before continuing.');
        summary.termsHash = plan.termsHash;
        switch (input.action) {
          case 'open':
            data = encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'open'});
            summary.effect = 'Permanently freeze issuance, royalty, schedule and metadata commitments.';
            break;
          case 'mint': {
            const quantity = BigInt(requireField('quantity'));
            if (quantity > 20n) conflict('INVALID_QUANTITY','Mint between 1 and 20 NFTs in one transaction.');
            const allowlist = plan.terms.allowlist;
            const activeAllowlist = allowlist.start !== 0n && block.timestamp >= allowlist.start && block.timestamp < allowlist.end;
            const stage = activeAllowlist ? allowlist : plan.terms.publicMint;
            if (block.timestamp < stage.start || block.timestamp >= stage.end) conflict('NO_ACTIVE_STAGE','No mint stage is active at the simulated block.');
            const proof = activeAllowlist ? plan.allowlist.proofs[from] : [];
            if (!proof) conflict('NOT_ALLOWLISTED','The selected wallet is absent from this allowlist.');
            value = stage.price * quantity;
            if (value >= 1n << 256n) conflict('PRICE_OVERFLOW','The total mint price exceeds uint256.');
            data = encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'mint',args:[quantity,recipient,value,proof]});
            Object.assign(summary,{quantity:quantity.toString(),recipient,stage:activeAllowlist?'allowlist':'public',unitPriceRaw:stage.price.toString(),totalPriceRaw:value.toString()});
            summary.platformFeeRaw = (value * 200n / 10000n).toString();
            summary.creatorProceedsRaw = (value - BigInt(summary.platformFeeRaw)).toString();
            break;
          }
          case 'approve': case 'list': {
            const tokenId = BigInt(requireField('tokenId'));
            if (String(await read(collection,NFT_COLLECTION_ABI,'ownerOf',[tokenId])).toLowerCase() !== from) conflict('NOT_OWNER','The selected wallet no longer owns this NFT.');
            summary.tokenId = tokenId.toString();
            if (input.action === 'approve') {
              data = encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'approve',args:[manifest.marketplace.address,tokenId]});
              summary.approvedSpender = manifest.marketplace.address;
            } else {
              const call=await listingCall(chain,from,collection,creator as Address,tokenId,requireField('price'),previous);
              to=call.to;data=call.data;Object.assign(summary,call.summary);
            }
            break;
          }
          case 'buy': case 'cancel': {
            const listingId = BigInt(requireField('listingId'));
            const listing = await read(manifest.marketplace.address,NFT_MARKETPLACE_ABI,'listings',[listingId]) as readonly [Address,Address,bigint,bigint,boolean];
            if (!listing[4] || listing[0].toLowerCase() !== collection) conflict('LISTING_CHANGED','This listing is inactive or belongs to another collection.');
            to = manifest.marketplace.address;
            Object.assign(summary,{listingId:listingId.toString(),tokenId:listing[2].toString(),seller:listing[1].toLowerCase(),recipient,priceRaw:listing[3].toString()});
            if (input.action === 'buy') {
              value = listing[3];
              const split = splitNftSettlement(value,draft.royaltyBps);
              Object.assign(summary,{platformFeeRaw:split.platform.toString(),royaltyRaw:split.royalty.toString(),sellerProceedsRaw:split.seller.toString()});
              data = encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'buy',args:[listingId,value,recipient]});
            } else {
              if (listing[1].toLowerCase() !== from) conflict('NOT_SELLER','Select the wallet that owns this listing.');
              data = encodeFunctionData({abi:NFT_MARKETPLACE_ABI,functionName:'cancelTo',args:[listingId,recipient]});
            }
            break;
          }
          case 'claim': {
            to = input.contract ?? manifest.marketplace.address;
            if (to !== collection && to !== manifest.marketplace.address) conflict('INVALID_CONTRACT','Claims are limited to this collection and its verified marketplace.');
            const amount = await read(to,to === collection ? NFT_COLLECTION_ABI : NFT_MARKETPLACE_ABI,'pending',[from]) as bigint;
            if (amount <= 0n) conflict('NOTHING_TO_CLAIM','This wallet has no pending proceeds at this contract.');
            data = encodeFunctionData({abi:NFT_COLLECTION_ABI,functionName:'claimTo',args:[recipient]});
            Object.assign(summary,{recipient,claimAmountRaw:amount.toString()}); break;
          }
          default: throw new ApiError(400,'INVALID_ACTION','Choose a supported NFT action.');
        }
      }
    }
    let simulation: Awaited<ReturnType<Rpc['simulateCall']>>;
    try { simulation = await rpc.simulateCall({from,to,data,value:hex(value)},{number:hex(block.number),hash:block.hash}); }
    catch { conflict('SIMULATION_FAILED','The exact transaction could not execute at the reviewed local block. Refresh chain state, balances, approvals and schedule before trying again.'); }
    if ((await source.block(block.number)).hash !== block.hash) conflict('CHAIN_MOVED','The simulated block changed. Build a fresh review.');
    // Detect an archive/revision change during RPC awaits, before returning a signable review.
    const latestDraft = await (deps.getDraft ?? getOneshotDraft)(input.draftId,session);
    if (latestDraft.revision !== draft.revision || latestDraft.status !== 'prepared') conflict('DRAFT_CHANGED','The prepared draft changed during simulation.');
    if (session.expiresAt * 1000 <= now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again before reviewing a transaction.');
    const publicationDraft:NftLaunchDraft|undefined=input.action==='open'?{
      status:'prepared',name:draft.name,symbol:draft.symbol,maxSupply:draft.maxSupply,royaltyBps:draft.royaltyBps,
      publicPrice:draft.publicPrice,allowlistPrice:draft.allowlistPrice,perWalletLimit:draft.perWalletLimit,
      publicStart:draft.publicStart,publicEnd:draft.publicEnd,allowlistStart:draft.allowlistStart,allowlistEnd:draft.allowlistEnd,
      allowlistAddresses:[...draft.allowlistAddresses],creatorWallet:draft.creatorWallet,snapshot:{...draft.snapshot!},
    }:undefined;
    return {scope:'draft' as const,chainId:31337 as const,from,to,data,value:value.toString(),action:input.action,network,summary,
      deploymentId:chain.deploymentId,draftId:draft.id,revision:draft.revision,
      simulation:{blockNumber:block.number.toString(),blockHash:block.hash,gasEstimate:simulation!.gasEstimate},publicationDraft};
  }
  async function review(raw: unknown, session: OneshotSession): Promise<NftReview> {
    const input = nftReviewInput.parse(raw);
    const {publicationDraft,...derived} = await derive(input,session);
    const id = randomUUID(), createdAt = now(), expiresAt = new Date(createdAt+120_000).toISOString();
    const unsigned = {id,expiresAt,...derived};
    const result = {...unsigned,reviewHash:`0x${digest(unsigned)}`};
    await repository.create({review:result,input,owner:session.userId,session:session.sessionId,createdAt,publicationDraft},now());
    return result;
  }
  async function owned(id: string, hash: string | undefined, session: OneshotSession, expired = false) {
    if (session.expiresAt * 1000 <= now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again to check this transaction.');
    const stored = await repository.get(id,now());
    if (!stored || stored.owner !== session.userId || (!expired && stored.session !== session.sessionId) || (hash !== undefined && stored.review.reviewHash !== hash)) throw new ApiError(404,'REVIEW_NOT_FOUND','This transaction review is unavailable in this account.');
    verifyReview(stored);
    assertLinkedEvmAddress(session,stored.review.from);
    if (!expired && now() >= Date.parse(stored.review.expiresAt)) conflict('REVIEW_EXPIRED','This review expired. Build a fresh review before signing.');
    return stored;
  }
  async function validate(id: string, hash: string, session: OneshotSession): Promise<NftReview> {
    const stored = await owned(id,hash,session);
    if (stored.transactionHash) conflict('ALREADY_SUBMITTED','This review already tracks a transaction. Check its receipt before creating another action.');
    const {publicationDraft:_private,...fresh} = await derive(stored.input,session,stored.review);
    const old = stored.review;
    if (['chainId','from','to','data','value','deploymentId','draftId','revision'].some(key=>fresh[key as keyof typeof fresh] !== old[key as keyof NftReview])
      || digest(fresh.summary) !== digest(old.summary)) conflict('REVIEW_CHANGED','The transaction or its terms changed. Review a fresh transaction before signing.');
    const latest=await owned(id,hash,session);
    if (latest.transactionHash) conflict('ALREADY_SUBMITTED','This review already tracks a transaction. Check its receipt.');
    return {...old,simulation:fresh.simulation};
  }
  function verifyReview(item:StoredNftReview) {
    const {reviewHash,...unsigned}=item.review;
    if (reviewHash!==`0x${digest(unsigned)}`) throw new ApiError(503,'TRANSACTION_INTEGRITY','The saved transaction review failed its integrity check.');
  }
  function recoveryRecord(item:StoredNftReview) {
    verifyReview(item);
    const outcome:'review'|'submitted'|'confirmed'|'reverted'=item.outcome??(item.transactionHash?'submitted':'review');
    return {review:item.review,transactionHash:item.transactionHash??null,outcome,updatedAt:item.updatedAt??new Date(item.createdAt).toISOString()};
  }
  async function submitted(id:string,reviewHash:string,hash:Hex,session:OneshotSession) {
    if (!isHash(hash)) throw new ApiError(400,'INVALID_HASH','Provide a transaction hash.');
    const stored=await owned(id,reviewHash,session,true);
    // Broadcast may finish after signing expiry or re-login. This records a hash, never authorizes a new signature.
    if (stored.review.reviewHash!==reviewHash) throw new ApiError(404,'REVIEW_NOT_FOUND','This transaction review is unavailable in this account.');
    return recoveryRecord(await repository.bindHash(id,session.userId,hash.toLowerCase() as Hex,now()));
  }
  async function recover(id:string,session:OneshotSession) { return recoveryRecord(await owned(id,undefined,session,true)); }
  async function transactions(session:OneshotSession,query:{wallet?:string;limit?:number;cursor?:string}={}) {
    if (session.expiresAt*1000<=now()) throw new ApiError(401,'AUTH_REQUIRED','Sign in again to recover transactions.');
    const wallet=query.wallet?assertLinkedEvmAddress(session,query.wallet):undefined;
    const page=await repository.list(session.userId,{wallet,limit:query.limit??20,cursor:query.cursor},now());
    // Unlinked historical senders are not exposed, even after signing into the same account again.
    return {items:page.items.filter(item=>session.linkedAddresses.some(value=>value.toLowerCase()===item.review.from)).map(recoveryRecord),...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
  }
  async function receipt(id: string, hash: Hex, session: OneshotSession) {
    if (!isHash(hash)) throw new ApiError(400,'INVALID_HASH','Provide a transaction hash.');
    hash = hash.toLowerCase() as Hex;
    const stored = await owned(id,undefined,session,true), reviewed = stored.review;
    if (stored.transactionHash && stored.transactionHash !== hash) conflict('TRANSACTION_CHANGED','This review is already tracking a different transaction.');
    const chain = await connect();
    if (chain.deploymentId !== reviewed.deploymentId) conflict('DEPLOYMENT_CHANGED','This receipt belongs to another local deployment.');
    const tx = await chain.rpc.readRpc('eth_getTransactionByHash',[hash]);
    if (tx === null) {
      await repository.bindHash(id,session.userId,hash,now());
      await repository.setOutcome(id,hash,'submitted',now());
      return {status:'pending' as const,hash};
    }
    if (!record(tx) || typeof tx.from !== 'string' || typeof tx.to !== 'string' || !isData(tx.input)
      || tx.from.toLowerCase() !== reviewed.from || tx.to.toLowerCase() !== reviewed.to || tx.input.toLowerCase() !== reviewed.data.toLowerCase()
      || rpcQuantity(tx.value).toString() !== reviewed.value || rpcQuantity(tx.chainId) !== 31337n || tx.hash !== hash) return conflict('TRANSACTION_MISMATCH','This transaction does not match the reviewed sender, destination, data, value and chain.');
    await repository.bindHash(id,session.userId,hash,now());
    const result = await chain.rpc.readRpc('eth_getTransactionReceipt',[hash]);
    if (result === null) { await repository.setOutcome(id,hash,'submitted',now()); return {status:'pending' as const,hash}; }
    if (!record(result) || !isHash(result.blockHash) || result.transactionHash !== hash || tx.blockHash !== result.blockHash || !Array.isArray(result.logs)) throw new ApiError(503,'RPC_DATA_INVALID','The transaction receipt is invalid.');
    const blockNumber = rpcQuantity(result.blockNumber), block = await chain.source.block(blockNumber);
    if (blockNumber <= BigInt(reviewed.simulation.blockNumber)) {
      // A replacement fork may mine the exact create/guarded call below the old review
      // height. Accept it only after proving the reviewed simulation was orphaned.
      const replayable=reviewed.action==='create' || chain.manifest.deploymentVersion==='oneshot-nft-v2'&&['list','policy'].includes(reviewed.action);
      const simulatedHeight=BigInt(reviewed.simulation.blockNumber);
      const orphaned=replayable&&(simulatedHeight>chain.block.number||(await chain.source.block(simulatedHeight)).hash!==reviewed.simulation.blockHash);
      if(!orphaned)conflict('RECEIPT_TOO_OLD','This transaction was mined before the reviewed simulation. Submit a new transaction from this review.');
    }
    if (block.hash !== result.blockHash.toLowerCase()) { await repository.setOutcome(id,hash,'submitted',now()); conflict('RECEIPT_REORGED','The receipt is no longer canonical. Refresh transaction confirmation.'); }
    const status = rpcQuantity(result.status);
    if (status === 0n) { await repository.setOutcome(id,hash,'reverted',now()); return {status:'reverted' as const,hash,blockNumber:blockNumber.toString(),blockHash:block.hash}; }
    if (status !== 1n) throw new ApiError(503,'RPC_DATA_INVALID','The transaction receipt status is invalid.');
    let collection: Address | undefined;
    const expectedEvent = {create:'CollectionCreated',configure:'TermsConfigured',open:'CollectionOpened',mint:'Minted',approve:'Approval',list:'Listed',buy:'Sold',cancel:'Cancelled',claim:'Claimed',policy:'PolicyCommitted'}[reviewed.action];
    let found = false;
    for (const log of result.logs) {
      if (!record(log) || typeof log.address !== 'string' || log.address.toLowerCase() !== reviewed.to || !isData(log.data) || !Array.isArray(log.topics) || !log.topics.every(isHash)) continue;
      try {
        const decoded = decodeEventLog({abi:[...NFT_FACTORY_ABI,...NFT_COLLECTION_ABI,...GUARDED_MARKETPLACE_ABI],data:log.data,topics:log.topics as [Hex,...Hex[]]});
        if (decoded.eventName !== expectedEvent) continue;
        const args = decoded.args as Record<string,unknown>;
        if (reviewed.action === 'create') {
          if (String(args.creator).toLowerCase() !== reviewed.from || args.name !== reviewed.summary.name || args.symbol !== reviewed.summary.symbol) continue;
          collection = address.parse(args.collection);
        }
        if (['configure','open'].includes(reviewed.action) && args.termsHash !== reviewed.summary.termsHash) continue;
        if(reviewed.action==='policy'&&(String(args.collection).toLowerCase()!==reviewed.summary.collection||args.commitment!==reviewed.summary.policyCommitment||args.previousCommitment!==reviewed.summary.previousCommitment))continue;
        found = true;
      } catch { /* Only a matching event from the exact reviewed destination can confirm the action. */ }
    }
    if (!found) conflict('RECEIPT_EVENT_MISSING','The receipt lacks the expected NFT action event.');
    if ((await chain.source.block(blockNumber)).hash !== block.hash) { await repository.setOutcome(id,hash,'submitted',now()); conflict('RECEIPT_REORGED','The receipt changed during confirmation.'); }
    if(reviewed.action==='create' && collection) {
      const association:NftLaunchAssociation={version:1,id:reviewed.id,owner:session.userId,draftId:reviewed.draftId,revision:reviewed.revision,
        deploymentId:chain.deploymentId,from:reviewed.from,collection,createHash:hash,blockNumber:blockNumber.toString(),blockHash:block.hash,createdAt:stored.createdAt};
      const previous=await progressRepository.get(reviewed.id);
      let orphaned=false;
      if(previous && digest(previous)!==digest(association)) {
        for(const key of ['id','owner','draftId','revision','deploymentId','from','createHash','createdAt'] as const)
          if(previous[key]!==association[key]) conflict('LAUNCH_ASSOCIATION_CHANGED','This saved creation belongs to another launch.');
        const latest=await chain.source.height(),previousHeight=BigInt(previous.blockNumber);
        orphaned=previousHeight>latest || (await chain.source.block(previousHeight)).hash!==previous.blockHash;
        if(!orphaned) conflict('LAUNCH_ASSOCIATION_CHANGED','A different canonical creation is already saved for this launch.');
      }
      if((await chain.source.block(blockNumber)).hash!==block.hash) { await repository.setOutcome(id,hash,'submitted',now()); conflict('RECEIPT_REORGED','The creation receipt changed while saving launch progress.'); }
      await progressRepository.save(association,orphaned?previous!:undefined);
    }
    if (reviewed.action==='open' && stored.publicationDraft && stored.input.collection) {
      const selected=stored.input.collection, freshBlock=await chain.source.block(await chain.source.height());
      const state=await collectionState({...chain,block:freshBlock},selected);
      if (!state.opened || state.termsHash!==reviewed.summary.termsHash || state.creator!==reviewed.from) conflict('TERMS_CHANGED','The opened collection no longer matches this reviewed launch.');
      const key=`${chain.deploymentId}:${selected}`, previous=await repository.publication(key);
      const publication:NftPublication={deploymentId:chain.deploymentId,collection:selected,draft:stored.publicationDraft,termsHash:state.termsHash,openHash:hash,blockNumber:blockNumber.toString(),blockHash:block.hash,creatorUserId:session.userId};
      let orphaned=false;
      if (previous && (previous.termsHash!==publication.termsHash || previous.draft.creatorWallet?.toLowerCase()!==publication.draft.creatorWallet?.toLowerCase())) {
        const previousHeight=BigInt(previous.blockNumber);
        orphaned=previousHeight>freshBlock.number || (await chain.source.block(previousHeight)).hash!==previous.blockHash;
        if (!orphaned) conflict('PUBLICATION_CONFLICT','A different canonical opening already exists for this collection.');
      }
      await repository.publish(key,publication,orphaned?previous!:undefined);
    }
    await repository.setOutcome(id,hash,'confirmed',now());
    return {status:'confirmed' as const,hash,blockNumber:blockNumber.toString(),blockHash:block.hash,...(collection?{collection}:{})};
  }
  return {status,collection,earnings,progress,floor,review,validate,submitted,recover,transactions,receipt};
}
export const nftLaunch = createNftLaunchService();
