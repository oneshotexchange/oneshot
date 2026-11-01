import { createHash } from 'node:crypto';
import type { IndexedNftPresentation } from '@oneshot/evm';
import { metadataItemSchema } from '../../../web/lib/oneshot-draft-schema';
import { isPublicMetadataOrigin } from '../../../web/lib/oneshot-origin';
import { getRecord } from './store';
import { readMedia } from './media';
import { verifiedNftSnapshot } from './nft-snapshot';

const MAX_METADATA_BYTES = 256 * 1024;
const REQUEST_METADATA_BUDGET = 2 * 1024 * 1024;
const MAX_PRESENTATIONS = 50;
type Snapshot = ReturnType<typeof verifiedNftSnapshot>;
type Dependencies = {
  /** Indexed reads inject their existing SQL client, avoiding nested pool acquisition. */
  record: (namespace: string, id: string) => Promise<unknown>;
  media: (id: string, record: unknown, maximumBytes: number, signal: AbortSignal) => Promise<{ buffer: Buffer; mimeType: string }>;
};
const defaults: Dependencies = {
  record: getRecord,
  media: (id, record, maximumBytes, signal) => readMedia(id, { record: async () => record, maximumBytes, signal }),
};

/** One bounded cache per indexed response. Never fetches URLs or reads private drafts. */
export function createNftPublicContentResolver(overrides: Partial<Dependencies> & { signal?: AbortSignal } = {}) {
  const deps = { ...defaults, ...overrides };
  const signal = overrides.signal ?? AbortSignal.timeout(5000);
  const snapshots = new Map<string, Promise<Snapshot | null>>();
  const presentations = new Map<string, Promise<IndexedNftPresentation | null>>();
  let remaining = REQUEST_METADATA_BUDGET;

  async function snapshot(manifestHash: string) {
    // Storage/SQL failures propagate; only invalid/missing content becomes a placeholder.
    const value = await deps.record('oneshot_snapshots', manifestHash);
    if (!value) return null;
    try { return verifiedNftSnapshot(value, manifestHash); } catch { return null; }
  }
  async function resolve(manifestHash: string, tokenId: string): Promise<IndexedNftPresentation | null> {
    let pending = snapshots.get(manifestHash);
    if (!pending) { pending = snapshot(manifestHash); snapshots.set(manifestHash, pending); }
    const committed = await pending;
    const item = committed?.items[Number(tokenId) - 1];
    if (!item || String(item.serial) !== tokenId || signal.aborted) return null;
    const record = await deps.record('media', item.metadataId);
    if (!record || remaining <= 0 || signal.aborted) return null;
    // Reserve before I/O so simultaneous resolutions cannot exceed the request budget.
    const maximum = Math.min(MAX_METADATA_BYTES, remaining);
    remaining -= maximum;
    let blob: { buffer: Buffer; mimeType: string };
    try { blob = await deps.media(item.metadataId, record, maximum, signal); }
    catch { return null; }
    if (signal.aborted || blob.buffer.length > maximum || blob.mimeType !== 'application/json'
      || createHash('sha256').update(blob.buffer).digest('hex') !== item.metadataHash) return null;
    remaining += maximum - blob.buffer.length;
    let value: unknown;
    try { value = JSON.parse(blob.buffer.toString('utf8')); } catch { return null; }
    const parsed = metadataItemSchema.safeParse(value);
    if (!parsed.success) return null;
    const metadata = parsed.data;
    let image: URL;
    try { image = new URL(metadata.image); } catch { return null; }
    const imagePath = `/api/media/${item.imageHash}.webp`;
    if (!isPublicMetadataOrigin(image.origin) || image.username || image.password || image.search || image.hash
      || image.pathname !== imagePath) return null;
    return {
      manifestHash, tokenId, name: metadata.name, description: metadata.description ?? '',
      imagePath, metadataPath: `/api/oneshot/metadata/${manifestHash}/${tokenId}`,
      attributes: (metadata.attributes ?? []).map(attribute => ({ trait_type: attribute.trait_type, value: attribute.value })),
    };
  }
  return (contentHash: string, tokenId: string): Promise<IndexedNftPresentation | null> => {
    if (signal.aborted || !/^0x[a-fA-F0-9]{64}$/.test(contentHash) || !/^[1-9]\d{0,3}$/.test(tokenId) || Number(tokenId) > 1000) return Promise.resolve(null);
    const manifestHash = contentHash.slice(2).toLowerCase(), key = `${manifestHash}:${tokenId}`;
    const existing = presentations.get(key);
    if (existing) return existing;
    if (presentations.size >= MAX_PRESENTATIONS) return Promise.resolve(null);
    const pending = resolve(manifestHash, tokenId);
    presentations.set(key, pending);
    return pending;
  };
}
