import { formatAssetAmount, parseAssetAmount, UINT256_MAX } from '@oneshot/evm';
import { apiUrl } from './api-url';
import { NftLaunchError, type LocalLaunchNetwork, type NftLaunchRequest } from './client-nft-launch';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { serviceMessage } from './service-message';

export type PrivateNftFloorStatus = {
  eligible: boolean; creator: string; collection: string; deploymentId: string;
  enabled: boolean; floorRaw: string; policyCommitment: `0x${string}`; guarded: true; network: LocalLaunchNetwork;
};
const addressPattern = /^0x[\da-f]{40}$/i;
const zeroAddress = `0x${'0'.repeat(40)}`;
function address(value: unknown): value is string { return typeof value === 'string' && addressPattern.test(value) && value.toLowerCase() !== zeroAddress; }

/** Private creator data is accepted only for the selected linked wallet and collection. */
export function validatePrivateNftFloorStatus(value: unknown, collection: string, creator: string): PrivateNftFloorStatus {
  const status = value as PrivateNftFloorStatus | null;
  const floor = status?.floorRaw;
  if (!status || !address(status.creator) || status.creator.toLowerCase() !== creator.toLowerCase()
    || !address(status.collection) || status.collection.toLowerCase() !== collection.toLowerCase()
    || typeof status.eligible !== 'boolean' || typeof status.enabled !== 'boolean' || (!status.eligible && !status.enabled)
    || status.guarded !== true || typeof status.deploymentId !== 'string' || !status.deploymentId || status.deploymentId.length > 200
    || status.network?.chainId !== 31337 || status.network.nativeSymbol !== 'ETH' || status.network.nativeDecimals !== 18
    || typeof status.policyCommitment !== 'string' || !/^0x[\da-f]{64}$/i.test(status.policyCommitment)
    || typeof floor !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(floor) || BigInt(floor) > UINT256_MAX
    || (status.enabled ? floor === '0' : floor !== '0')) {
    throw new NftLaunchError('The private floor settings could not be verified. Refresh before preparing a change.', 'INVALID_FLOOR_POLICY');
  }
  return status;
}

/** A 404 deliberately has no public UI footprint. This client never requests a wallet signature. */
export function createNftFloorApi(options: { identityScope(): string | null; getAccessToken(): Promise<string | null>; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher || fetch;
  return {
    async status(collection: string, creator: string): Promise<PrivateNftFloorStatus | null> {
      if (!address(collection) || !address(creator)) throw new NftLaunchError('Choose a valid collection and linked creator wallet.', 'INVALID_REQUEST');
      const scope = options.identityScope();
      if (!scope) throw new NftLaunchError('Sign in and select the linked creator wallet.', 'IDENTITY_CHANGED');
      const token = await options.getAccessToken();
      const unchanged = () => {
        if (options.identityScope() !== scope) throw new NftLaunchError('Your account or wallet changed. Reload the private settings.', 'IDENTITY_CHANGED');
      };
      unchanged();
      if (!token) throw new NftLaunchError('Your session expired. Sign in again.', 'IDENTITY_CHANGED');
      const query = new URLSearchParams({ wallet: creator.toLowerCase() });
      const response = await customerFetch(apiUrl(`/api/oneshot/launch/floor/${collection.toLowerCase()}?${query}`), {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', redirect: 'error', cache: 'no-store',
      }, fetcher);
      unchanged();
      if (response.status === 404) return null;
      const result = await customerResponseJson(response, { invalidResponse: () => new NftLaunchError('The private floor settings could not be verified. Refresh before preparing a change.', 'INVALID_FLOOR_POLICY') });
      unchanged();
      const error = customerErrorDetails(result);
      if (!response.ok) throw new NftLaunchError(serviceMessage(error.code, error.message, 'Private floor settings are unavailable. Please try again.'), error.code || 'FLOOR_UNAVAILABLE', response.status);
      return validatePrivateNftFloorStatus(result, collection, creator);
    },
  };
}

/** Exact native ETH only; disabling explicitly clears the minimum. */
export function nftFloorPolicyRequest(input: { from: string; collection: string; enabled: boolean; price: string; eligible: boolean }): NftLaunchRequest {
  if (!address(input.from) || !address(input.collection)) throw new NftLaunchError('Choose a valid collection and linked creator wallet.', 'INVALID_REQUEST');
  if (input.enabled && !input.eligible) throw new NftLaunchError('This creator wallet can only disable its existing floor policy.', 'FLOOR_INELIGIBLE');
  let floor = 0n;
  if (input.enabled) {
    try { floor = parseAssetAmount(input.price, 18); }
    catch { throw new NftLaunchError('Enter an exact ETH amount with at most 18 decimal places.', 'INVALID_FLOOR_PRICE'); }
    if (floor === 0n) throw new NftLaunchError('Enter a floor greater than zero ETH.', 'INVALID_FLOOR_PRICE');
  }
  return { action: 'policy', from: input.from.toLowerCase(), collection: input.collection.toLowerCase(), localEthAcknowledged: true,
    floorEnabled: input.enabled, floorPrice: formatAssetAmount(floor, 18) };
}
