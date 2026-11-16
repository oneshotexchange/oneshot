import type { PublicNftCollection } from './client-nft-launch';

export type NftCheckoutAccess = {
  matchingDeployment: boolean;
  available: boolean;
  needsWallet: boolean;
  needsNetwork: boolean;
  ready: boolean;
};

/** Wallet setup is useful only after the existing public read verifies an opened collection's current terms. */
export function nftCheckoutAccess(input: {
  details: PublicNftCollection | null;
  collection: string;
  indexedDeploymentId?: string | null;
  loading: boolean;
  error: string | null;
  authenticated: boolean;
  connected: boolean;
  identityScope: string | null;
  chainId: number | null;
}): NftCheckoutAccess {
  const { details } = input;
  const matchingDeployment = Boolean(details && details.collection.toLowerCase() === input.collection.toLowerCase()
    && (!input.indexedDeploymentId || details.deploymentId === input.indexedDeploymentId));
  const available = Boolean(details?.opened && matchingDeployment && !input.loading && !input.error
    && details.network.chainId === 31337 && details.network.nativeSymbol === 'ETH' && details.network.nativeDecimals === 18);
  const needsWallet = available && (!input.authenticated || !input.connected);
  const needsNetwork = available && input.authenticated && input.connected && input.chainId !== 31337;
  const ready = available && input.authenticated && input.connected && Boolean(input.identityScope) && input.chainId === 31337;
  return { matchingDeployment, available, needsWallet, needsNetwork, ready };
}
