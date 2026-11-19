import { z } from 'zod';

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const text = (maximum: number) => z.string().trim().max(maximum).refine(value => !controls.test(value));
export const externalImportDeploymentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const externalImportAddressSchema = z.string().regex(/^0x[\da-fA-F]{40}$/)
  .refine(value => !/^0x0{40}$/i.test(value)).transform(value => value.toLowerCase() as `0x${string}`);

/** Submitting a collection address does not assert creator or contract ownership. */
export const externalNftImportInputSchema = z.object({
  deploymentId: externalImportDeploymentIdSchema,
  collection: externalImportAddressSchema,
  note: text(1000).default(''),
  reference: text(2048).default(''),
}).strict();
export type ExternalNftImportInput = z.infer<typeof externalNftImportInputSchema>;
export const externalNftImportStatusSchema = z.enum(['submitted', 'review-approved', 'rejected', 'withdrawn']);
export type ExternalNftImportStatus = z.infer<typeof externalNftImportStatusSchema>;

/** Account-private request DTO. Review approval never proves onchain admission. */
export const accountExternalNftImportSchema = externalNftImportInputSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: externalNftImportStatusSchema,
  admissionStatus: z.literal('not-established'),
  customerNote: text(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reviewedAt: z.string().datetime().nullable(),
}).strict();
export type AccountExternalNftImport = z.infer<typeof accountExternalNftImportSchema>;
export const accountExternalNftImportPageSchema = z.object({
  items: z.array(accountExternalNftImportSchema).max(50), nextCursor: z.string().max(2048).nullable(),
}).strict();
export type AccountExternalNftImportPage = z.infer<typeof accountExternalNftImportPageSchema>;
export const externalNftImportDecisionSchema = z.object({
  decision: z.enum(['review-approved', 'rejected']),
  customerNote: text(500).default(''),
  operatorEvidence: text(8000).default(''),
}).strict();
export type ExternalNftImportDecision = z.infer<typeof externalNftImportDecisionSchema>;
export const isActiveExternalNftImport = (status: ExternalNftImportStatus) => status === 'submitted' || status === 'review-approved';
