import { ApiError } from './http';

export function normalizeAddress(value: string) {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new ApiError(400, 'INVALID_ADDRESS', 'Enter a valid Aptos address.');
  return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
}
export function nftPackage() { return process.env.B20_NFT_PACKAGE_ADDRESS ? normalizeAddress(process.env.B20_NFT_PACKAGE_ADDRESS) : null; }
export const fullnode = () => (process.env.APTOS_FULLNODE_URL || 'https://api.testnet.aptoslabs.com/v1').replace(/\/$/, '');
export const graphql = () => process.env.APTOS_INDEXER_URL || 'https://api.testnet.aptoslabs.com/v1/graphql';

export async function chainFetch(path: string, init?: RequestInit) {
  const timeout = AbortSignal.timeout(12_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(`${fullnode()}${path}`, { ...init, cache: 'no-store', signal, headers: { 'Content-Type': 'application/json', ...(process.env.APTOS_API_KEY ? { Authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}), ...init?.headers } });
  if (!response.ok) throw new ApiError(response.status === 404 ? 404 : 503, 'CHAIN_REQUEST_FAILED', response.status === 404 ? 'This object was not found on Aptos testnet.' : 'Aptos testnet could not answer this request.');
  return response.json();
}

let deploymentCache: { until: number; ready: boolean; reason: string } | undefined;
export async function nftDeployment() {
  if (deploymentCache && deploymentCache.until > Date.now()) return deploymentCache;
  const address = nftPackage();
  if (!address) return { ready: false, reason: 'NFT contracts are awaiting deployment on Aptos testnet.' };
  try {
    const ledger = await chainFetch('');
    if (ledger.chain_id !== 2) throw new Error('Wrong chain');
    const modules: any[] = await chainFetch(`/accounts/${address}/modules`);
    const names = new Set(modules.map(m => m.abi?.name));
    const ready = names.has('nft_launch') && names.has('marketplace');
    deploymentCache = { until: Date.now() + 30_000, ready, reason: ready ? '' : 'The configured testnet package does not contain the required B20 modules.' };
  } catch { deploymentCache = { until: Date.now() + 15_000, ready: false, reason: 'The NFT deployment could not be verified on Aptos testnet.' }; }
  return deploymentCache;
}

export async function status() {
  const deployment = await nftDeployment();
  const reason = 'Hyperion testnet deployment and token-only first-buy/sell proof are pending verification.';
  const feeBps = Number(process.env.B20_DEFAULT_DEX_FEE_BPS || 25);
  return {
    network: 'testnet', chainId: 2,
    contracts: { nftPackage: nftPackage(), tokenPackage: process.env.B20_TOKEN_PACKAGE_ADDRESS || null, treasury: process.env.B20_TREASURY_ADDRESS || null },
    features: { nftLaunch: { enabled: deployment.ready, reason: deployment.reason }, marketplace: { enabled: deployment.ready, reason: deployment.reason }, tokenLaunch: { enabled: false, reason }, trading: { enabled: false, reason } },
    indexer: { configured: Boolean(process.env.GEOMI_API_KEY && process.env.DATABASE_URL), lagSeconds: null },
    dex: { name: 'Hyperion', defaultFeeBps: Number.isInteger(feeBps) && feeBps > 0 ? feeBps : 25, verified: false },
    storage: { configured: process.env.NODE_ENV !== 'production' || Boolean(process.env.S3_BUCKET && process.env.DATABASE_URL), mode: process.env.S3_BUCKET ? 'object-storage' : 'local-development' },
    readonly: false,
  };
}
