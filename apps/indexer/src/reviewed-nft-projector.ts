import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex } from 'viem';
import { REVIEWED_NFT_REGISTRY_ABI, REVIEWED_NFT_MARKETPLACE_ABI } from '../../../packages/evm/src/reviewed-nft-abi';
import type { ReviewedNftManifest } from '../../../packages/evm/src/reviewed-nft';
import { reviewedCollectionSchema, reviewedItemSchema, reviewedListingSchema, reviewedClaimSchema, reviewedActivitySchema, type ReviewedCollection, type ReviewedItem, type ReviewedListing } from '../../web/lib/reviewed-nft-data';
import { IndexerError, type Block, type IndexerTransaction, type RawLog } from './types';

const registryEvents = REVIEWED_NFT_REGISTRY_ABI.filter(value => value.type === 'event');
const marketEvents = REVIEWED_NFT_MARKETPLACE_ABI.filter(value => value.type === 'event');
export const reviewedTransferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const transferTopic = encodeEventTopics({ abi: reviewedTransferEvent, eventName: 'Transfer' })[0];
const MAX = 2n ** 256n - 1n;
const fail = (code = 'REVIEWED_PROJECTION_INVALID'): never => { throw new IndexerError(code); };
function check(value: unknown, code?: string): asserts value { if (!value) fail(code); }
function address(value: unknown, allowZero = false): Address {
  check(typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value));
  const result = value.toLowerCase() as Address; check(allowZero || result !== zeroAddress); return result;
}
function uint(value: unknown, positive = false): bigint { check(typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= MAX); return value; }
function hash(value: unknown): Hex { check(typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value) && value.toLowerCase() !== zeroHash); return value.toLowerCase() as Hex; }
function decimal(value: unknown): bigint { check(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) <= MAX); return BigInt(value); }
function position(log: RawLog) { return { lastBlockNumber: log.blockNumber.toString(), lastBlockHash: hash(log.blockHash), lastTransactionHash: hash(log.transactionHash), lastLogIndex: log.logIndex }; }
function decode(abi: readonly AbiEvent[], log: RawLog) {
  try {
    const decoded = decodeEventLog({ abi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data, strict: true });
    const event = abi.find(value => value.name === decoded.eventName); check(event);
    const args = decoded.args as Record<string, unknown>;
    const topics = encodeEventTopics({ abi: [event], eventName: event.name, args });
    const fields = event.inputs.filter(value => !value.indexed), data = encodeAbiParameters(fields, fields.map(value => args[value.name!]));
    check(data.toLowerCase() === log.data.toLowerCase() && topics.length === log.topics.length && topics.every((value, i) => typeof value === 'string' && value.toLowerCase() === log.topics[i]?.toLowerCase()), 'REVIEWED_EVENT_ENCODING_INVALID');
    return { eventName: decoded.eventName as string, args };
  } catch (error) { if (error instanceof IndexerError) throw error; return fail('REVIEWED_EVENT_ENCODING_INVALID'); }
}
function ordered(input: readonly RawLog[], block?: Block): RawLog[] {
  check(input.length <= 10_000, 'SOURCE_LIMIT');
  const logs = [...input].sort((a, b) => a.logIndex - b.logIndex), positions = new Set<number>(), txIndexes = new Map<number, Hex>(), txHashes = new Map<Hex, number>();
  let lastTx = -1;
  for (const log of logs) {
    address(log.address); hash(log.transactionHash); hash(log.blockHash);
    check(typeof log.blockNumber === 'bigint' && log.blockNumber >= 0n && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 && log.logIndex <= 2_147_483_647
      && Number.isSafeInteger(log.transactionIndex) && log.transactionIndex >= lastTx && log.transactionIndex <= 2_147_483_647
      && /^0x(?:[\da-fA-F]{2})*$/.test(log.data) && log.data.length <= 131_074 && log.topics.length <= 4 && log.topics.every(topic => /^0x[\da-fA-F]{64}$/.test(topic)), 'REVIEWED_EVENT_POSITION_INVALID');
    check(!positions.has(log.logIndex) && (!block || log.blockNumber === block.number && log.blockHash.toLowerCase() === block.hash), 'REVIEWED_EVENT_POSITION_INVALID');
    if (logs[0]) check(log.blockNumber === logs[0].blockNumber && log.blockHash.toLowerCase() === logs[0].blockHash.toLowerCase(), 'REVIEWED_EVENT_POSITION_INVALID');
    const txHash = hash(log.transactionHash), knownHash = txIndexes.get(log.transactionIndex), knownIndex = txHashes.get(txHash);
    check((knownHash === undefined || knownHash === txHash) && (knownIndex === undefined || knownIndex === log.transactionIndex), 'REVIEWED_EVENT_POSITION_INVALID');
    positions.add(log.logIndex); txIndexes.set(log.transactionIndex, txHash); txHashes.set(txHash, log.transactionIndex); lastTx = log.transactionIndex;
  }
  return logs;
}
/** Only registry admission events can expand the address filter, including same-block admissions. */
export function discoverReviewedNftCollections(manifest: ReviewedNftManifest, logs: readonly RawLog[]): Address[] {
  const found = new Set<Address>();
  for (const log of ordered(logs)) {
    if (address(log.address) !== manifest.registry.address) continue;
    const event = decode(registryEvents, log);
    if (event.eventName === 'ReviewAdmitted') {
      const collection = address(event.args.collection); check(![manifest.registry.address, manifest.marketplace.address, manifest.oneshotFactory.address].includes(collection));
      uint(event.args.version, true); hash(event.args.runtimeCodeHash); hash(event.args.permitHash); uint(event.args.deadline);
      found.add(collection);
    }
  }
  return [...found];
}

/** Independent sparse, observation-only projection. No native mint/supply/metadata assumptions. */
export async function projectReviewedNftLogs(tx: IndexerTransaction, manifest: ReviewedNftManifest, input: readonly RawLog[], block: Block): Promise<void> {
  const logs = ordered(input, block), transfers: { log: RawLog; collection: Address; tokenId: string; from: Address; to: Address; used: boolean }[] = [];
  const firstAdmissions = new Map<Address, number>();
  for (const log of logs) if (address(log.address) === manifest.registry.address) {
    const event = decode(registryEvents, log);
    if (event.eventName === 'ReviewAdmitted' && !firstAdmissions.has(address(event.args.collection))) firstAdmissions.set(address(event.args.collection), log.logIndex);
  }
  const touchedItems = new Set<string>(), market = manifest.marketplace.address, accountingId = `${market}:accounting`;
  const itemKey = (collection: Address, tokenId: string) => `${collection}:${tokenId}`;
  const listingKey = (id: string) => `${market}:${id}`;
  async function collectionAt(id: Address): Promise<ReviewedCollection | null> {
    const raw = await tx.get('collections', id); if (raw === null) return null;
    const parsed = reviewedCollectionSchema.safeParse(raw); check(parsed.success && parsed.data.address === id); return parsed.data;
  }
  async function itemAt(collection: Address, tokenId: string): Promise<ReviewedItem | null> {
    const raw = await tx.get('items', itemKey(collection, tokenId)); if (raw === null) return null;
    const parsed = reviewedItemSchema.safeParse(raw); check(parsed.success && parsed.data.collection === collection && parsed.data.tokenId === tokenId); return parsed.data;
  }
  async function listingAt(id: string): Promise<ReviewedListing> {
    const parsed = reviewedListingSchema.safeParse(await tx.get('listings', listingKey(id)));
    check(parsed.success && parsed.data.marketplace === market && parsed.data.listingId === id); return parsed.data;
  }
  async function accounting(delta: bigint) {
    const prior = await tx.get('claims', accountingId);
    check(prior === null || prior.schemaVersion === 1 && prior.kind === 'reviewed-market-accounting' && typeof prior.marketDeployed === 'boolean');
    const pending = decimal(prior?.pendingRaw ?? '0') + delta; check(pending >= 0n && pending <= MAX, 'REVIEWED_PENDING_MISMATCH');
    await tx.put('claims', accountingId, { schemaVersion: 1, kind: 'reviewed-market-accounting', pendingRaw: pending.toString(), marketDeployed: prior?.marketDeployed ?? false, nextListingIdRaw: prior?.nextListingIdRaw ?? '1' });
  }
  async function credit(account: Address, amount: bigint, log: RawLog, claim = false) {
    if (amount === 0n) return;
    check(account !== zeroAddress);
    const key = `${market}:${account}`, old = await tx.get('claims', key), parsed = old === null ? null : reviewedClaimSchema.safeParse(old);
    check(parsed === null || parsed.success && parsed.data.marketplace === market && parsed.data.account === account);
    const pending = decimal(old?.pendingRaw ?? '0') + (claim ? -amount : amount), claimed = decimal(old?.claimedRaw ?? '0') + (claim ? amount : 0n);
    check(pending >= 0n && pending <= MAX && claimed <= MAX, 'REVIEWED_PENDING_MISMATCH');
    await tx.put('claims', key, reviewedClaimSchema.parse({ schemaVersion: 1, kind: 'reviewed-market-claim', marketplace: market, account, pendingRaw: pending.toString(), claimedRaw: claimed.toString(), ...position(log) }));
  }
  function matchTransfer(collection: Address, tokenId: string, from: Address, to: Address, log: RawLog) {
    const found = [...transfers].reverse().find(value => !value.used && value.collection === collection && value.tokenId === tokenId && value.from === from && value.to === to
      && value.log.transactionHash.toLowerCase() === log.transactionHash.toLowerCase() && value.log.logIndex < log.logIndex);
    check(found, 'REVIEWED_TRANSFER_EVIDENCE_MISSING'); found.used = true;
  }
  async function activity(log: RawLog, eventName: string, collection: Address | null, args: Record<string, unknown>) {
    const normalized = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value]));
    const value = reviewedActivitySchema.parse({ id: `${hash(log.transactionHash)}:${log.logIndex}`, eventName, source: address(log.address), collection,
      transactionHash: hash(log.transactionHash), blockNumber: block.number.toString(), blockHash: hash(block.hash), logIndex: log.logIndex, timestamp: new Date(Number(block.timestamp) * 1000).toISOString(), args: normalized });
    check(await tx.get('activity', value.id) === null, 'REVIEWED_EVENT_DUPLICATE'); await tx.put('activity', value.id, value);
  }
  for (const log of logs) {
    const source = address(log.address);
    if (source === manifest.registry.address) {
      const { eventName, args } = decode(registryEvents, log), collection = address(args.collection), prior = await collectionAt(collection);
      check(![market, manifest.registry.address, manifest.oneshotFactory.address].includes(collection));
      if (eventName === 'ReviewAdmitted') {
        const version = uint(args.version, true), codeHash = hash(args.runtimeCodeHash); hash(args.permitHash);
        check(uint(args.deadline) >= block.timestamp && version === BigInt(prior?.reviewVersion ?? '0') + 1n, 'REVIEWED_ADMISSION_SEQUENCE_INVALID');
        await tx.put('collections', collection, reviewedCollectionSchema.parse({ schemaVersion: 1, kind: 'reviewed-external-erc721', address: collection, reviewVersion: version.toString(), runtimeCodeHash: codeHash,
          active: true, observedFromBlock: prior?.observedFromBlock ?? block.number.toString(), observedFromLogIndex: prior?.observedFromLogIndex ?? log.logIndex, ...position(log) }));
      } else if (eventName === 'ReviewRevoked') {
        check(prior?.active && uint(args.previousVersion, true).toString() === prior.reviewVersion && uint(args.version, true) === BigInt(prior.reviewVersion) + 1n, 'REVIEWED_ADMISSION_SEQUENCE_INVALID');
        await tx.put('collections', collection, reviewedCollectionSchema.parse({ ...prior, active: false, reviewVersion: uint(args.version).toString(), ...position(log) }));
      } else fail('REVIEWED_EVENT_UNKNOWN');
      await activity(log, eventName, collection, args); continue;
    }
    if (source === market) {
      const { eventName, args } = decode(marketEvents, log);
      if (eventName === 'Claimed') {
        const account = address(args.account), recipient = address(args.recipient), amount = uint(args.amount, true); check(recipient !== market);
        const prior = await tx.get('claims', `${market}:${account}`); check(decimal(prior?.pendingRaw ?? '0') === amount, 'REVIEWED_PENDING_MISMATCH');
        await credit(account, amount, log, true); await accounting(-amount); await activity(log, eventName, null, args); continue;
      }
      const id = uint(args.listingId, true).toString();
      if (eventName === 'Listed') {
        const collection = address(args.collection), tokenId = uint(args.tokenId).toString(), seller = address(args.seller), admitted = await collectionAt(collection), item = await itemAt(collection, tokenId);
        const price = uint(args.totalPrice, true), royalty = uint(args.royaltyAmount), receiver = address(args.royaltyRecipient, true);
        check(admitted?.active && admitted.reviewVersion === uint(args.reviewVersion, true).toString() && admitted.runtimeCodeHash === hash(args.runtimeCodeHash), 'REVIEWED_LISTING_ADMISSION_MISMATCH');
        check(item && item.owner === market && !item.burned && item.activeListingId === null && seller !== market && royalty <= price / 10n && (royalty === 0n || receiver !== zeroAddress && receiver !== market), 'REVIEWED_LISTING_INVALID');
        check(await tx.get('listings', listingKey(id)) === null, 'REVIEWED_LISTING_DUPLICATE'); matchTransfer(collection, tokenId, seller, market, log);
        const aggregate = await tx.get('claims', accountingId); check(decimal(aggregate?.nextListingIdRaw ?? '1').toString() === id && BigInt(id) < MAX, 'REVIEWED_LISTING_SEQUENCE_INVALID');
        await accounting(0n); await tx.put('claims', accountingId, { ...(await tx.get('claims', accountingId))!, nextListingIdRaw: (BigInt(id) + 1n).toString() });
        const value = reviewedListingSchema.parse({ schemaVersion: 1, kind: 'reviewed-market-listing', marketplace: market, listingId: id, collection, tokenId, seller, totalPriceRaw: price.toString(), royaltyRecipient: receiver,
          royaltyRaw: royalty.toString(), reviewVersion: admitted.reviewVersion, runtimeCodeHash: admitted.runtimeCodeHash, intentHash: hash(args.intentHash), status: 'active', buyer: null, recipient: null, platformFeeRaw: null, sellerProceedsRaw: null, ...position(log) });
        await tx.put('listings', listingKey(id), value); await tx.put('items', itemKey(collection, tokenId), { ...item, activeListingId: id, ...position(log) }); touchedItems.add(itemKey(collection, tokenId));
        await activity(log, eventName, collection, args); continue;
      }
      const listing = await listingAt(id), item = await itemAt(listing.collection, listing.tokenId);
      check(listing.status === 'active' && item?.activeListingId === id, 'REVIEWED_LISTING_INACTIVE');
      const recipient = address(args.recipient); check(recipient !== market); matchTransfer(listing.collection, listing.tokenId, market, recipient, log);
      if (eventName === 'Cancelled') {
        check(address(args.seller) === listing.seller, 'REVIEWED_LISTING_INVALID');
        await tx.put('listings', listingKey(id), reviewedListingSchema.parse({ ...listing, status: 'cancelled', recipient, ...position(log) }));
      } else if (eventName === 'Sold') {
        const admission = await collectionAt(listing.collection), buyer = address(args.buyer), price = uint(args.totalPrice, true), fee = uint(args.platformFee), royalty = uint(args.royaltyAmount), proceeds = uint(args.sellerProceeds), receiver = address(args.royaltyRecipient, true);
        check(admission?.active && admission.reviewVersion === listing.reviewVersion && admission.runtimeCodeHash === listing.runtimeCodeHash && buyer !== listing.seller
          && price.toString() === listing.totalPriceRaw && royalty.toString() === listing.royaltyRaw && receiver === listing.royaltyRecipient
          && fee === price * 200n / 10_000n && price === fee + royalty + proceeds, 'REVIEWED_SETTLEMENT_INVALID');
        await tx.put('listings', listingKey(id), reviewedListingSchema.parse({ ...listing, status: 'sold', buyer, recipient, platformFeeRaw: fee.toString(), sellerProceedsRaw: proceeds.toString(), ...position(log) }));
        await credit(manifest.treasury, fee, log); await credit(receiver, royalty, log); await credit(listing.seller, proceeds, log); await accounting(price);
      } else fail('REVIEWED_EVENT_UNKNOWN');
      await tx.put('items', itemKey(listing.collection, listing.tokenId), { ...item, activeListingId: null, ...position(log) }); touchedItems.add(itemKey(listing.collection, listing.tokenId));
      await activity(log, eventName, listing.collection, args); continue;
    }
    const admitted = await collectionAt(source);
    if (!admitted && firstAdmissions.has(source) && log.logIndex < firstAdmissions.get(source)!) continue;
    check(admitted, 'REVIEWED_LOG_SOURCE_UNKNOWN');
    // Fetching an admission block may include earlier collection logs. Do not
    // pretend those events are a complete pre-admission history.
    if (block.number.toString() === admitted.observedFromBlock && log.logIndex < admitted.observedFromLogIndex) continue;
    if (log.topics[0]?.toLowerCase() !== transferTopic?.toLowerCase()) continue;
    const { args } = decode(reviewedTransferEvent, log), from = address(args.from, true), to = address(args.to, true), tokenId = uint(args.tokenId).toString();
    check(from !== zeroAddress || to !== zeroAddress, 'REVIEWED_TRANSFER_INVALID');
    const prior = await itemAt(source, tokenId); check(!prior || prior.owner === from, 'REVIEWED_OWNERSHIP_DISCONTINUITY');
    const key = itemKey(source, tokenId);
    await tx.put('items', key, reviewedItemSchema.parse({ schemaVersion: 1, kind: 'reviewed-external-item', collection: source, tokenId, owner: to, burned: to === zeroAddress, activeListingId: prior?.activeListingId ?? null,
      firstObservedBlockNumber: prior?.firstObservedBlockNumber ?? block.number.toString(), firstObservedLogIndex: prior?.firstObservedLogIndex ?? log.logIndex, ...position(log) }));
    transfers.push({ log, collection: source, tokenId, from, to, used: false }); touchedItems.add(key); await activity(log, 'Transfer', source, args);
  }
  // Escrow exits must be explained by a sale/cancellation. Recipient callbacks
  // may forward again before Sold/Cancelled, so final owner need not be recipient.
  for (const key of touchedItems) {
    const item = reviewedItemSchema.parse(await tx.get('items', key));
    check(item.activeListingId === null || item.owner === market && !item.burned, 'REVIEWED_ESCROW_MISMATCH');
  }
}
