import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseUnits } from '@b20/sdk';
import { ApiError } from './http';
import { normalizeAddress } from './config';
import { getRecord, putRecord, listRecords, compareAndSetRecord } from './store';
import { readMedia, stableJson, storeBlob, storeImage } from './media';
import { fetchPublicResource } from './public-fetch';

const price = z.string().regex(/^\d+(?:\.\d{1,8})?$/).default('0');
const itemSchema = z.object({ name: z.string().min(1).max(100), description: z.string().max(2048).optional(), image: z.string().min(1).max(2048), attributes: z.array(z.object({ trait_type: z.string().max(100), value: z.union([z.string().max(200), z.number()]) })).max(100).optional() });
export const draftSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(value => Buffer.byteLength(value, 'utf8') <= 100, 'Collection names must fit within 100 UTF-8 bytes.'),
  description: z.string().max(2048).refine(value => Buffer.byteLength(value, 'utf8') <= 2048, 'Descriptions must fit within 2048 UTF-8 bytes.').default(''),
  maxSupply: z.coerce.number().int().min(1).max(1000), royaltyBps: z.coerce.number().int().min(0).max(1000).default(500),
  publicPriceApt: price, allowlistPriceApt: price,
  allowlistAddresses: z.array(z.string()).max(10000).default([]),
  publicStart: z.string().optional(), publicEnd: z.string().optional(), allowlistStart: z.string().optional(), allowlistEnd: z.string().optional(),
  perWalletLimit: z.coerce.number().int().min(1).max(1000).default(1),
  metadataMode: z.enum(['upload', 'url']).default('upload'), metadataUrl: z.string().max(2048).optional(),
  imageUrl: z.string().max(2048).optional(),
  manifest: z.object({ items: z.array(itemSchema).min(1).max(1000) }).optional(),
});
export type Draft = z.infer<typeof draftSchema> & { id: string; owner: string; status: 'draft' | 'prepared' | 'created' | 'configured' | 'open'; createdAt: string; collectionId?: string; baseUri?: string; collectionUri?: string; manifestHash?: string };
export async function saveDraft(input: unknown, owner: string) {
  const fields = draftSchema.parse(input);
  for (const p of [fields.publicPriceApt, fields.allowlistPriceApt]) if (parseUnits(p) > ((1n << 64n) - 1n) / BigInt(fields.maxSupply)) throw new ApiError(400, 'INVALID_PRICE', 'The mint price and supply exceed the supported transaction range.');
  fields.allowlistAddresses = [...new Set(fields.allowlistAddresses.map(normalizeAddress))];
  fields.perWalletLimit = Math.min(fields.perWalletLimit, fields.maxSupply);
  const start = fields.publicStart ? Date.parse(fields.publicStart) : Date.now() + 15 * 60_000;
  if (!Number.isFinite(start) || start <= Date.now()) throw new ApiError(400, 'INVALID_SCHEDULE', 'Public minting must start in the future.');
  fields.publicStart = new Date(start).toISOString();
  fields.publicEnd = fields.publicEnd || new Date(start + 30 * 86400_000).toISOString();
  const end=Date.parse(fields.publicEnd);
  if (!Number.isFinite(end)||end <= start) throw new ApiError(400, 'INVALID_SCHEDULE', 'Public minting must end after it starts.');
  fields.publicEnd=new Date(end).toISOString();
  if (fields.allowlistAddresses.length) {
    const allowStart = fields.allowlistStart ? Date.parse(fields.allowlistStart) : Date.now() + 5 * 60_000;
    const allowEnd = fields.allowlistEnd ? Date.parse(fields.allowlistEnd) : start;
    if (!Number.isFinite(allowStart) || !Number.isFinite(allowEnd) || allowStart <= Date.now() || allowStart >= allowEnd || allowEnd > start) throw new ApiError(400, 'INVALID_SCHEDULE', 'Schedule the allowlist in the future, before the public mint.');
    fields.allowlistStart = new Date(allowStart).toISOString(); fields.allowlistEnd = new Date(allowEnd).toISOString();
  }
  const draft: Draft = { ...fields, id: randomUUID(), owner, status: 'draft', createdAt: new Date().toISOString() };
  await putRecord('drafts', draft.id, draft); return draft;
}
export async function ownedDraft(id: string, owner: string): Promise<Draft> {
  const draft = await getRecord<Draft>('drafts', id);
  if (!draft || draft.owner !== owner) throw new ApiError(404, 'DRAFT_NOT_FOUND', 'Collection draft not found.');
  return draft;
}
export async function ownerDrafts(owner: string) { return (await listRecords<Draft>('drafts')).filter(d => d.owner === owner); }
async function snapshotImage(url: string, owner: string, origin: string) {
  if (url.startsWith(`${origin}/api/media/`)) { const id = url.slice(`${origin}/api/media/`.length); const media = await readMedia(id); if (!media.mimeType.startsWith('image/')) throw new ApiError(400, 'INVALID_IMAGE', 'Metadata must reference an image.'); return { url, hash: id.split('.')[0] }; }
  const remote = await fetchPublicResource(url); return storeImage(remote.buffer, owner, origin);
}
export async function prepareDraft(id: string, owner: string, origin: string) {
  const draft = await ownedDraft(id, owner);
  if (draft.status !== 'draft') return draft;
  if(new URL(origin).protocol!=='https:')throw new ApiError(409,'HTTPS_METADATA_REQUIRED','Collection snapshots require a public HTTPS deployment before on-chain creation. Local drafts and uploads can still be saved.');
  let manifest = draft.manifest;
  if (draft.metadataMode === 'url') {
    if (!draft.metadataUrl) throw new ApiError(400, 'MANIFEST_REQUIRED', 'Enter a metadata manifest URL containing an items array.');
    const remote = await fetchPublicResource(draft.metadataUrl);
    let body: unknown; try { body = JSON.parse(remote.buffer.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_MANIFEST', 'The manifest URL must return JSON containing an items array.'); }
    manifest = z.object({ items: z.array(itemSchema).min(1).max(1000) }).parse(body);
  }
  if (!manifest && draft.imageUrl) manifest = { items: Array.from({ length: draft.maxSupply }, (_, i) => ({ name: `${draft.name} #${i + 1}`, description: draft.description, image: draft.imageUrl! })) };
  if (!manifest || manifest.items.length !== draft.maxSupply) throw new ApiError(400, 'MANIFEST_SUPPLY_MISMATCH', 'Supply must equal the number of items in the manifest. Upload a cover image for a shared-art edition, or supply one item per NFT.');
  const images = new Map<string, { url: string; hash: string }>();
  const items: { serial: number; metadataId: string; name: string; image: string }[] = [];
  for (const [i, item] of manifest.items.entries()) {
    let image = images.get(item.image); if (!image) { image = await snapshotImage(item.image, owner, origin); images.set(item.image, image); }
    const metadata = { ...item, image: image.url };
    const blob = await storeBlob(Buffer.from(stableJson(metadata)), 'json', owner, origin);
    items.push({ serial: i + 1, metadataId: `${blob.hash}.json`, name: item.name, image: image.url });
  }
  const manifestHash = createHash('sha256').update(stableJson({ items })).digest('hex');
  await putRecord('snapshots', manifestHash, { manifestHash, owner, items, createdAt: new Date().toISOString() });
  const collectionBlob = await storeBlob(Buffer.from(stableJson({ name: draft.name, description: draft.description, image: items[0].image, external_url: `${origin}/nfts`, manifest_hash: manifestHash })), 'json', owner, origin);
  const prepared: Draft = { ...draft, manifest: undefined, imageUrl: items[0].image, status: 'prepared', manifestHash, baseUri: `${origin}/api/metadata/${manifestHash}/`, collectionUri: collectionBlob.url };
  if(!await compareAndSetRecord('drafts',id,draft,prepared))return ownedDraft(id,owner);
  return prepared;
}

const hash = (b: Buffer) => createHash('sha3-256').update(b).digest();
export function allowlistTree(collection: string, addresses: string[], wallet?: string) {
  const unique = [...new Set(addresses.map(normalizeAddress))].sort();
  if (!unique.length) return { root: '0x', proof: [] as string[] };
  const leaves = unique.map(address => hash(Buffer.concat([Buffer.from('B20_ALLOWLIST_V1'), Buffer.from(normalizeAddress(collection).slice(2), 'hex'), Buffer.from(address.slice(2), 'hex')])));
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const previous = levels[levels.length - 1]; const next: Buffer[] = [];
    for (let i = 0; i < previous.length; i += 2) { const right = previous[i + 1]; if (!right) next.push(previous[i]); else next.push(hash(Buffer.concat([previous[i], right].sort(Buffer.compare)))); }
    levels.push(next);
  }
  const proof: string[] = []; let index = wallet ? unique.indexOf(normalizeAddress(wallet)) : -1;
  if (wallet && index < 0) throw new ApiError(403, 'NOT_ALLOWLISTED', 'This wallet is not on the collection allowlist.');
  if (index >= 0) for (let level = 0; level < levels.length - 1; level++) { const sibling = levels[level][index ^ 1]; if (sibling) proof.push(`0x${sibling.toString('hex')}`); index = Math.floor(index / 2); }
  return { root: `0x${levels[levels.length - 1][0].toString('hex')}`, proof };
}
