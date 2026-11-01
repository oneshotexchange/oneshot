import { concatHex, encodeAbiParameters, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { parseAssetAmount } from './economics';

const stageComponents = [
  { name: 'start', type: 'uint64' },
  { name: 'end', type: 'uint64' },
  { name: 'walletLimit', type: 'uint64' },
  { name: 'price', type: 'uint256' },
] as const;

/** Solidity OneshotCollection.Terms, including its exact field order and widths. */
export const NFT_TERMS_PARAMETER = {
  type: 'tuple', name: '', components: [
    { name: 'maxSupply', type: 'uint64' },
    { name: 'royaltyBps', type: 'uint16' },
    { name: 'allowlistRoot', type: 'bytes32' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'metadataBaseURI', type: 'string' },
    { name: 'collectionURI', type: 'string' },
    { name: 'allowlist', type: 'tuple', components: stageComponents },
    { name: 'publicMint', type: 'tuple', components: stageComponents },
  ],
} as const;

/** Reviewed against contracts-evm/src/OneshotNFTFactory.sol. */
export const NFT_FACTORY_ABI = parseAbi([
  'constructor(address treasury_)',
  'function treasury() view returns (address)',
  'function isCollection(address) view returns (bool)',
  'function collections(uint256) view returns (address)',
  'function collectionCount() view returns (uint256)',
  'function createCollection(string name, string symbol) returns (address collection)',
  'event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol)',
  'error InvalidTreasury()',
]);

/** Reviewed against OneshotCollection.sol and its ERC721/ERC2981 interfaces. */
export const NFT_COLLECTION_ABI = [
  { type: 'function', name: 'configure', stateMutability: 'nonpayable', inputs: [{ ...NFT_TERMS_PARAMETER, name: 'terms_' }], outputs: [] },
  { type: 'function', name: 'terms', stateMutability: 'view', inputs: [], outputs: [NFT_TERMS_PARAMETER] },
  ...parseAbi([
    'constructor(string name_, string symbol_, address creator_, address treasury_)',
    'function open()',
    'function mint(uint256 quantity, address recipient, uint256 maximumTotalPrice, bytes32[] proof) payable',
    'function claimTo(address recipient)',
    'function allowlistLeaf(address wallet) view returns (bytes32)',
    'function creator() view returns (address)',
    'function treasury() view returns (address)',
    'function factory() view returns (address)',
    'function configured() view returns (bool)',
    'function opened() view returns (bool)',
    'function totalMinted() view returns (uint256)',
    'function totalPending() view returns (uint256)',
    'function pending(address) view returns (uint256)',
    'function allowlistMinted(address) view returns (uint256)',
    'function publicMinted(address) view returns (uint256)',
    'function MAX_BATCH() view returns (uint256)',
    'function PLATFORM_FEE_BPS() view returns (uint256)',
    'function ALLOWLIST_DOMAIN() view returns (bytes32)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function contractURI() view returns (string)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function balanceOf(address owner) view returns (uint256)',
    'function getApproved(uint256 tokenId) view returns (address)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function approve(address to, uint256 tokenId)',
    'function setApprovalForAll(address operator, bool approved)',
    'function transferFrom(address from, address to, uint256 tokenId)',
    'function safeTransferFrom(address from, address to, uint256 tokenId)',
    'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
    'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event TermsConfigured(bytes32 indexed termsHash)',
    'event CollectionOpened(bytes32 indexed termsHash, bytes32 indexed contentHash)',
    'event Minted(address indexed payer, address indexed recipient, uint256 firstTokenId, uint256 quantity, uint256 totalPrice, uint256 platformFee, uint256 creatorProceeds, bool allowlistStage)',
    'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
    'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
    'error OnlyCreator()', 'error Frozen()', 'error InvalidTerms()', 'error NotOpen()',
    'error NoActiveStage()', 'error InvalidProof()', 'error InvalidQuantity()', 'error WalletLimit()',
    'error SupplyLimit()', 'error PriceLimit()', 'error IncorrectPayment()', 'error InvalidRecipient()',
    'error NothingToClaim()', 'error PaymentFailed()', 'error ReentrancyGuardReentrantCall()',
    'error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)',
    'error ERC721InsufficientApproval(address operator, uint256 tokenId)',
    'error ERC721InvalidApprover(address approver)', 'error ERC721InvalidOperator(address operator)',
    'error ERC721InvalidOwner(address owner)', 'error ERC721InvalidReceiver(address receiver)',
    'error ERC721InvalidSender(address sender)', 'error ERC721NonexistentToken(uint256 tokenId)',
    'error ERC2981InvalidDefaultRoyalty(uint256 numerator, uint256 denominator)',
    'error ERC2981InvalidDefaultRoyaltyReceiver(address receiver)',
    'error ERC2981InvalidTokenRoyalty(uint256 tokenId, uint256 numerator, uint256 denominator)',
    'error ERC2981InvalidTokenRoyaltyReceiver(uint256 tokenId, address receiver)',
  ]),
] as const;

/** Reviewed against contracts-evm/src/OneshotMarketplace.sol. */
export const NFT_MARKETPLACE_ABI = parseAbi([
  'constructor(address factory_)',
  'function factory() view returns (address)',
  'function treasury() view returns (address)',
  'function PLATFORM_FEE_BPS() view returns (uint256)',
  'function nextListingId() view returns (uint256)',
  'function totalPending() view returns (uint256)',
  'function pending(address) view returns (uint256)',
  'function listings(uint256) view returns (address collection, address seller, uint256 tokenId, uint256 price, bool active)',
  'function activeListing(address, uint256) view returns (uint256)',
  'function list(address collection, uint256 tokenId, uint256 totalPrice) returns (uint256 listingId)',
  'function buy(uint256 listingId, uint256 maximumTotalPrice, address recipient) payable',
  'function cancel(uint256 listingId)',
  'function cancelTo(uint256 listingId, address recipient)',
  'function claimTo(address recipient)',
  'function onERC721Received(address operator, address from, uint256 tokenId, bytes data) view returns (bytes4)',
  'event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 totalPrice)',
  'event Cancelled(uint256 indexed listingId, address indexed seller, address indexed recipient)',
  'event Sold(uint256 indexed listingId, address indexed buyer, address indexed recipient, uint256 totalPrice, uint256 platformFee, uint256 royalty, uint256 sellerProceeds)',
  'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
  'error InvalidFactory()', 'error UnknownCollection()', 'error InvalidPrice()', 'error NotOwner()',
  'error AlreadyListed()', 'error InactiveListing()', 'error NotSeller()', 'error SelfPurchase()',
  'error PriceLimit()', 'error IncorrectPayment()', 'error InvalidRecipient()', 'error UnexpectedTransfer()',
  'error InvalidRoyalty()', 'error NothingToClaim()', 'error PaymentFailed()', 'error ReentrancyGuardReentrantCall()',
]);

export const NFT_ALLOWLIST_DOMAIN = keccak256(stringToHex('ONESHOT_ALLOWLIST_V1'));
const UINT64_MAX = (1n << 64n) - 1n;
const encoder = new TextEncoder();

export type NftLaunchDraft = {
  status: string;
  name: string;
  symbol?: string;
  maxSupply: number;
  royaltyBps: number;
  publicPrice: string;
  allowlistPrice: string;
  perWalletLimit: number;
  publicStart?: string;
  publicEnd?: string;
  allowlistStart?: string;
  allowlistEnd?: string;
  allowlistAddresses: readonly string[];
  creatorWallet?: string;
  snapshot?: { manifestHash: string; contentHash: string; baseUri: string; collectionUri: string; itemCount: number };
};
export type NftTermsContext = { chainId: number; nativeDecimals: number | null; collection: Address; nowSeconds: bigint };
export type NftStage = { start: bigint; end: bigint; walletLimit: bigint; price: bigint };
export type NftTerms = {
  maxSupply: bigint;
  royaltyBps: number;
  allowlistRoot: Hex;
  contentHash: Hex;
  metadataBaseURI: string;
  collectionURI: string;
  allowlist: NftStage;
  publicMint: NftStage;
};
export type PreparedNftTerms = {
  terms: NftTerms;
  termsHash: Hex;
  allowlist: { root: Hex; addresses: Address[]; proofs: Record<string, Hex[]> };
  summary: { name: string; symbol: string; creator: Address; chainId: number; collection: Address; nativeDecimals: number; publicPriceRaw: bigint; allowlistPriceRaw: bigint; firstStart: bigint };
};

export class NftLaunchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NftLaunchError'; }
}
function fail(code: string, message: string): never { throw new NftLaunchError(code, message); }
function address(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value) || value.toLowerCase() === zeroAddress) fail('INVALID_ADDRESS', `${field} must be a nonzero EVM address.`);
  return value.toLowerCase() as Address;
}
function uint64(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value < 1 || BigInt(value) > UINT64_MAX) fail('INVALID_INTEGER', `${field} must be a positive, safe uint64 integer.`);
  return BigInt(value);
}
function label(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || encoder.encode(value).length > maximumBytes || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_IDENTITY', `${field} must contain 1–${maximumBytes} UTF-8 bytes without surrounding whitespace or control characters.`);
  return value;
}
function uri(value: unknown, field: string, base: boolean): string {
  if (typeof value !== 'string' || encoder.encode(value).length > 2048 || /[\x00-\x20\x7f]/.test(value) || (base && !value.endsWith('/'))) fail('INVALID_SNAPSHOT', `${field} is not a valid committed URI.`);
  try {
    const parsed = new URL(value);
    if (!['https:', 'ipfs:', 'ar:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error();
  } catch { fail('INVALID_SNAPSHOT', `${field} requires an absolute HTTPS, IPFS, or Arweave URI without credentials, query, or fragment.`); }
  return value;
}
function timestamp(value: unknown, field: string): bigint {
  if (typeof value !== 'string') fail('INVALID_SCHEDULE', `${field} requires an explicit ISO timestamp.`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || (parts[7] && !/^0+$/.test(parts[7]))) fail('INVALID_SCHEDULE', `${field} must use whole seconds and an explicit ISO timezone.`);
  const milliseconds = Date.parse(value);
  const zone = parts[8]!;
  const zoneHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1000 !== 0 || zoneHours > 23 || zoneMinutes > 59) fail('INVALID_SCHEDULE', `${field} is outside the supported whole-second timestamp range.`);
  // Date.parse normalizes some impossible calendar dates; reject those instead of moving a stage.
  const offset = (zoneHours * 60 + zoneMinutes) * 60_000 * (zone.startsWith('-') ? -1 : 1);
  const canonical = new Date(milliseconds + offset).toISOString().slice(0, 19);
  if (canonical !== value.slice(0, 19)) fail('INVALID_SCHEDULE', `${field} is not a valid calendar timestamp.`);
  const seconds = BigInt(milliseconds / 1000);
  if (seconds > UINT64_MAX) fail('INVALID_SCHEDULE', `${field} exceeds uint64.`);
  return seconds;
}
function price(value: unknown, decimals: number, field: string): bigint {
  if (typeof value !== 'string' || value.length > 160 || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) fail('INVALID_PRICE', `${field} requires an unsigned decimal amount without exponents.`);
  try { return parseAssetAmount(value, decimals); }
  catch { fail('INVALID_PRICE', `${field} must fit uint256 and the verified ${decimals} decimal places; excess digits are never rounded.`); }
}

/** Matches allowlistLeaf(wallet), including its inner ABI encoding and outer raw-bytes hash. */
export function nftAllowlistLeaf(chainId: number, collection: Address, wallet: Address): Hex {
  if (!Number.isSafeInteger(chainId) || chainId < 1) fail('INVALID_CHAIN', 'A verified positive chain ID is required.');
  const inner = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }],
    [NFT_ALLOWLIST_DOMAIN, BigInt(chainId), address(collection, 'Collection'), address(wallet, 'Allowlist wallet')],
  ));
  return keccak256(inner);
}
function hashPair(a: Hex, b: Hex): Hex { return keccak256(concatHex(a < b ? [a, b] : [b, a])); }
function allowlistTree(values: readonly string[], context: NftTermsContext): PreparedNftTerms['allowlist'] {
  if (!Array.isArray(values) || values.length > 10_000) fail('INVALID_ALLOWLIST', 'Allowlist must be an array of at most 10,000 addresses.');
  const addresses = [...new Set(values.map(value => address(value, 'Allowlist wallet')))].sort();
  if (!addresses.length) return { root: zeroHash, addresses, proofs: {} };
  // Leaf order is deterministic; odd nodes are promoted unchanged. Proof pairs are commutative,
  // as in OpenZeppelin MerkleProof.verifyCalldata, rather than position-dependent hashes.
  const levels: Hex[][] = [addresses.map(wallet => nftAllowlistLeaf(context.chainId, context.collection, wallet))];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!; const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    levels.push(next);
  }
  const proofs: Record<string, Hex[]> = {};
  addresses.forEach((wallet, index) => {
    const proof: Hex[] = []; let position = index;
    for (const level of levels.slice(0, -1)) {
      const sibling = position % 2 === 0 ? position + 1 : position - 1;
      if (sibling < level.length) proof.push(level[sibling]!);
      position = Math.floor(position / 2);
    }
    proofs[wallet] = proof;
  });
  return { root: levels.at(-1)![0]!, addresses, proofs };
}

/** Pure draft-to-contract conversion. Snapshot bytes/availability are verified by the API before
 * this boundary; here we check their declared commitment/count and every frozen contract field.
 * The returned bigints intentionally retain precision; transport code must serialize them explicitly.
 */
export function prepareNftTerms(draft: NftLaunchDraft, context: NftTermsContext): PreparedNftTerms {
  if (draft.status !== 'prepared') fail('DRAFT_NOT_PREPARED', 'Prepare the metadata snapshot before reviewing collection terms.');
  const { nativeDecimals, chainId, nowSeconds } = context;
  if (nativeDecimals === null) fail('UNKNOWN_PRECISION', 'Native asset precision is not verified.');
  if (!Number.isInteger(nativeDecimals) || nativeDecimals < 0 || nativeDecimals > 38) fail('UNKNOWN_PRECISION', 'Native asset precision must be verified between 0 and 38 decimals.');
  if (!Number.isSafeInteger(chainId) || chainId < 1) fail('INVALID_CHAIN', 'A verified positive chain ID is required.');
  if (typeof nowSeconds !== 'bigint' || nowSeconds < 0n || nowSeconds > UINT64_MAX) fail('INVALID_SCHEDULE', 'Current chain time must be a uint64 whole-second timestamp.');
  const collection = address(context.collection, 'Collection');
  const creator = address(draft.creatorWallet, 'Creator wallet');
  const name = label(draft.name, 'Collection name', 100);
  const symbol = label(draft.symbol, 'Collection symbol', 20);
  const maxSupply = uint64(draft.maxSupply, 'Supply');
  const walletLimit = uint64(draft.perWalletLimit, 'Per-wallet limit');
  if (walletLimit > maxSupply) fail('INVALID_INTEGER', 'Per-wallet limit cannot exceed supply.');
  if (!Number.isSafeInteger(draft.royaltyBps) || draft.royaltyBps < 0 || draft.royaltyBps > 1000) fail('INVALID_ROYALTY', 'Creator royalties must be between 0 and 1,000 basis points.');
  const snapshot = draft.snapshot;
  if (!snapshot || !/^[\da-f]{64}$/.test(snapshot.manifestHash) || snapshot.contentHash !== `0x${snapshot.manifestHash}` || snapshot.contentHash === zeroHash || snapshot.itemCount !== draft.maxSupply) fail('INVALID_SNAPSHOT', 'Prepared metadata count or content commitment does not match the draft.');
  const metadataBaseURI = uri(snapshot.baseUri, 'Metadata base URI', true);
  const collectionURI = uri(snapshot.collectionUri, 'Collection URI', false);
  const allowlist = allowlistTree(draft.allowlistAddresses, { ...context, collection });
  const publicMint: NftStage = { start: timestamp(draft.publicStart, 'Public mint start'), end: timestamp(draft.publicEnd, 'Public mint end'), walletLimit, price: price(draft.publicPrice, nativeDecimals, 'Public mint price') };
  if (publicMint.start >= publicMint.end) fail('INVALID_SCHEDULE', 'Public mint must end after its start.');
  let allowlistStage: NftStage = { start: 0n, end: 0n, walletLimit: 0n, price: 0n };
  if (allowlist.addresses.length) {
    allowlistStage = { start: timestamp(draft.allowlistStart, 'Allowlist start'), end: timestamp(draft.allowlistEnd, 'Allowlist end'), walletLimit, price: price(draft.allowlistPrice, nativeDecimals, 'Allowlist price') };
    if (allowlistStage.start >= allowlistStage.end || allowlistStage.end > publicMint.start) fail('INVALID_SCHEDULE', 'Allowlist must end after its start and at or before public mint starts.');
  } else if (draft.allowlistStart || draft.allowlistEnd) fail('INVALID_ALLOWLIST', 'An allowlist schedule requires at least one allowlisted wallet.');
  const firstStart = allowlist.addresses.length ? allowlistStage.start : publicMint.start;
  if (firstStart < nowSeconds) fail('SCHEDULE_EXPIRED', 'The first mint stage has already started; create a draft with a future schedule before opening.');
  const terms: NftTerms = { maxSupply, royaltyBps: draft.royaltyBps, allowlistRoot: allowlist.root, contentHash: snapshot.contentHash as Hex, metadataBaseURI, collectionURI, allowlist: allowlistStage, publicMint };
  return {
    terms, termsHash: keccak256(encodeAbiParameters([NFT_TERMS_PARAMETER], [terms])), allowlist,
    summary: { name, symbol, creator, chainId, collection, nativeDecimals, publicPriceRaw: publicMint.price, allowlistPriceRaw: allowlistStage.price, firstStart },
  };
}
