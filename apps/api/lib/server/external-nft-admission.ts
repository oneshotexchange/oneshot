import { encodeFunctionData, type Address } from 'viem';
import { REVIEWED_NFT_REGISTRY_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftAdmissionBundleSchema, reviewedNftPermitValidationInputSchema, type ReviewedNftAdmissionBundle } from '../../../web/lib/external-nft-admission';
import { createExternalNftImports, type StoredExternalNftImport } from './external-nft-imports';
import { reviewedNftGateway, reviewedNftRead, recheckReviewedNftBlock, reviewedPermitHash, reviewedNftTypedData, type ReviewedPermitMessage } from './reviewed-nft-gateway';
import { ApiError } from './errors';

export const reviewedNftImports = createExternalNftImports({ deployment: reviewedNftGateway.deployment, inspect: reviewedNftGateway.inspect });
const changed = () => new ApiError(409, 'EXTERNAL_REVIEW_CHANGED', 'The collection review changed. Reload the request and review its contract before preparing admission.');
const badPermit = () => new ApiError(409, 'EXTERNAL_PERMIT_INVALID', 'This admission permit is invalid, expired or no longer matches the approved review. Prepare a new permit.');
const message = (bundle: ReviewedNftAdmissionBundle): ReviewedPermitMessage => ({ collection: bundle.collection, runtimeCodeHash: bundle.runtimeCodeHash, reviewVersion: bundle.reviewVersion, deadline: bundle.deadline, deploymentSalt: bundle.deploymentSalt });

/** Prepares or simulates unsigned admission only; it never signs or broadcasts. */
export function createExternalNftAdmission(dependencies: {
  imports?: Pick<typeof reviewedNftImports, 'adminRead'>;
  gateway?: Pick<typeof reviewedNftGateway, 'connect' | 'inspectConnection'>;
  now?: () => number;
} = {}) {
  const imports = dependencies.imports ?? reviewedNftImports, gateway = dependencies.gateway ?? reviewedNftGateway, now = dependencies.now ?? Date.now;
  async function approved(id: string, revision: number) {
    const record = await imports.adminRead(id);
    if (record.request.revision !== revision || record.request.status !== 'review-approved' || !record.review?.inspection || !record.review.inspectionCommitment) throw changed();
    return record;
  }
  async function inspect(record: StoredExternalNftImport) {
    const connection = await gateway.connect(record.request.deploymentId), inspection = await gateway.inspectConnection(connection, record.request.collection);
    const prior = record.review!.inspection!;
    if (inspection.runtimeCodeHash !== prior.runtimeCodeHash || inspection.currentReviewVersion !== prior.currentReviewVersion
      || JSON.stringify(inspection.deployment) !== JSON.stringify(prior.deployment)) throw changed();
    return { connection, inspection };
  }
  async function current(record: StoredExternalNftImport) {
    const latest = await approved(record.request.id, record.request.revision);
    if (latest.review!.inspectionCommitment !== record.review!.inspectionCommitment) throw changed();
  }
  function assertBundle(record: StoredExternalNftImport, bundle: ReviewedNftAdmissionBundle, connection: Awaited<ReturnType<typeof gateway.connect>>) {
    const m = connection.manifest, proof = record.review!.inspection!, seconds = BigInt(Math.floor(now() / 1000));
    if (bundle.requestId !== record.request.id || bundle.requestRevision !== record.request.revision || bundle.inspectionCommitment !== record.review!.inspectionCommitment
      || bundle.deploymentId !== record.request.deploymentId || bundle.authority !== m.reviewAuthority || bundle.chainId !== m.chainId || bundle.registry !== m.registry.address
      || bundle.collection !== record.request.collection || bundle.runtimeCodeHash !== proof.runtimeCodeHash || BigInt(bundle.reviewVersion) !== BigInt(proof.currentReviewVersion) + 1n
      || bundle.deploymentSalt !== m.registrySalt || BigInt(bundle.deadline) <= seconds || BigInt(bundle.deadline) > seconds + 900n
      || BigInt(bundle.deadline) <= connection.block.timestamp || bundle.permitHash !== reviewedPermitHash(connection, message(bundle))) throw badPermit();
  }
  return {
    async prepare(id: string, revision: number) {
      const record = await approved(id, revision), { connection, inspection } = await inspect(record), m = connection.manifest;
      const partial = { collection: record.request.collection, runtimeCodeHash: inspection.runtimeCodeHash, reviewVersion: (BigInt(inspection.currentReviewVersion) + 1n).toString(),
        deadline: (BigInt(Math.floor(now() / 1000)) + 900n).toString(), deploymentSalt: m.registrySalt } as ReviewedPermitMessage;
      const bundle = reviewedNftAdmissionBundleSchema.parse({ schemaVersion: 1, requestId: id, requestRevision: revision, inspectionCommitment: record.review!.inspectionCommitment,
        deploymentId: record.request.deploymentId, authority: m.reviewAuthority, chainId: m.chainId, registry: m.registry.address, ...partial, permitHash: reviewedPermitHash(connection, partial) });
      assertBundle(record, bundle, connection);
      const onchainHash = await reviewedNftRead<string>(connection, m.registry.address, REVIEWED_NFT_REGISTRY_ABI, 'reviewPermitHash', [partial.collection, partial.runtimeCodeHash, BigInt(partial.reviewVersion), BigInt(partial.deadline)]);
      if (onchainHash !== bundle.permitHash) throw badPermit();
      await recheckReviewedNftBlock(connection); await current(record);
      assertBundle(record, bundle, connection);
      return { bundle, typedData: reviewedNftTypedData(connection, partial), admissionStatus: 'not-established' as const };
    },
    async validate(id: string, raw: unknown) {
      const parsed = reviewedNftPermitValidationInputSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(400, 'EXTERNAL_PERMIT_INPUT_INVALID', 'Check the permit bundle, authority signature and submitting wallet.');
      const { expectedRevision, bundle, signature, submitter } = parsed.data;
      const record = await approved(id, expectedRevision), { connection } = await inspect(record);
      assertBundle(record, bundle, connection);
      const call = { from: submitter as Address, to: connection.manifest.registry.address,
        data: encodeFunctionData({ abi: REVIEWED_NFT_REGISTRY_ABI, functionName: 'admitReviewed', args: [bundle.collection, bundle.runtimeCodeHash, BigInt(bundle.reviewVersion), BigInt(bundle.deadline), signature] }), value: '0x0' as const };
      let simulation: Awaited<ReturnType<typeof connection.rpc.simulateCall>>;
      try { simulation = await connection.rpc.simulateCall(call, { number: `0x${connection.block.number.toString(16)}`, hash: connection.block.hash }); }
      catch { throw badPermit(); }
      if (simulation.result !== '0x') throw badPermit();
      await recheckReviewedNftBlock(connection); await current(record);
      assertBundle(record, bundle, connection);
      return { call: { chainId: bundle.chainId, ...call }, simulation: { blockNumber: connection.block.number.toString(), blockHash: connection.block.hash, gasEstimate: simulation.gasEstimate },
        permitHash: bundle.permitHash, deadline: bundle.deadline, admissionStatus: 'not-established' as const };
    },
  };
}
export const externalNftAdmission = createExternalNftAdmission();
