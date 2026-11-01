import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { metadataItemSchema, oneshotDraftSchema, type OneshotDraft } from '../../../web/lib/oneshot-draft-schema';
import { ApiError } from './errors';
import { createOwnedRecord, listOwnedRecords, getRecord, compareAndSetRecord, putIfAbsent } from './store';
import { stableJson, readMedia, storeBlob, storeImage } from './media';
import { canonicalPublicUrl, fetchPublicResource } from './public-fetch';
import { assertLinkedEvmAddress, type OneshotSession } from './oneshot-auth';
import { isPublicIpv4Address, isPublicMetadataOrigin } from '../../../web/lib/oneshot-origin';
import { verifiedNftSnapshot as verifiedSnapshot } from './nft-snapshot';

const namespace = 'oneshot_drafts';
const safeId = z.string().uuid();
function fields(input: unknown, session: OneshotSession) {
  const parsed = oneshotDraftSchema.parse(input);
  parsed.allowlistAddresses = [...new Set(parsed.allowlistAddresses.map(value => value.toLowerCase()))];
  if (parsed.creatorWallet) parsed.creatorWallet = assertLinkedEvmAddress(session, parsed.creatorWallet);
  return parsed;
}
export async function createOneshotDraft(input: unknown, session: OneshotSession): Promise<OneshotDraft> {
  const now = new Date().toISOString();
  const draft: OneshotDraft = { ...fields(input, session), id: randomUUID(), ownerUserId: session.userId, revision: 1, status: 'draft', createdAt: now, updatedAt: now };
  await createOwnedRecord(namespace, draft.id, session.userId, draft);
  return draft;
}
export function listOneshotDrafts(session: OneshotSession) { return listOwnedRecords<OneshotDraft>(namespace, session.userId, 20); }
export async function getOneshotDraft(id: string, session: OneshotSession): Promise<OneshotDraft> {
  safeId.parse(id);
  const value = await getRecord<OneshotDraft>(namespace, id);
  if (!value || value.ownerUserId !== session.userId || value.status === 'deleted') throw new ApiError(404, 'DRAFT_NOT_FOUND', 'Saved draft not found.');
  return value;
}
function assertRevision(draft: OneshotDraft, revision: number) {
  if (!Number.isSafeInteger(revision) || revision !== draft.revision) throw new ApiError(409, 'DRAFT_CHANGED', 'This draft changed elsewhere. Reload it before saving.');
}
export async function updateOneshotDraft(id: string, input: unknown, revision: number, session: OneshotSession) {
  const previous = await getOneshotDraft(id, session); assertRevision(previous, revision);
  if (previous.status !== 'draft') throw new ApiError(409, 'SNAPSHOT_FROZEN', 'Prepared content cannot be overwritten. Create a new draft for changed terms.');
  const updated: OneshotDraft = { ...fields(input, session), id, ownerUserId: session.userId, revision: revision + 1, status: 'draft', createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
  if (!await compareAndSetRecord(namespace, id, previous, updated)) throw new ApiError(409, 'DRAFT_CHANGED', 'This draft changed elsewhere. Reload it before saving.');
  return updated;
}
export async function archiveOneshotDraft(id: string, revision: number, session: OneshotSession) {
  const previous = await getOneshotDraft(id, session); assertRevision(previous, revision);
  const updated = { ...previous, status: 'deleted', revision: revision + 1, updatedAt: new Date().toISOString() };
  if (!await compareAndSetRecord(namespace, id, previous, updated)) throw new ApiError(409, 'DRAFT_CHANGED', 'This draft changed elsewhere. Reload it before archiving.');
  return { id, archived: true };
}

async function snapshotImage(url: string, owner: string, origin: string, remainingBytes: number, signal: AbortSignal) {
  const parsed = canonicalPublicUrl(new URL(url, origin).href);
  if (parsed.origin === origin && /^\/api\/media\/[a-f0-9]{64}\.webp$/.test(parsed.pathname) && !parsed.search && !parsed.hash) {
    const id = parsed.pathname.split('/').at(-1)!;
    const asset = await readMedia(id);
    if (asset.mimeType !== 'image/webp' || createHash('sha256').update(asset.buffer).digest('hex') !== id.split('.')[0]) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored art failed its content check.');
    if (asset.buffer.length > remainingBytes) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'The content batch exceeds 20 MiB.');
    return { url: `${origin}/api/media/${id}`, hash: id.split('.')[0], sourceBytes: asset.buffer.length };
  }
  const remote = await fetchPublicResource(parsed.href, Math.min(5 * 1024 * 1024, remainingBytes), { signal });
  assertSnapshotActive(signal);
  const image = await storeImage(remote.buffer, owner, origin, Math.min(5 * 1024 * 1024, remainingBytes));
  return { ...image, sourceBytes: Math.max(remote.buffer.length, image.size) };
}
async function publicOrigin(input: string) {
  const invalid = () => new ApiError(409, 'HTTPS_METADATA_REQUIRED', 'Publish content through a public HTTPS origin before preparing immutable NFT metadata. Account drafts and local uploads can still be saved.');
  if (!isPublicMetadataOrigin(input)) throw invalid();
  const url = new URL(input);
  let addresses: { address: string; family: number }[];
  try { addresses = await lookup(url.hostname, { family: 4, all: true }); }
  catch { throw invalid(); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(value => !isPublicIpv4Address(value.address))) throw invalid();
  return url.origin;
}

/** Recheck the persisted commitment before deriving an irreversible contract call. */
export async function verifyPreparedOneshotSnapshot(draft: OneshotDraft) {
  const snapshot = draft.snapshot;
  if (draft.status !== 'prepared' || !snapshot || !/^[a-f0-9]{64}$/.test(snapshot.manifestHash)
    || snapshot.contentHash !== `0x${snapshot.manifestHash}`) throw new ApiError(409, 'SNAPSHOT_REQUIRED', 'Prepare immutable metadata before launching.');
  const committed = verifiedSnapshot(await getRecord('oneshot_snapshots', snapshot.manifestHash), snapshot.manifestHash);
  if (committed.items.length !== draft.maxSupply || snapshot.itemCount !== draft.maxSupply) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Snapshot supply differs from the prepared collection.');
  let base: URL, collection: URL;
  try { base = new URL(snapshot.baseUri); collection = new URL(snapshot.collectionUri); }
  catch { throw new ApiError(503, 'CONTENT_INTEGRITY', 'Prepared metadata URLs are invalid.'); }
  const id = collection.pathname.slice('/api/media/'.length);
  if (base.protocol !== 'https:' || !isPublicMetadataOrigin(base.origin) || base.username || base.password || base.search || base.hash
    || base.pathname !== `/api/oneshot/metadata/${snapshot.manifestHash}/` || collection.origin !== base.origin
    || collection.username || collection.password || collection.search || collection.hash
    || !collection.pathname.startsWith('/api/media/') || !/^[a-f0-9]{64}\.json$/.test(id)) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Prepared metadata URLs differ from the stored commitment.');
  const blob = await readMedia(id);
  if (blob.mimeType !== 'application/json' || createHash('sha256').update(blob.buffer).digest('hex') !== id.slice(0,64)) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Collection metadata failed its content check.');
  let metadata: { manifest_hash?: unknown; name?: unknown };
  try { metadata = JSON.parse(blob.buffer.toString('utf8')); } catch { throw new ApiError(503, 'CONTENT_INTEGRITY', 'Collection metadata is invalid.'); }
  if (metadata.manifest_hash !== snapshot.manifestHash || metadata.name !== draft.name) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Collection metadata differs from the prepared draft.');
}
const snapshotTimeout = () => new ApiError(504, 'SNAPSHOT_TIMEOUT', 'The content batch exceeded its preparation deadline. Retry with fewer distinct images.');
function assertSnapshotActive(signal: AbortSignal) { if (signal.aborted) throw snapshotTimeout(); }
export async function prepareOneshotDraft(id: string, revision: number, session: OneshotSession, origin: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(snapshotTimeout()), { once: true }));
  try { return await Promise.race([prepareSnapshot(id, revision, session, origin, controller.signal), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}
async function prepareSnapshot(id: string, revision: number, session: OneshotSession, origin: string, signal: AbortSignal) {
  const previous = await getOneshotDraft(id, session); assertRevision(previous, revision);
  assertSnapshotActive(signal);
  if (previous.status === 'prepared') return previous;
  if (previous.creatorWallet) assertLinkedEvmAddress(session, previous.creatorWallet);
  origin = await publicOrigin(origin);
  assertSnapshotActive(signal);
  let manifest = previous.manifest;
  let sourceBytes = 0;
  if (previous.metadataMode === 'url') {
    const remote = await fetchPublicResource(previous.metadataUrl!, 5 * 1024 * 1024, { signal });
    assertSnapshotActive(signal);
    sourceBytes += remote.buffer.length;
    let body: unknown;
    try { body = JSON.parse(remote.buffer.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_MANIFEST', 'The manifest must be valid JSON containing an items array.'); }
    manifest = z.object({ items: z.array(metadataItemSchema).min(1).max(1000) }).strict().parse(body);
  }
  if (!manifest && previous.imageUrl) manifest = { items: Array.from({ length: previous.maxSupply }, (_, index) => ({ name: `${previous.name} #${index + 1}`, description: previous.description, image: previous.imageUrl! })) };
  if (!manifest || manifest.items.length !== previous.maxSupply) throw new ApiError(400, 'MANIFEST_SUPPLY_MISMATCH', 'Supply must match the metadata item count. Upload a shared cover image or provide one manifest item per NFT.');
  const uniqueImages = new Set(manifest.items.map(item => item.image));
  if (uniqueImages.size > 100) throw new ApiError(400, 'SNAPSHOT_BATCH_LIMIT', 'Prepare at most 100 distinct images per snapshot. Shared-art editions can contain up to 1,000 NFTs.');
  const images = new Map<string, {url:string;hash:string}>();
  const items: { serial: number; metadataId: string; metadataHash: string; imageHash: string }[] = [];
  for (const [index, item] of manifest.items.entries()) {
    assertSnapshotActive(signal);
    let image = images.get(item.image);
    if (!image) { const downloaded = await snapshotImage(item.image, session.userId, origin, 20 * 1024 * 1024 - sourceBytes, signal); assertSnapshotActive(signal); sourceBytes += downloaded.sourceBytes; image = downloaded; images.set(item.image, image); }
    const bytes = Buffer.from(stableJson({ ...item, image: image.url }));
    sourceBytes += bytes.length;
    if (sourceBytes > 20 * 1024 * 1024) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'The content batch exceeds 20 MiB.');
    const blob = await storeBlob(bytes, 'json', session.userId, origin);
    assertSnapshotActive(signal);
    items.push({ serial: index + 1, metadataId: `${blob.hash}.json`, metadataHash: blob.hash, imageHash: image.hash });
  }
  const manifestHash = createHash('sha256').update(stableJson({ items })).digest('hex');
  const collectionBytes = Buffer.from(stableJson({ name: previous.name, description: previous.description, image: images.values().next().value!.url, manifest_hash: manifestHash }));
  if (sourceBytes + collectionBytes.length > 20 * 1024 * 1024) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'The content batch exceeds 20 MiB.');
  const collection = await storeBlob(collectionBytes, 'json', session.userId, origin);
  assertSnapshotActive(signal);
  const committed = await putIfAbsent('oneshot_snapshots', manifestHash, { manifestHash, items, createdAt: new Date().toISOString() });
  verifiedSnapshot(committed, manifestHash);
  assertSnapshotActive(signal);
  const updated: OneshotDraft = { ...previous, manifest: undefined, revision: revision + 1, status: 'prepared', updatedAt: new Date().toISOString(), snapshot: { manifestHash, contentHash: `0x${manifestHash}`, baseUri: `${origin}/api/oneshot/metadata/${manifestHash}/`, collectionUri: collection.url, itemCount: items.length, preparedAt: new Date().toISOString() } };
  if (!await compareAndSetRecord(namespace, id, previous, updated)) throw new ApiError(409, 'DRAFT_CHANGED', 'The draft changed during preparation. Reload it before preparing again.');
  return updated;
}
export async function readOneshotMetadata(manifestHash: string, serial: string) {
  if (!/^[a-f0-9]{64}$/.test(manifestHash) || !/^[1-9]\d{0,3}$/.test(serial)) throw new ApiError(404, 'NOT_FOUND', 'Metadata not found.');
  const record = await getRecord('oneshot_snapshots', manifestHash);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Metadata not found.');
  const snapshot = verifiedSnapshot(record, manifestHash);
  const item = snapshot.items.find(value => value.serial === Number(serial));
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Metadata not found.');
  const blob = await readMedia(item.metadataId);
  if (blob.mimeType !== 'application/json' || createHash('sha256').update(blob.buffer).digest('hex') !== item.metadataHash) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored metadata failed its content check.');
  return blob;
}
