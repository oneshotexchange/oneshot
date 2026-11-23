import { z } from 'zod';
import type { LocalCollectionDraft } from './client-oneshot-api';

export const draftBackupMaxBytes = 1024 * 1024;
export type DraftKind = 'token' | 'collection';
const invalidBackup = 'This file is not a supported oneshot draft backup. Your saved drafts have not changed.';
const envelope = z.object({
  format: z.literal('oneshot.creator-draft'),
  version: z.union([z.literal(1), z.literal(2)]),
  kind: z.enum(['token', 'collection']),
  draft: z.unknown(),
}).strict();

/** Portable files contain editable terms only, never account ownership or launch authority. */
export function serializeDraftBackup(kind: DraftKind, draft: unknown): string {
  const text = JSON.stringify({ format: 'oneshot.creator-draft', version: 2, kind, draft }, null, 2);
  const content = text + '\n';
  if (new TextEncoder().encode(content).byteLength > draftBackupMaxBytes) throw new Error('This draft is too large to back up in one file.');
  return content;
}

export function parseDraftBackup<T>(text: string, expectedKind: DraftKind, validate: (value: unknown) => T): T {
  if (new TextEncoder().encode(text).byteLength > draftBackupMaxBytes) throw new Error('Choose a draft backup smaller than 1 MiB.');
  let parsed: z.infer<typeof envelope>;
  try { parsed = envelope.parse(JSON.parse(text)); }
  catch { throw new Error(invalidBackup); }
  if (parsed.kind !== expectedKind) throw new Error(`This is a ${parsed.kind === 'token' ? 'token' : 'collection'} draft. Open the matching creation page to restore it.`);
  try {
    // A v1 backup was authored before network pricing existed. It remains a Zero plan.
    const draft = parsed.version === 1 && parsed.draft && typeof parsed.draft === 'object' && !Array.isArray(parsed.draft)
      ? Object.fromEntries(Object.entries(parsed.draft).filter(([key]) => key !== 'pricingNetwork')) : parsed.draft;
    return validate(draft);
  }
  catch { throw new Error(invalidBackup); }
}

const text = (max: number) => z.string().max(max);
const decimal = text(118).refine(value => value === '' || /^(0|[1-9]\d*)(?:\.\d*)?$/.test(value));
const whole = (max: number) => text(4).refine(value => value === '' || /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max);
// Incomplete dates and empty terms can be backed up while editing. The creator's
// normal save/review validation still checks schedules, addresses and fee terms.
export const portableCollectionDraftSchema = z.object({
  pricingNetwork: z.enum(['zero', 'zero-testnet', 'zero-mainnet', 'base-sepolia']).optional(),
  name: text(100), symbol: text(20).default(''), description: text(2048),
  supply: whole(1000), royalty: text(5).refine(value => value === '' || /^\d+(?:\.\d*)?$/.test(value) && Number(value) <= 10),
  price: decimal, limit: whole(1000), metadataMode: z.enum(['upload', 'url']),
  metadataUrl: text(2048), fileNames: z.array(text(255)).max(1000),
  publicStart: text(80), publicEnd: text(80).default(''), allowlist: z.boolean(),
  allowlistStart: text(80), allowlistEnd: text(80).default(''), allowlistPrice: decimal, addresses: text(430_000),
}).strict();
export type PortableCollectionDraft = z.infer<typeof portableCollectionDraftSchema>;

export function collectionDraftBackup(draft: LocalCollectionDraft): string {
  // Pick schema keys explicitly so IDs, credentials and account-only fields can
  // never be carried along by a future expansion of the editor state.
  const fields = Object.fromEntries(Object.keys(portableCollectionDraftSchema.shape).map(key => [key, draft[key as keyof LocalCollectionDraft]]));
  return serializeDraftBackup('collection', portableCollectionDraftSchema.parse(fields));
}

export function parseCollectionDraftBackup(text: string): PortableCollectionDraft {
  return parseDraftBackup(text, 'collection', value => portableCollectionDraftSchema.parse(value));
}

export function draftBackupFilename(kind: DraftKind, name: string): string {
  const slug = name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();
  return `oneshot-${kind}-${slug || 'draft'}.json`;
}
