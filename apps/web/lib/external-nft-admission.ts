import { z } from 'zod';
import { externalImportAddressSchema, externalImportDeploymentIdSchema } from './external-nft-import';

const hash = z.string().regex(/^0x[a-f0-9]{64}$/).refine(value => !/^0x0{64}$/.test(value)).transform(value => value as `0x${string}`);
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
export const reviewedNftAdmissionBundleSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), requestRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inspectionCommitment: externalImportDeploymentIdSchema, deploymentId: externalImportDeploymentIdSchema,
  authority: externalImportAddressSchema, chainId: z.union([z.literal(31337), z.literal(84532)]), registry: externalImportAddressSchema,
  collection: externalImportAddressSchema, runtimeCodeHash: hash, reviewVersion: uint, deadline: uint, deploymentSalt: hash, permitHash: hash,
}).strict();
export type ReviewedNftAdmissionBundle = z.infer<typeof reviewedNftAdmissionBundleSchema>;
export const reviewedNftPermitValidationInputSchema = z.object({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), bundle: reviewedNftAdmissionBundleSchema,
  signature: z.string().regex(/^0x(?:[a-fA-F0-9]{2}){1,4096}$/).transform(value => value as `0x${string}`), submitter: externalImportAddressSchema,
}).strict();
