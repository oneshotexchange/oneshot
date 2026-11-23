import { concatHex, encodeAbiParameters, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';

export const EDITION_1155_ALLOWLIST_DOMAIN = keccak256(stringToHex('ONESHOT_EDITION1155_ALLOWLIST_V1'));

const stageComponents = [
  { name: 'start', type: 'uint64' },
  { name: 'end', type: 'uint64' },
  { name: 'walletLimit', type: 'uint64' },
  { name: 'price', type: 'uint256' },
] as const;

/** Solidity OneshotEdition1155.EditionConfig tuple layout. */
export const EDITION_1155_CONFIG_PARAMETER = {
  type: 'tuple',
  name: 'config_',
  components: [
    { name: 'maxSupply', type: 'uint64' },
    { name: 'allowlistRoot', type: 'bytes32' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'tokenURI', type: 'string' },
    { name: 'allowlist', type: 'tuple', components: stageComponents },
    { name: 'publicMint', type: 'tuple', components: stageComponents },
  ],
} as const;

export const EDITION_1155_FACTORY_ABI = parseAbi([
  'constructor(address treasury_)',
  'function treasury() view returns (address)',
  'function deploymentChainId() view returns (uint256)',
  'function isCollection(address) view returns (bool)',
  'function collections(uint256) view returns (address)',
  'function collectionCount() view returns (uint256)',
  'function createCollection(string name, string symbol, uint16 royaltyBps, string contractURI) returns (address collection)',
  'event EditionCollectionCreated(address indexed collection, address indexed creator, string name, string symbol, uint16 royaltyBps)',
  'error UnsupportedChain()',
  'error InvalidTreasury()',
]);

export const EDITION_1155_ABI = [
  {
    type: 'function',
    name: 'createEdition',
    stateMutability: 'nonpayable',
    inputs: [EDITION_1155_CONFIG_PARAMETER],
    outputs: [{ type: 'uint256', name: 'editionId' }],
  },
  {
    type: 'function',
    name: 'configureEdition',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256', name: 'editionId' }, EDITION_1155_CONFIG_PARAMETER],
    outputs: [],
  },
  {
    type: 'function',
    name: 'editionConfig',
    stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'editionId' }],
    outputs: [EDITION_1155_CONFIG_PARAMETER],
  },
  ...parseAbi([
    'constructor(string name_, string symbol_, address creator_, address treasury_, uint16 royaltyBps_, string contractURI_)',
    'function openEdition(uint256 editionId)',
    'function mint(uint256 editionId, uint256 quantity, address recipient, uint256 maximumTotalPrice, bytes32[] proof) payable',
    'function burn(address account, uint256 editionId, uint256 quantity)',
    'function claimTo(address recipient)',
    'function creator() view returns (address)',
    'function treasury() view returns (address)',
    'function factory() view returns (address)',
    'function deploymentChainId() view returns (uint256)',
    'function royaltyBps() view returns (uint16)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function contractURI() view returns (string)',
    'function uri(uint256 editionId) view returns (string)',
    'function nextEditionId() view returns (uint256)',
    'function totalPending() view returns (uint256)',
    'function editions(uint256 editionId) view returns (bool configured, bool opened, uint64 totalMinted, uint64 totalBurned)',
    'function circulatingSupply(uint256 editionId) view returns (uint256)',
    'function allowlistMinted(uint256 editionId, address wallet) view returns (uint256)',
    'function publicMinted(uint256 editionId, address wallet) view returns (uint256)',
    'function pending(address account) view returns (uint256)',
    'function allowlistLeaf(uint256 editionId, address wallet) view returns (bytes32)',
    'function PLATFORM_FEE_BPS() view returns (uint256)',
    'function MAX_BATCH() view returns (uint256)',
    'function ALLOWLIST_DOMAIN() view returns (bytes32)',
    'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event EditionConfigured(uint256 indexed editionId, bytes32 indexed termsHash)',
    'event EditionOpened(uint256 indexed editionId, bytes32 indexed termsHash, bytes32 indexed contentHash)',
    'event EditionMinted(uint256 indexed editionId, address indexed payer, address indexed recipient, uint256 quantity, uint256 totalPrice, uint256 platformFee, uint256 creatorProceeds, bool allowlistStage)',
    'event EditionBurned(uint256 indexed editionId, address indexed account, address indexed operator, uint256 quantity)',
    'event Claimed(address indexed account, address indexed recipient, uint256 amount)',
    'error UnsupportedChain()',
    'error OnlyCreator()',
    'error Frozen()',
    'error UnknownEdition()',
    'error InvalidTerms()',
    'error NotOpen()',
    'error NoActiveStage()',
    'error InvalidProof()',
    'error InvalidQuantity()',
    'error WalletLimit()',
    'error SupplyLimit()',
    'error PriceLimit()',
    'error IncorrectPayment()',
    'error InvalidRecipient()',
    'error NotAuthorized()',
    'error NothingToClaim()',
    'error PaymentFailed()',
  ]),
] as const;

function validNonzeroAddress(value: string, label: string): Address {
  if (!/^0x[\da-fA-F]{40}$/.test(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`${label} must be a nonzero EVM address.`);
  }
  return value.toLowerCase() as Address;
}

/** Matches OneshotEdition1155.allowlistLeaf(editionId, wallet) identically. */
export function edition1155AllowlistLeaf(
  chainId: number,
  collection: Address,
  editionId: bigint | number,
  wallet: Address,
): Hex {
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('A positive chain ID is required.');
  }
  const id = typeof editionId === 'bigint' ? editionId : BigInt(editionId);
  if (id < 1n) {
    throw new Error('Edition ID must be positive.');
  }
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }],
      [
        EDITION_1155_ALLOWLIST_DOMAIN,
        BigInt(chainId),
        validNonzeroAddress(collection, 'Collection'),
        id,
        validNonzeroAddress(wallet, 'Allowlist wallet'),
      ],
    ),
  );
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(concatHex(a < b ? [a, b] : [b, a]));
}

export function buildEdition1155AllowlistTree(
  values: readonly string[],
  chainId: number,
  collection: Address,
  editionId: bigint | number,
): { root: Hex; addresses: Address[]; proofs: Record<string, Hex[]> } {
  if (values.length > 10_000) {
    throw new Error('Allowlist must contain at most 10,000 addresses.');
  }
  const addresses = [...new Set(values.map(value => validNonzeroAddress(value, 'Allowlist wallet')))].sort();
  if (!addresses.length) return { root: zeroHash, addresses, proofs: {} };
  const levels: Hex[][] = [addresses.map(wallet => edition1155AllowlistLeaf(chainId, collection, editionId, wallet))];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? hashPair(level[index]!, level[index + 1]!) : level[index]!);
    }
    levels.push(next);
  }
  const proofs: Record<string, Hex[]> = {};
  addresses.forEach((wallet, index) => {
    const proof: Hex[] = [];
    let position = index;
    for (const level of levels.slice(0, -1)) {
      const sibling = position % 2 === 0 ? position + 1 : position - 1;
      if (sibling < level.length) proof.push(level[sibling]!);
      position = Math.floor(position / 2);
    }
    proofs[wallet] = proof;
  });
  return { root: levels.at(-1)![0]!, addresses, proofs };
}
