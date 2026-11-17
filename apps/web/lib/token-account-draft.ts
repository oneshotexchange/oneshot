import { z } from 'zod';
import { tokenDraftSchema } from './token-drafts';

export const tokenAccountDraftId = z.string().uuid().refine(value => value === value.toLowerCase());
export const tokenAccountDraftSchema = z.object({
  id: tokenAccountDraftId,
  ownerUserId: z.string().min(1).max(256),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.literal('draft'),
  draft: tokenDraftSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type TokenAccountDraft = z.infer<typeof tokenAccountDraftSchema>;
export const tokenAccountDraftListSchema = z.object({ items: z.array(tokenAccountDraftSchema).max(20) }).strict().superRefine((value, context) => {
  if (new Set(value.items.map(record => record.id)).size !== value.items.length) context.addIssue({ code: 'custom', message: 'Duplicate saved drafts.' });
});
