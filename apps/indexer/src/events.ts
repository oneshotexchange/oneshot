import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex } from 'viem';
import { IndexerError, type IndexerTransaction, type Manifest, type ProjectionValue, type RawLog } from './types';

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

/**
 * Project a complete canonical log batch. Call inside the store's block transaction:
 * failures must roll back all projections, raw logs and their checkpoint together.
 * Amounts are decimal strings. Terms events commit hashes, not undisclosed terms.
 */
export async function projectLogs(tx: IndexerTransaction, manifest: Manifest, logs: readonly RawLog[]): Promise<void> {
  const factory = address(manifest.factory.address), market = address(manifest.marketplace.address);
  const marketEvents = manifest.deploymentVersion === 'oneshot-nft-v2' ? guardedMarketplaceEvents : marketplaceEvents;
  const mintedTransfers = new Set<string>(), escrowReleases = new Set<string>();
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
