import { randomBytes } from 'node:crypto';
import { encodeFunctionData, keccak256, zeroHash, type Hex } from 'viem';
import { createVerifiedRpc, networkConfig, RpcError, type NetworkConfig } from '@oneshot/evm';
import { parseReviewedNftManifest, reviewedNftManifestJson, reviewedNftManifestId, type ReviewedNftManifest } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { VerifiedReviewedNftJournalSource, normalizeReviewedNftBlock } from '../../../indexer/src/reviewed-nft-source';
import { loadReviewedNftManifest, reviewedNftRead, recheckReviewedNftBlock } from './reviewed-nft-gateway';
import { ApiError } from './errors';

export type ReviewedNftExecutionConnection = { manifest: ReviewedNftManifest; manifestId: string; block: { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }; rpc: Awaited<ReturnType<typeof createVerifiedRpc>> };
export const REVIEWED_NFT_EXECUTION_CONNECT_TIMEOUT_MS = 30_000;
export const reviewedExecutionUnavailable = () => new ApiError(503, 'REVIEWED_NFT_EXECUTION_UNAVAILABLE', 'External NFT transactions are currently unavailable. Please try again later.');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function reviewedRpcQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value)) throw reviewedExecutionUnavailable(); return BigInt(value);
}
/** Recovery needs the pinned market, not live royalty/registry/factory contracts. */
async function verifyMarketOnly(connection: ReviewedNftExecutionConnection) {
  const { manifest: m, rpc, block } = connection, seen = rpc.verification;
  if (seen.mode !== m.mode || seen.chainId !== m.chainId || seen.genesisHash !== m.genesisHash) throw reviewedExecutionUnavailable();
  const source = new VerifiedReviewedNftJournalSource(rpc), [genesis, anchor] = await Promise.all([source.block(0n), source.block(m.startBlock - 1n)]);
  if (genesis.hash !== m.genesisHash || anchor.hash !== m.anchorHash || block.number < m.startBlock) throw reviewedExecutionUnavailable();
  const missing = { blockHash: `0x${randomBytes(32).toString('hex')}`, requireCanonical: true };
  for (const method of ['eth_getCode', 'eth_getBalance', 'eth_call'] as const) {
    let valid = false;
    const target = method === 'eth_call' ? { to: m.marketplace.address, data: encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'MARKETPLACE_VERSION' }) } : m.marketplace.address;
    try { await rpc.readRpc(method, [target, missing]); }
    catch (error) { valid = error instanceof RpcError && error.code === 'RPC_REMOTE_ERROR' && error.remoteRejection === 'block-not-found'; }
    if (!valid) throw reviewedExecutionUnavailable();
  }
  const code = await rpc.readRpc('eth_getCode', [m.marketplace.address, { blockHash: block.hash, requireCanonical: true }]);
  if (typeof code !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(code) || code.length > 131_074 || keccak256(code as Hex) !== m.marketplace.codeHash) throw reviewedExecutionUnavailable();
  const names = ['MARKETPLACE_VERSION','ASSET_STANDARD','PLATFORM_FEE_BPS','registry','oneshotFactory','treasury','deploymentChainId','deploymentSalt','eip712Domain'] as const;
  const values = await Promise.all(names.map(name => reviewedNftRead<unknown>(connection, m.marketplace.address, REVIEWED_NFT_MARKETPLACE_ABI, name)));
  const domain = values[8];
  if (values[0] !== 4n || values[1] !== '0x80ac58cd' || values[2] !== 200n || String(values[3]).toLowerCase() !== m.registry.address || String(values[4]).toLowerCase() !== m.oneshotFactory.address
    || String(values[5]).toLowerCase() !== m.treasury || values[6] !== BigInt(m.chainId) || values[7] !== m.marketplaceSalt || !Array.isArray(domain)
    || domain.length !== 7 || domain[0] !== '0x0f' || domain[1] !== 'OneshotReviewedMarketplace' || domain[2] !== '1' || domain[3] !== BigInt(m.chainId)
    || String(domain[4]).toLowerCase() !== m.marketplace.address || domain[5] !== zeroHash || !Array.isArray(domain[6]) || domain[6].length !== 0) throw reviewedExecutionUnavailable();
  await recheckReviewedNftBlock(connection);
}
export function createReviewedNftExecutionConnector(dependencies: {
  environment?: () => Record<string, string | undefined>;
  loadManifest?: (path: string) => Promise<ReviewedNftManifest>;
  rpc?: (config: NetworkConfig) => Promise<ReviewedNftExecutionConnection['rpc']>;
  verify?: (connection: ReviewedNftExecutionConnection, recoveryOnly: boolean) => Promise<void>;
} = {}) {
  const environment = dependencies.environment ?? (() => process.env);
  return {
    enabled() { const env = environment(); return ['local','base-sepolia'].includes(env.ONESHOT_NETWORK ?? '') && env.ONESHOT_REVIEWED_NFT_EXECUTION_ENABLED === 'true'; },
    async connect(options: { deploymentId?: string; recoveryOnly?: boolean; allowDisabled?: boolean } = {}): Promise<ReviewedNftExecutionConnection> {
      const env = { ...environment() }, selected = { ...options };
      // A disabled service can inspect a previously submitted transaction, never
      // acquire a fresh-action connection through this recovery exception.
      if (!['local','base-sepolia'].includes(env.ONESHOT_NETWORK ?? '') || selected.allowDisabled && selected.recoveryOnly !== true
        || !selected.allowDisabled && env.ONESHOT_REVIEWED_NFT_EXECUTION_ENABLED !== 'true' || !env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH) throw reviewedExecutionUnavailable();
      let active = true, reads = 0, timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => { if (!active) throw reviewedExecutionUnavailable(); };
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { active = false; reject(reviewedExecutionUnavailable()); }, REVIEWED_NFT_EXECUTION_CONNECT_TIMEOUT_MS); });
      try {
        return await Promise.race([(async () => {
          const loaded = await (dependencies.loadManifest ?? loadReviewedNftManifest)(env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH!); check();
          const manifest = parseReviewedNftManifest(reviewedNftManifestJson(loaded)), manifestId = reviewedNftManifestId(manifest);
          const config = networkConfig(env); if (manifest.mode !== env.ONESHOT_NETWORK || config.chainId !== manifest.chainId || selected.deploymentId && selected.deploymentId !== manifestId) throw reviewedExecutionUnavailable();
          const rpc = await (dependencies.rpc ?? createVerifiedRpc)(config); check();
          // The bounded proof wrapper is deliberately not returned. Subsequent
          // service reads retain their own existing RPC identity/deadline gates.
          const proofRpc: typeof rpc = { ...rpc, async readRpc(method, params) { check(); if (++reads > 128) throw reviewedExecutionUnavailable(); const result = await rpc.readRpc(method, params); check(); return result; } };
          const raw = await proofRpc.readRpc('eth_getBlockByNumber', ['latest', false]);
          if (!object(raw) || typeof raw.hash !== 'string' || typeof raw.parentHash !== 'string') throw reviewedExecutionUnavailable();
          const block = normalizeReviewedNftBlock({ number: reviewedRpcQuantity(raw.number), hash: raw.hash as Hex, parentHash: raw.parentHash as Hex, timestamp: reviewedRpcQuantity(raw.timestamp) });
          const proof = { manifest, manifestId, block, rpc: proofRpc };
          if (dependencies.verify) await dependencies.verify(proof, selected.recoveryOnly === true);
          else if (selected.recoveryOnly) await verifyMarketOnly(proof);
          else await new VerifiedReviewedNftJournalSource(proofRpc).verify(manifest, block);
          check(); return { manifest, manifestId, block, rpc };
        })(), deadline]);
      } catch { throw reviewedExecutionUnavailable(); }
      finally { active = false; if (timer) clearTimeout(timer); }
    },
  };
}
export const reviewedNftExecutionConnector = createReviewedNftExecutionConnector();
