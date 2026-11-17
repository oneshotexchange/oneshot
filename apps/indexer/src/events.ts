import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex } from 'viem';
import { IndexerError, type Block, type IndexerTransaction, type Manifest, type ProjectionValue, type RawLog } from './types';

export const factoryEvents = parseAbi([
  'event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol)',
]);
export const collectionEvents = parseAbi([
  'event TermsConfigured(bytes32 indexed termsHash)',
  'event CollectionOpened(bytes32 indexed termsHash, bytes32 indexed contentHash)',
  'event Minted(address indexed payer, address indexed recipient, uint256 firstTokenId, uint256 quantity, uint256 totalPrice, uint256 platformFee, uint256 creatorProceeds, bool allowlistStage)',
  'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
]);
export const marketplaceEvents = parseAbi([
  'event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 totalPrice)',
  'event Cancelled(uint256 indexed listingId, address indexed seller, address indexed recipient)',
  'event Sold(uint256 indexed listingId, address indexed buyer, address indexed recipient, uint256 totalPrice, uint256 platformFee, uint256 royalty, uint256 sellerProceeds)',
  'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
]);
export const guardedMarketplaceEvents = [...marketplaceEvents, ...parseAbi([
  'event PolicyCommitted(address indexed collection, bytes32 indexed previousCommitment, bytes32 indexed commitment)',
])];
export const offerMarketplaceEvents=[...guardedMarketplaceEvents,...parseAbi([
 'event OfferCreated(uint256 indexed offerId,address indexed collection,address indexed bidder,uint256 tokenId,uint256 unitPrice,uint256 quantity,address recipient,uint256 expiry)',
 'event OfferCancelled(uint256 indexed offerId,address indexed bidder,uint256 quantity,uint256 refund)',
 'event OfferExpired(uint256 indexed offerId,address indexed bidder,address indexed caller,uint256 quantity,uint256 refund)',
 'event OfferAccepted(uint256 indexed offerId,address indexed collection,uint256 indexed tokenId,address seller,address bidder,address recipient,uint256 totalPrice,uint256 platformFee,uint256 royalty,uint256 sellerProceeds,uint256 replacedListingId)',
])];

const ADDRESS = /^0x[\da-fA-F]{40}$/;
const HASH = /^0x[\da-fA-F]{64}$/;
const DATA = /^0x(?:[\da-fA-F]{2})*$/;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const fail = (code: string): never => { throw new IndexerError(code); };
function check(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
function address(value: unknown, nonzero = true): Address {
  check(typeof value === 'string' && ADDRESS.test(value), 'EVENT_ADDRESS_INVALID');
  const normalized = value.toLowerCase() as Address;
  check(!nonzero || normalized !== zeroAddress, 'EVENT_ADDRESS_INVALID');
  return normalized;
}
function hash(value: unknown): Hex {
  check(typeof value === 'string' && HASH.test(value), 'EVENT_HASH_INVALID');
  return value.toLowerCase() as Hex;
}
function amount(value: unknown): bigint {
  check(typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX, 'EVENT_AMOUNT_INVALID');
  return value;
}
function storedAmount(value: unknown): bigint {
  check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), 'PROJECTION_INVALID');
  return BigInt(value);
}
const itemId = (collection: string, tokenId: bigint | string) => `${collection}:${tokenId}`;
const activityId = (log: RawLog) => `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
const provenance = (manifest: Manifest, log: RawLog) => ({
  schemaVersion: manifest.schemaVersion, deploymentVersion: manifest.deploymentVersion, chainId: manifest.chainId,
  lastBlockNumber: log.blockNumber.toString(), lastBlockHash: log.blockHash.toLowerCase(),
  lastTransactionHash: log.transactionHash.toLowerCase(), lastLogIndex: log.logIndex,
});

function validateLog(log: RawLog) {
  address(log.address); hash(log.blockHash); hash(log.transactionHash);
  check(typeof log.blockNumber === 'bigint' && log.blockNumber >= 0n
    && Number.isSafeInteger(log.transactionIndex) && log.transactionIndex >= 0
    && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0, 'EVENT_POSITION_INVALID');
  check(typeof log.data === 'string' && DATA.test(log.data)
    && Array.isArray(log.topics) && log.topics.length > 0 && log.topics.length <= 4
    && log.topics.every(topic => typeof topic === 'string' && HASH.test(topic)), 'EVENT_ENCODING_INVALID');
}
function orderedLogs(logs: readonly RawLog[]) {
  const ordered = [...logs].sort((left, right) => left.blockNumber < right.blockNumber ? -1
    : left.blockNumber > right.blockNumber ? 1 : left.logIndex - right.logIndex);
  const positions = new Set<string>();
  const blocks = new Map<bigint, string>();
  const transactions = new Map<string, string>();
  let previous: RawLog | undefined;
  for (const log of ordered) {
    validateLog(log);
    const blockHash = hash(log.blockHash), transactionHash = hash(log.transactionHash);
    const position = `${log.blockNumber}:${log.logIndex}`;
    check(!positions.has(position), 'EVENT_DUPLICATE'); positions.add(position);
    check(!blocks.has(log.blockNumber) || blocks.get(log.blockNumber) === blockHash, 'EVENT_POSITION_INVALID');
    blocks.set(log.blockNumber, blockHash);
    const transactionPosition = `${log.blockNumber}:${log.transactionIndex}`;
    check(!transactions.has(transactionHash) || transactions.get(transactionHash) === transactionPosition, 'EVENT_POSITION_INVALID');
    transactions.set(transactionHash, transactionPosition);
    if (previous && previous.blockNumber === log.blockNumber) {
      check(log.transactionIndex >= previous.transactionIndex, 'EVENT_POSITION_INVALID');
      check(log.transactionIndex !== previous.transactionIndex || transactionHash === hash(previous.transactionHash), 'EVENT_POSITION_INVALID');
    }
    previous = log;
  }
  return ordered;
}

/** Re-encoding rejects extra topics/bytes and noncanonical dynamic ABI encodings too. */
function decode(abi: readonly AbiEvent[], log: RawLog): { eventName: string; args: Record<string, unknown> } {
  try {
    const event = decodeEventLog({ abi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true });
    const definition = abi.find(candidate => candidate.name === event.eventName);
    check(definition, 'EVENT_UNKNOWN');
    const args = event.args as Record<string, unknown>;
    const topics = encodeEventTopics({ abi: [definition], eventName: definition.name, args });
    const parameters = definition.inputs.filter(input => !input.indexed);
    const encoded = encodeAbiParameters(parameters, parameters.map(input => args[input.name!]));
    check(encoded.toLowerCase() === log.data.toLowerCase()
      && topics.length === log.topics.length
      && topics.every((topic, index) => typeof topic === 'string' && topic.toLowerCase() === log.topics[index]!.toLowerCase()), 'EVENT_ENCODING_INVALID');
    return { eventName: event.eventName, args };
  } catch (error) {
    if (error instanceof IndexerError) throw error;
    return fail('EVENT_UNKNOWN_OR_INVALID');
  }
}

function created(manifest: Manifest, args: Record<string, unknown>) {
  const collection = address(args.collection), creator = address(args.creator);
  check(collection !== address(manifest.factory.address) && collection !== address(manifest.marketplace.address), 'COLLECTION_INVALID');
  check(typeof args.name === 'string' && new TextEncoder().encode(args.name).length > 0
    && new TextEncoder().encode(args.name).length <= 100
    && typeof args.symbol === 'string' && new TextEncoder().encode(args.symbol).length > 0
    && new TextEncoder().encode(args.symbol).length <= 20, 'COLLECTION_INVALID');
  return { collection, creator, name: args.name, symbol: args.symbol };
}

/** Only the reviewed factory can introduce addresses into the collection log filter. */
export function discoverCollections(manifest: Manifest, logs: readonly RawLog[]): Address[] {
  const found = new Set<Address>();
  for (const log of orderedLogs(logs)) {
    if (address(log.address) !== address(manifest.factory.address)) continue;
    const { args } = decode(factoryEvents, log);
    const value = created(manifest, args);
    check(!found.has(value.collection), 'COLLECTION_DUPLICATE'); found.add(value.collection);
  }
  return [...found];
}

function serializable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^0x[\da-fA-F]+$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, serializable(field)]));
  return value;
}
async function collectionRecord(tx: IndexerTransaction, collection: string) {
  const record = await tx.get('collections', collection);
  check(record && record.address === collection && typeof record.creator === 'string', 'COLLECTION_UNKNOWN');
  return record;
}
async function itemRecord(tx: IndexerTransaction, collection: string, tokenId: bigint | string) {
  const record = await tx.get('items', itemId(collection, tokenId));
  check(record && record.collection === collection && record.tokenId === tokenId.toString(), 'ITEM_UNKNOWN');
  return record;
}
async function liability(tx:IndexerTransaction,market:string,meta:ProjectionValue,escrow:bigint,pending:bigint,inflow=0n,claimed=0n){
 const previous=await tx.get('offer-accounting',market),read=(field:string)=>previous?storedAmount(previous[field]):0n;
 const values={escrow:read('escrow')+escrow,pending:read('pending')+pending,inflows:read('inflows')+inflow,claimed:read('claimed')+claimed};
 check(values.escrow>=0n&&values.escrow<=UINT256_MAX&&values.pending>=0n&&values.pending<=UINT256_MAX&&values.inflows===values.escrow+values.pending+values.claimed,'OFFER_SOLVENCY_INVALID');
 await tx.put('offer-accounting',market,{market,...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.toString()])),...meta});
}

/**
 * Project a complete canonical log batch. Call inside the store's block transaction:
 * failures must roll back all projections, raw logs and their checkpoint together.
 * Amounts are decimal strings. Terms events commit hashes, not undisclosed terms.
 */
export async function projectLogs(tx: IndexerTransaction, manifest: Manifest, logs: readonly RawLog[],block?:Block): Promise<void> {
  const factory = address(manifest.factory.address), market = address(manifest.marketplace.address);
  const v3=manifest.deploymentVersion==='oneshot-nft-v3';
  if(v3&&logs.length)check(block&&logs.every(log=>log.blockNumber===block.number&&log.blockHash.toLowerCase()===block.hash.toLowerCase()),'EVENT_BLOCK_REQUIRED');
  const marketEvents = v3?offerMarketplaceEvents:manifest.deploymentVersion === 'oneshot-nft-v2' ? guardedMarketplaceEvents : marketplaceEvents;
  const mintedTransfers = new Set<string>(), escrowReleases = new Set<string>();
  const transferProofs=new Set<string>();
  for (const log of orderedLogs(logs)) {
    const source = address(log.address);
    const collection = source !== factory && source !== market ? await tx.get('collections', source) : null;
    // Events from unrelated contracts cannot create an original or modify its state.
    if (source !== factory && source !== market && !collection) continue;
    const decoded = decode(source === factory ? factoryEvents : source === market ? marketEvents : collectionEvents, log);
    const { eventName, args } = decoded;
    if (source === market && eventName === 'PolicyCommitted') {
      await collectionRecord(tx, address(args.collection));
      const previous = hash(args.previousCommitment), commitment = hash(args.commitment);
      check(commitment !== zeroHash && commitment !== previous, 'POLICY_COMMITMENT_INVALID');
      // The engine journals every canonical raw log. Private configuration has no public projection or undo writes.
      continue;
    }
    check(!await tx.get('activity', activityId(log)), 'EVENT_DUPLICATE');
    const meta = provenance(manifest, log);
    if (source === factory) {
      const value = created(manifest, args);
      check(!await tx.get('collections', value.collection), 'COLLECTION_DUPLICATE');
      await tx.put('collections', value.collection, {
        address: value.collection, creator: value.creator, factory, name: value.name, symbol: value.symbol,
        configured: false, opened: false, termsHash: null, contentHash: null, totalMinted: '0',
        primaryTotalPrice: '0', primaryPlatformFee: '0', primaryCreatorProceeds: '0', totalClaimed: '0', ...meta,
      });
    } else if (eventName === 'Claimed') {
      const account = address(args.account), recipient = address(args.recipient), paid = amount(args.amount);
      check(paid > 0n && recipient !== source, 'CLAIM_INVALID');
      const id = `${source}:${account}`, previous = await tx.get('claims', id);
      await tx.put('claims', id, { contract: source, beneficiary: account,
        totalClaimed: ((previous ? storedAmount(previous.totalClaimed) : 0n) + paid).toString(),
        recipient, lastAmount: paid.toString(), ...meta });
      if (collection) await tx.put('collections', source, { ...collection,
        totalClaimed: (storedAmount(collection.totalClaimed) + paid).toString(), ...meta });
      if(v3&&source===market)await liability(tx,market,meta,0n,-paid,0n,paid);
    } else if(source===market&&eventName.startsWith('Offer')){
      check(v3,'EVENT_UNKNOWN');const offerId=amount(args.offerId),id=offerId.toString();check(offerId>0n,'OFFER_INVALID');
      if(eventName==='OfferCreated'){
        const collectionAddress=address(args.collection),bidder=address(args.bidder),recipient=address(args.recipient),tokenId=amount(args.tokenId),unitPrice=amount(args.unitPrice),quantity=amount(args.quantity),expiry=amount(args.expiry),escrow=unitPrice*quantity;
        check(unitPrice>0n&&quantity>0n&&quantity<=20n&&(tokenId===0n||quantity===1n)&&expiry>block!.timestamp&&escrow<=UINT256_MAX&&recipient!==market&&recipient!==collectionAddress&&!await tx.get('offers',id),'OFFER_INVALID');
        if(offerId>1n)check(await tx.get('offers',(offerId-1n).toString()),'OFFER_SEQUENCE_INVALID');
        const registered=await collectionRecord(tx,collectionAddress);check(registered.opened===true,'OFFER_COLLECTION_CLOSED');
        if(tokenId>0n){const item=await itemRecord(tx,collectionAddress,tokenId);check(item.minted===true&&item.burned===false,'OFFER_ITEM_INVALID');}
        await tx.put('offers',id,{offerId:id,collection:collectionAddress,bidder,recipient,tokenId:tokenId.toString(),unitPrice:unitPrice.toString(),quantity:quantity.toString(),remaining:quantity.toString(),expiry:expiry.toString(),status:'active',...meta});
        await liability(tx,market,meta,escrow,0n,escrow);
      }else{
        const offer=await tx.get('offers',id);check(offer&&offer.status==='active','OFFER_INACTIVE');const remaining=storedAmount(offer.remaining),unitPrice=storedAmount(offer.unitPrice);check(remaining>0n,'OFFER_INACTIVE');
        if(eventName==='OfferCancelled'||eventName==='OfferExpired'){
          const quantity=amount(args.quantity),refund=amount(args.refund);check(address(args.bidder)===offer.bidder&&quantity===remaining&&refund===quantity*unitPrice,'OFFER_REFUND_INVALID');if(eventName==='OfferExpired'){address(args.caller);check(block!.timestamp>storedAmount(offer.expiry),'OFFER_NOT_EXPIRED');}
          await tx.put('offers',id,{...offer,remaining:'0',status:eventName==='OfferCancelled'?'cancelled':'expired',refund:refund.toString(),...meta});await liability(tx,market,meta,-refund,refund);
        }else{
          check(eventName==='OfferAccepted','EVENT_UNKNOWN');const collectionAddress=address(args.collection),tokenId=amount(args.tokenId),seller=address(args.seller),bidder=address(args.bidder),recipient=address(args.recipient),total=amount(args.totalPrice),fee=amount(args.platformFee),royalty=amount(args.royalty),proceeds=amount(args.sellerProceeds),replaced=amount(args.replacedListingId);
          check(block!.timestamp<=storedAmount(offer.expiry)&&collectionAddress===offer.collection&&bidder===offer.bidder&&recipient===offer.recipient&&seller!==bidder&&tokenId>0n&&(offer.tokenId==='0'||offer.tokenId===tokenId.toString())&&total===unitPrice&&fee===total*200n/10000n&&royalty<=total/10n&&fee+royalty+proceeds===total,'OFFER_SALE_INVALID');
          const item=await itemRecord(tx,collectionAddress,tokenId),transfer=item.lastTransfer as ProjectionValue|undefined,key=itemId(collectionAddress,tokenId);
          check(item.minted===true&&transferProofs.has(`${key}:${log.transactionHash.toLowerCase()}:${replaced>0n?market:seller}:${recipient}`),'OFFER_TRANSFER_MISSING');
          if(replaced>0n){
            const listing=await tx.get('listings',replaced.toString()),release=item.escrowRelease as ProjectionValue|undefined;
            check(listing&&listing.status==='active'&&listing.collection===collectionAddress&&listing.tokenId===tokenId.toString()&&listing.seller===seller&&item.activeListingId===replaced.toString()&&release&&release.listingId===replaced.toString()&&release.recipient===recipient&&release.transactionHash===log.transactionHash.toLowerCase(),'OFFER_LISTING_INVALID');
            await tx.put('listings',replaced.toString(),{...listing,status:'offer-filled',originalAsk:listing.totalPrice,totalPrice:total.toString(),platformFee:fee.toString(),royalty:royalty.toString(),sellerProceeds:proceeds.toString(),offerId:id,buyer:bidder,recipient,...meta});escrowReleases.delete(key);
          }else check(item.activeListingId===null,'OFFER_LISTING_INVALID');
          await tx.put('items',key,{...item,activeListingId:null,escrowRelease:null,...meta});
          await tx.put('offers',id,{...offer,remaining:(remaining-1n).toString(),status:remaining===1n?'filled':'active',...meta});
          await tx.put('offer-sales',activityId(log),{offerId:id,collection:collectionAddress,tokenId:tokenId.toString(),seller,bidder,recipient,totalPrice:total.toString(),platformFee:fee.toString(),royalty:royalty.toString(),sellerProceeds:proceeds.toString(),replacedListingId:replaced.toString(),...meta});await liability(tx,market,meta,-total,total);
        }
      }
    } else if (source === market) {
      const listingId = amount(args.listingId);
      check(listingId > 0n, 'LISTING_INVALID');
      const id = listingId.toString();
      if (eventName === 'Listed') {
        const collectionAddress = address(args.collection), seller = address(args.seller), tokenId = amount(args.tokenId), price = amount(args.totalPrice);
        check(tokenId > 0n && price > 0n && !await tx.get('listings', id), 'LISTING_INVALID');
        if (listingId > 1n) check(await tx.get('listings', (listingId - 1n).toString()), 'LISTING_SEQUENCE_INVALID');
        await collectionRecord(tx, collectionAddress);
        const item = await itemRecord(tx, collectionAddress, tokenId);
        const transfer = item.lastTransfer as ProjectionValue | undefined;
        check(item.owner === market && item.burned === false && item.activeListingId === null && transfer
          && transfer.from === seller && transfer.to === market && transfer.transactionHash === log.transactionHash.toLowerCase()
          && typeof transfer.logIndex === 'number' && transfer.logIndex < log.logIndex, 'ESCROW_TRANSFER_MISSING');
        await tx.put('listings', id, { listingId: id, collection: collectionAddress, tokenId: tokenId.toString(), seller,
          totalPrice: price.toString(), status: 'active', ...meta });
        await tx.put('items', itemId(collectionAddress, tokenId), { ...item, activeListingId: id, ...meta });
      } else {
        const listing = await tx.get('listings', id);
        check(listing && listing.status === 'active' && typeof listing.collection === 'string'
          && typeof listing.tokenId === 'string', 'LISTING_INACTIVE');
        const item = await itemRecord(tx, listing.collection, listing.tokenId);
        const release = item.escrowRelease as ProjectionValue | null;
        const recipient = address(args.recipient);
        check(recipient !== market && item.activeListingId === id && release && release.listingId === id
          && release.recipient === recipient && release.transactionHash === log.transactionHash.toLowerCase()
          && typeof release.logIndex === 'number' && release.logIndex < log.logIndex, 'ESCROW_TRANSFER_MISSING');
        if (eventName === 'Cancelled') {
          check(address(args.seller) === listing.seller, 'LISTING_SELLER_MISMATCH');
          await tx.put('listings', id, { ...listing, status: 'cancelled', recipient, ...meta });
        } else {
          check(eventName === 'Sold', 'EVENT_UNKNOWN');
          const buyer = address(args.buyer), total = amount(args.totalPrice), fee = amount(args.platformFee), royalty = amount(args.royalty), sellerProceeds = amount(args.sellerProceeds);
          check(buyer !== listing.seller && total === storedAmount(listing.totalPrice)
            && fee === total * 200n / 10_000n && royalty <= total / 10n
            && fee + royalty + sellerProceeds === total, 'SALE_ECONOMICS_INVALID');
          await tx.put('listings', id, { ...listing, status: 'sold', buyer, recipient,
            platformFee: fee.toString(), royalty: royalty.toString(), sellerProceeds: sellerProceeds.toString(), ...meta });
          if(v3)await liability(tx,market,meta,0n,total,total);
        }
        const key = itemId(listing.collection, listing.tokenId);
        await tx.put('items', key, { ...item, activeListingId: null, escrowRelease: null, ...meta });
        escrowReleases.delete(key);
      }
    } else {
      const record = await collectionRecord(tx, source);
      if (eventName === 'TermsConfigured') {
        check(record.opened === false, 'COLLECTION_FROZEN');
        await tx.put('collections', source, { ...record, configured: true, termsHash: hash(args.termsHash), ...meta });
      } else if (eventName === 'CollectionOpened') {
        const termsHash = hash(args.termsHash), contentHash = hash(args.contentHash);
        check(record.configured === true && record.opened === false && record.termsHash === termsHash
          && contentHash !== zeroHash, 'COLLECTION_OPEN_INVALID');
        await tx.put('collections', source, { ...record, opened: true, contentHash, ...meta });
      } else if (eventName === 'Transfer') {
        const from = address(args.from, false), to = address(args.to, false), tokenId = amount(args.tokenId);
        check(tokenId > 0n && (from !== zeroAddress || to !== zeroAddress), 'TRANSFER_INVALID');
        const key = itemId(source, tokenId), previous = await tx.get('items', key);
        transferProofs.add(`${key}:${log.transactionHash.toLowerCase()}:${from}:${to}`);
        const transfer = { from, to, transactionHash: log.transactionHash.toLowerCase(), logIndex: log.logIndex };
        if (from === zeroAddress) {
          check(!previous && to !== zeroAddress && to !== source && record.opened === true, 'MINT_TRANSFER_INVALID');
          await tx.put('items', key, { id: key, collection: source, tokenId: tokenId.toString(), owner: to, burned: false,
            minted: false, mintRecipient: to, mintTransactionHash: log.transactionHash.toLowerCase(), mintLogIndex: log.logIndex,
            activeListingId: null, escrowRelease: null, approved: null, transferCount: '1', lastTransfer: transfer, ...meta });
          mintedTransfers.add(key);
        } else {
          check(previous && previous.owner === from && previous.burned === false, 'TRANSFER_OWNER_MISMATCH');
          const escrowRelease = from === market && previous.activeListingId
            ? { listingId: previous.activeListingId, recipient: to, transactionHash: log.transactionHash.toLowerCase(), logIndex: log.logIndex }
            : previous.escrowRelease;
          if (from === market && previous.activeListingId) escrowReleases.add(key);
          await tx.put('items', key, { ...previous, owner: to === zeroAddress ? null : to, burned: to === zeroAddress,
            approved: null, escrowRelease, transferCount: (storedAmount(previous.transferCount) + 1n).toString(), lastTransfer: transfer, ...meta });
        }
      } else if (eventName === 'Minted') {
        const payer = address(args.payer), recipient = address(args.recipient), first = amount(args.firstTokenId), quantity = amount(args.quantity);
        const total = amount(args.totalPrice), fee = amount(args.platformFee), proceeds = amount(args.creatorProceeds);
        const before = storedAmount(record.totalMinted);
        check(record.opened === true && recipient !== source && quantity > 0n && quantity <= 20n
          && first === before + 1n && before + quantity <= UINT64_MAX && total % quantity === 0n
          && fee === total * 200n / 10_000n && fee + proceeds === total && typeof args.allowlistStage === 'boolean', 'MINT_ECONOMICS_INVALID');
        for (let serial = first; serial < first + quantity; serial++) {
          const item = await itemRecord(tx, source, serial), key = itemId(source, serial);
          check(item.minted === false && item.mintRecipient === recipient && item.mintTransactionHash === log.transactionHash.toLowerCase()
            && typeof item.mintLogIndex === 'number' && item.mintLogIndex < log.logIndex, 'MINT_TRANSFER_MISSING');
          await tx.put('items', key, { ...item, minted: true, payer, allowlistStage: args.allowlistStage, ...meta });
          mintedTransfers.delete(key);
        }
        await tx.put('collections', source, { ...record, totalMinted: (before + quantity).toString(),
          primaryTotalPrice: (storedAmount(record.primaryTotalPrice) + total).toString(),
          primaryPlatformFee: (storedAmount(record.primaryPlatformFee) + fee).toString(),
          primaryCreatorProceeds: (storedAmount(record.primaryCreatorProceeds) + proceeds).toString(), ...meta });
      } else if (eventName === 'Approval') {
        const owner = address(args.owner), approved = address(args.approved, false), tokenId = amount(args.tokenId);
        const item = await itemRecord(tx, source, tokenId);
        check(item.owner === owner && item.burned === false, 'APPROVAL_OWNER_MISMATCH');
        await tx.put('items', itemId(source, tokenId), { ...item, approved: approved === zeroAddress ? null : approved, ...meta });
      } else {
        check(eventName === 'ApprovalForAll' && typeof args.approved === 'boolean', 'EVENT_UNKNOWN');
        address(args.owner); address(args.operator);
      }
    }
    await tx.put('activity', activityId(log), { eventName, source, args: serializable(args),
      blockNumber: log.blockNumber.toString(), blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(), transactionIndex: log.transactionIndex, logIndex: log.logIndex,
      schemaVersion: manifest.schemaVersion, deploymentVersion: manifest.deploymentVersion, chainId: manifest.chainId });
  }
  check(mintedTransfers.size === 0, 'MINT_EVENT_MISSING');
  check(escrowReleases.size === 0, 'ESCROW_SETTLEMENT_MISSING');
}
