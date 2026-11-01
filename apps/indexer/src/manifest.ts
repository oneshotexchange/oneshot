import { createHash } from 'node:crypto';
import { zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { IndexerError, type Manifest } from './types';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value);
export const isAddress = (value: unknown): value is Address => typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value);
export const isData = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[\da-fA-F]{2})*$/.test(value);
const fail = (): never => { throw new IndexerError('MANIFEST_INVALID'); };
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** The local phase deliberately cannot turn a guessed Zero configuration into a deployment. */
export function parseManifest(input: unknown): Manifest {
  if (!object(input)) return fail();
  const guarded = input.deploymentVersion === 'oneshot-nft-v2';
  const keys = ['schemaVersion', 'deploymentVersion', 'mode', 'chainId', 'genesisHash', 'startBlock', 'anchorHash', 'factory', 'marketplace'];
  if (!exact(input, guarded ? [...keys, 'listingAuthorization'] : keys)
    || input.schemaVersion !== 1 || (!guarded && input.deploymentVersion !== 'oneshot-nft-v1') || input.mode !== 'local' || input.chainId !== 31337
    || !isHash(input.genesisHash) || !isHash(input.anchorHash)
    || typeof input.startBlock !== 'string' || !/^[1-9]\d{0,19}$/.test(input.startBlock)) return fail();
  const contract = (value: unknown): Manifest['factory'] => {
    if (!object(value) || !exact(value, ['address', 'codeHash']) || !isAddress(value.address)
      || value.address.toLowerCase() === zeroAddress || !isHash(value.codeHash)) return fail();
    return { address: value.address.toLowerCase() as Address, codeHash: value.codeHash.toLowerCase() as Hex };
  };
  const factory = contract(input.factory), marketplace = contract(input.marketplace);
  if (factory.address === marketplace.address) return fail();
  const common = {
    schemaVersion: 1 as const, mode: 'local' as const, chainId: 31337 as const,
    genesisHash: input.genesisHash.toLowerCase() as Hex, startBlock: BigInt(input.startBlock),
    anchorHash: input.anchorHash.toLowerCase() as Hex, factory, marketplace,
  };
  if (!guarded) return { ...common, deploymentVersion: 'oneshot-nft-v1' };
  const authorization = input.listingAuthorization;
  if (!object(authorization) || !exact(authorization, ['authority', 'salt'])
    || !isAddress(authorization.authority) || authorization.authority.toLowerCase() === zeroAddress
    || !isHash(authorization.salt) || authorization.salt.toLowerCase() === zeroHash) return fail();
  return { ...common, deploymentVersion: 'oneshot-nft-v2', listingAuthorization: {
    authority: authorization.authority.toLowerCase() as Address, salt: authorization.salt.toLowerCase() as Hex,
  } };
}

export function manifestJson(manifest: Manifest) {
  return {
    schemaVersion: manifest.schemaVersion, deploymentVersion: manifest.deploymentVersion, mode: manifest.mode,
    chainId: manifest.chainId, genesisHash: manifest.genesisHash, startBlock: manifest.startBlock.toString(),
    anchorHash: manifest.anchorHash, factory: { ...manifest.factory }, marketplace: { ...manifest.marketplace },
    ...(manifest.deploymentVersion === 'oneshot-nft-v2' ? { listingAuthorization: { ...manifest.listingAuthorization } } : {}),
  };
}
export function manifestId(manifest: Manifest): string {
  // Normalize and strictly validate even programmatically supplied manifests before using a cursor.
  const normalized = parseManifest(manifestJson(manifest));
  return createHash('sha256').update(JSON.stringify(manifestJson(normalized))).digest('hex');
}
