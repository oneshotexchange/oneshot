import { NextResponse, type NextRequest } from 'next/server';
import { networkConfig, publicNetwork } from '@oneshot/evm';
import { oneshotAuthStatus } from './oneshot-auth';
import { publicApiOriginConfigured } from './origins';

const deploymentReason = 'Zero NFT deployment and receipt verification are pending. Local contracts and drafts are available.';
const marketReason = 'A verified Zero AMM and token-only launch/custody proof are required.';

function statusNetwork(env: Record<string, string | undefined>) {
  try {
    return { ...publicNetwork(networkConfig(env)), configurationValid: true };
  } catch {
    const mode = env.ONESHOT_NETWORK || 'zero';
    const knownMode = ['zero', 'zero-testnet', 'zero-mainnet', 'local', 'base-sepolia'].includes(mode) ? mode : 'invalid';
    return {
      mode: knownMode,
      name:
        mode === 'local'
          ? 'Local Anvil (not Zero)'
          : mode === 'base-sepolia'
            ? 'Base Sepolia'
            : mode === 'zero-testnet'
              ? 'Zero Testnet'
              : mode === 'zero-mainnet'
                ? 'Zero Mainnet'
                : mode === 'zero'
                  ? 'Zero'
                  : 'Unknown',
      chainId: null,
      nativeSymbol: mode === 'local' || mode === 'base-sepolia' ? 'ETH' : ['zero', 'zero-testnet', 'zero-mainnet'].includes(mode) ? 'ZRO' : null,
      nativeDecimals: null,
      explorerUrl: null,
      isTestnet: mode === 'local' || mode === 'base-sepolia' || mode === 'zero-testnet',
      configurationValid: false,
      configurationReady: false,
      missing: ['Network configuration is invalid. Review the network profile, RPC URL, chain ID, genesis hash and native precision.'],
    };
  }
}

export function oneshotStatus(env: Record<string, string | undefined> = process.env) {
  const config = statusNetwork(env);
  const auth = oneshotAuthStatus(env);
  const production = env.NODE_ENV === 'production';
  const databaseConfigured = !production || Boolean(env.DATABASE_URL);
  const executionScope =
    config.mode === 'base-sepolia'
      ? 'Base Sepolia'
      : config.mode === 'zero-testnet'
        ? 'Zero Testnet'
        : config.mode === 'zero-mainnet'
          ? 'Zero Mainnet'
          : 'Zero';

  const nftReason =
    config.mode === 'base-sepolia'
      ? 'A verified Base Sepolia NFT deployment and receipt path are required.'
      : config.mode === 'zero-testnet'
        ? 'Zero Testnet NFT deployment and receipt verification are pending.'
        : config.mode === 'zero-mainnet'
          ? 'Zero Mainnet deployment requires verified canonical receipts and explicit mainnet opt-in.'
          : deploymentReason;

  const tokenReason =
    config.mode === 'base-sepolia'
      ? 'A verified Base Sepolia AMM and token launch/custody proof are required.'
      : config.mode === 'zero-testnet'
        ? 'A verified Zero Testnet AMM and token launch/custody proof are required.'
        : config.mode === 'zero-mainnet'
          ? 'A verified Zero Mainnet AMM, token launch proof, and explicit mainnet opt-in are required.'
          : marketReason;

  return {
    app: 'oneshot',
    network: config.name,
    chainId: config.chainId,
    nativeSymbol: config.nativeSymbol,
    nativeDecimals: config.nativeDecimals,
    auth,
    accountDrafts: { implemented: true, configured: auth.configured && databaseConfigured },
    metadata: { implemented: true, publicOriginConfigured: publicApiOriginConfigured(env) },
    networkConfig: config,
    stage: production ? 'production' : 'development',
    readonly: true,
    executionScope,
    contracts: { nftPackage: null, tokenPackage: null, treasury: null },
    features: {
      nftLaunch: { enabled: false, reason: nftReason },
      marketplace: { enabled: false, reason: nftReason },
      tokenLaunch: { enabled: false, reason: tokenReason },
      trading: { enabled: false, reason: 'Token trading is a later release.' },
    },
    reviewedNfts: {
      readsEnabled: env.ONESHOT_EXTERNAL_NFTS_READS_ENABLED === 'true',
      executionEnabled: env.ONESHOT_EXTERNAL_NFTS_EXECUTION_ENABLED === 'true',
    },
    tokenAnalytics: {
      readsEnabled: env.ONESHOT_TOKEN_ANALYTICS_READS_ENABLED === 'true',
    },
    indexer: { configured: false, lagSeconds: null },
    dex: { name: 'Pending verification', defaultFeeBps: 25, verified: false },
    // Configuration flags only; no connection or storage availability is claimed.
    storage: {
      configured: databaseConfigured && (!production || Boolean(env.S3_BUCKET)),
      mode: env.S3_BUCKET ? 'object-storage' : production ? 'not-configured' : 'local-development',
    },
  };
}

/** Customer availability only. Operational readiness details require an admin session. */
export function publicOneshotStatus(env: Record<string, string | undefined> = process.env) {
  const status = oneshotStatus(env);
  return {
    app: status.app,
    network: status.network,
    chainId: status.chainId,
    nativeSymbol: status.nativeSymbol,
    nativeDecimals: status.nativeDecimals,
    features: {
      nftLaunch: { enabled: status.features.nftLaunch.enabled, reason: 'Collection launches are currently unavailable. You can save a draft and return later.' },
      marketplace: { enabled: status.features.marketplace.enabled, reason: 'NFT purchases and listings are currently unavailable.' },
      tokenLaunch: { enabled: status.features.tokenLaunch.enabled, reason: 'Token launches are currently unavailable. You can save a draft and return later.' },
      trading: { enabled: status.features.trading.enabled, reason: 'Token trading is currently unavailable.' },
    },
  };
}
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Every existing route uses this dispatcher before legacy handlers. No env flag revives Aptos. */
export function activeNetworkResponse(request: NextRequest): Response | null {
  const path = request.nextUrl.pathname.replace(/\/$/, '');
  if (path === '/api/health' || path === '/api/ready') return null;
  // Only the dedicated EVM/Privy router handles this prefix; no legacy handlers live here.
  if (path.startsWith('/api/oneshot/') || path.startsWith('/api/admin/')) return null;
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/api/status') return json(publicOneshotStatus());
    if (path === '/api/auth/session') return json({ address: null, authenticated: false });
    if (['/api/tokens', '/api/collections', '/api/activity'].includes(path)) return json({ items: [], nextCursor: null, indexedBlock: null, gated: true, reason: 'This service is currently unavailable. You can still save a draft.' });
    if (path === '/api/portfolio') return json({ tokens: [], nfts: [], nftsNextCursor: null, earnings: [], balanceNative: null, gated: true, reason: 'Portfolio balances are currently unavailable.' });
    // Previously saved content-addressed media has no signing or chain side effects.
    if (path.startsWith('/api/media/') || path.startsWith('/api/metadata/')) return null;
    return json({ error: { code: 'ZERO_RECORD_UNAVAILABLE', message: 'This item is currently unavailable.' } }, 404);
  }
  if (path === '/api/auth/session' && request.method === 'DELETE') {
    const result = json({ ok: true });
    result.cookies.delete('b20_session');
    return result;
  }
  return json({ error: { code: 'ZERO_INTEGRATION_PENDING', message: 'This action is currently unavailable. You can still create and save drafts.' } }, 409);
}
