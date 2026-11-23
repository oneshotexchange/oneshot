import { open } from 'node:fs/promises';
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, hashTypedData, keccak256, type Abi, type Address, type Hex } from 'viem';
import { createVerifiedRpc, networkConfig, type NetworkConfig } from '@oneshot/evm';
import { parseReviewedNftManifest, reviewedNftManifestJson, VerifiedReviewedNftSource, type ReviewedNftManifest, type ReviewedNftBlock } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_REGISTRY_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { ApiError } from './errors';
import { externalImportAddressSchema } from '../../../web/lib/external-nft-import';
import type { ExternalImportDeployment, ExternalNftImportInspection } from './external-nft-imports';

type Rpc = Awaited<ReturnType<typeof createVerifiedRpc>>;
type Connection = { manifest: ReviewedNftManifest; manifestId: string; block: ReviewedNftBlock; rpc: Rpc };
type Environment = Record<string, string | undefined>;
export const REVIEW_PERMIT_TYPES = { ReviewPermit: [
  { name: 'collection', type: 'address' }, { name: 'runtimeCodeHash', type: 'bytes32' },
  { name: 'reviewVersion', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'deploymentSalt', type: 'bytes32' },
] } as const;
export const reviewedNftUnavailable = () => new ApiError(503, 'EXTERNAL_IMPORT_UNAVAILABLE', 'Collection import requests are temporarily unavailable. Please try again.');
const invalid = () => new ApiError(409, 'EXTERNAL_REVIEW_CHANGED', 'The collection review no longer matches the current contract. Review the collection again before preparing admission.');
const quantity = (value: bigint) => `0x${value.toString(16)}` as Hex;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export async function loadReviewedNftManifest(path: string) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile() || (await file.stat()).size > 16_384) throw reviewedNftUnavailable();
    const bytes = Buffer.alloc(16_385), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16_384) throw reviewedNftUnavailable();
    return parseReviewedNftManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead))));
  } finally { await file.close(); }
}
export async function reviewedNftRead<T>(connection: Connection, target: Address, abi: Abi, name: string, args: readonly unknown[] = []): Promise<T> {
  const result = await connection.rpc.readRpc('eth_call', [{ to: target, data: encodeFunctionData({ abi, functionName: name, args }) }, { blockHash: connection.block.hash, requireCanonical: true }]);
  if (typeof result !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(result) || result.length > 16_386) throw reviewedNftUnavailable();
  const decoded = decodeFunctionResult({ abi, functionName: name, data: result as Hex });
  // Reject trailing words/noncanonical booleans and tuples, including permissive decoders.
  if (encodeFunctionResult({ abi, functionName: name, result: decoded }).toLowerCase() !== result.toLowerCase()) throw reviewedNftUnavailable();
  return decoded as T;
}
export async function recheckReviewedNftBlock(connection: Connection) {
  const result = await connection.rpc.readRpc('eth_getBlockByNumber', [quantity(connection.block.number), false]);
  if (!object(result) || result.number !== quantity(connection.block.number) || typeof result.hash !== 'string'
    || result.hash.toLowerCase() !== connection.block.hash) throw reviewedNftUnavailable();
}
function identity(connection: Connection): ExternalImportDeployment {
  const { manifest: m } = connection;
  return { deploymentId: connection.manifestId, chainId: m.chainId, genesisHash: m.genesisHash, registry: m.registry.address, marketplace: m.marketplace.address };
}
export type ReviewedPermitMessage = { collection: Address; runtimeCodeHash: Hex; reviewVersion: string; deadline: string; deploymentSalt: Hex };
export function reviewedNftTypedData(connection: Pick<Connection, 'manifest'>, message: ReviewedPermitMessage) {
  return { domain: { name: 'OneshotReviewedCollectionRegistry', version: '1', chainId: connection.manifest.chainId, verifyingContract: connection.manifest.registry.address }, primaryType: 'ReviewPermit' as const, types: REVIEW_PERMIT_TYPES, message };
}
export function reviewedPermitHash(connection: Pick<Connection, 'manifest'>, message: ReviewedPermitMessage) {
  return hashTypedData({ ...reviewedNftTypedData(connection, message), message: { ...message, reviewVersion: BigInt(message.reviewVersion), deadline: BigInt(message.deadline) } });
}

/** A separate, opt-in external ERC-721 deployment. Native NFT flags/manifests never enable it. */
export function createReviewedNftGateway(dependencies: {
  environment?: () => Environment;
  loadManifest?: (path: string) => Promise<ReviewedNftManifest>;
  rpc?: (config: NetworkConfig) => Promise<Rpc>;
  verify?: (rpc: Rpc, manifest: ReviewedNftManifest) => Promise<Omit<Connection, 'rpc'>>;
  now?: () => number;
} = {}) {
  const environment = dependencies.environment ?? (() => process.env), now = dependencies.now ?? Date.now;
  async function connect(expectedId?: string): Promise<Connection> {
    try {
      const env = environment();
      if (!['local', 'base-sepolia'].includes(env.ONESHOT_NETWORK ?? '') || env.ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED !== 'true' || !env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH) throw reviewedNftUnavailable();
      const manifest = parseReviewedNftManifest(reviewedNftManifestJson(await (dependencies.loadManifest ?? loadReviewedNftManifest)(env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH)));
      const config = networkConfig(env);
      if (manifest.mode !== env.ONESHOT_NETWORK || config.chainId !== manifest.chainId) throw reviewedNftUnavailable();
      const rpc = await (dependencies.rpc ?? createVerifiedRpc)(config);
      const verified = await (dependencies.verify ? dependencies.verify(rpc, manifest) : new VerifiedReviewedNftSource(rpc).verify(manifest));
      if (expectedId !== undefined && expectedId !== verified.manifestId) throw reviewedNftUnavailable();
      return { ...verified, rpc };
    } catch { throw reviewedNftUnavailable(); }
  }
  async function inspectConnection(connection: Connection, raw: string): Promise<ExternalNftImportInspection> {
    const parsed = externalImportAddressSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Enter a valid collection contract address.');
    const collection = parsed.data, { manifest: m, rpc, block } = connection;
    if ([m.oneshotFactory.address, m.registry.address, m.marketplace.address].includes(collection)) throw invalid();
    const selector = { blockHash: block.hash, requireCanonical: true };
    const [code, qualifiedHash, review] = await Promise.all([
      rpc.readRpc('eth_getCode', [collection, selector]),
      // Execute the registry's exact native exclusion and bounded STATICCALL
      // probes. A direct call to supportsInterface has different caller/gas semantics.
      reviewedNftRead<Hex>(connection, m.registry.address, REVIEWED_NFT_REGISTRY_ABI, 'checkCollection', [collection]),
      reviewedNftRead<readonly [Hex, bigint, boolean]>(connection, m.registry.address, REVIEWED_NFT_REGISTRY_ABI, 'reviews', [collection]),
    ]);
    if (typeof code !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(code) || code.length > 131_074 || qualifiedHash !== keccak256(code as Hex)
      || typeof review[1] !== 'bigint' || review[1] < 0n || review[1] >= 2n ** 256n - 1n) throw invalid();
    await recheckReviewedNftBlock(connection);
    return { deployment: identity(connection), collection, runtimeCodeHash: keccak256(code as Hex), currentReviewVersion: review[1].toString(),
      checkpoint: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() }, inspectedAt: new Date(now()).toISOString() };
  }
  return {
    connect, inspectConnection,
    async configuration() {
      try { const c = await connect(); return { available: true as const, deployments: [{ deploymentId: c.manifestId, chainId: c.manifest.chainId, label: c.manifest.chainId === 84532 ? 'Base Sepolia testnet' : 'Local testnet' }] }; }
      catch { return { available: false as const, deployments: [] }; }
    },
    async deployment(id: string) { return identity(await connect(id)); },
    async inspect(deployment: ExternalImportDeployment, collection: Address) {
      const connection = await connect(deployment.deploymentId);
      if (JSON.stringify(identity(connection)) !== JSON.stringify(deployment)) throw reviewedNftUnavailable();
      return inspectConnection(connection, collection);
    },
  };
}
export const reviewedNftGateway = createReviewedNftGateway();
