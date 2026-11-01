import { z } from 'zod';
import { isPublicContentSource } from './oneshot-origin';

const nativePrice = z.string().max(118).regex(/^(0|[1-9]\d{0,77})(?:\.\d{1,38})?$/, 'Use a non-negative decimal price. Precision will be checked against the target network before deployment.');
const date = z.string().datetime({ offset: true });
const source = z.string().min(1).max(2048).refine(isPublicContentSource, 'Use a public HTTPS or IPFS resource without credentials or a fragment.');
const wallet = z.string().regex(/^0x[\da-fA-F]{40}$/, 'Enter an EVM address.').refine(value => !/^0x0{40}$/i.test(value), 'Use a nonzero EVM address.');
const art = z.union([source, z.string().regex(/^\/api\/media\/[a-f0-9]{64}\.webp$/)]);
export const metadataItemSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2048).optional(), image: art, attributes: z.array(z.object({ trait_type: z.string().max(100), value: z.union([z.string().max(200), z.number().finite()]) }).strict()).max(100).optional() }).strict();
export const oneshotDraftSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(value => new TextEncoder().encode(value).length <= 100, 'Collection names must fit 100 UTF-8 bytes.'), description: z.string().max(2048).default(''),
  symbol: z.string().trim().min(1, 'Enter a collection symbol.').refine(value => new TextEncoder().encode(value).length <= 20, 'Collection symbols must fit 20 UTF-8 bytes.').optional(),
  maxSupply: z.number().int().min(1).max(1000), royaltyBps: z.number().int().min(0).max(1000),
  publicPrice: nativePrice, allowlistPrice: nativePrice.default('0'), perWalletLimit: z.number().int().min(1).max(1000),
  publicStart: date, publicEnd: date, allowlistStart: date.optional(), allowlistEnd: date.optional(),
  allowlistAddresses: z.array(wallet).max(10000).default([]),
  creatorWallet: wallet.optional(),
  metadataMode: z.enum(['upload','url']), metadataUrl: source.optional(), imageUrl: art.optional(),
  manifest: z.object({ items: z.array(metadataItemSchema).min(1).max(1000) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.perWalletLimit > value.maxSupply) context.addIssue({ code: 'custom', path: ['perWalletLimit'], message: 'Wallet limit cannot exceed collection supply.' });
  if (Date.parse(value.publicStart) >= Date.parse(value.publicEnd)) context.addIssue({ code: 'custom', path: ['publicEnd'], message: 'Public mint end must follow its start.' });
  if (value.allowlistAddresses.length && (!value.allowlistStart || !value.allowlistEnd || Date.parse(value.allowlistStart) >= Date.parse(value.allowlistEnd) || Date.parse(value.allowlistEnd) > Date.parse(value.publicStart))) context.addIssue({ code: 'custom', path: ['allowlistStart'], message: 'Schedule the allowlist before the public mint.' });
  if (!value.allowlistAddresses.length && (value.allowlistStart || value.allowlistEnd)) context.addIssue({ code: 'custom', path: ['allowlistAddresses'], message: 'An allowlist schedule needs at least one wallet.' });
  if (value.metadataMode === 'url' && !value.metadataUrl) context.addIssue({ code: 'custom', path: ['metadataUrl'], message: 'Enter a metadata manifest URL.' });
});
export type OneshotDraftInput = z.infer<typeof oneshotDraftSchema>;
export type OneshotDraft = OneshotDraftInput & {
  id: string; ownerUserId: string; revision: number; status: 'draft'|'prepared'|'deleted'; createdAt: string; updatedAt: string;
  snapshot?: { manifestHash: string; contentHash: `0x${string}`; baseUri: string; collectionUri: string; itemCount: number; preparedAt: string };
};
