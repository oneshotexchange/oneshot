import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNftPublicContentResolver } from './nft-public-content';
import { stableJson } from './media';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const imageHash = sha('sanitized art');
function fixture(metadataChanges: Record<string, unknown> = {}, count = 1) {
  const blobs = new Map<string, { buffer: Buffer; mimeType: string }>();
  const items = Array.from({ length: count }, (_, index) => {
    const metadata = { name: `Original #${index + 1}`, description: 'A committed original.',
      image: `https://api.oneshot.app/api/media/${imageHash}.webp`, attributes: [{ trait_type: 'Edition', value: index + 1 }], ...metadataChanges };
    const buffer = Buffer.from(stableJson(metadata)), metadataHash = sha(buffer), metadataId = `${metadataHash}.json`;
    blobs.set(metadataId, { buffer, mimeType: 'application/json' });
    return { serial: index + 1, metadataId, metadataHash, imageHash };
  });
  const manifestHash = sha(stableJson({ items }));
  const snapshot = { manifestHash, items, createdAt: '2026-10-26T00:00:00Z', ownerUserId: 'private-account' };
  const record = vi.fn(async (namespace: string, id: string): Promise<unknown> => namespace === 'oneshot_snapshots'
    ? id === manifestHash ? snapshot : null
    : namespace === 'media' && blobs.has(id) ? { mimeType: 'application/json', size: blobs.get(id)!.buffer.length, owner: 'private-account' } : null);
  const media = vi.fn(async (id: string) => blobs.get(id)!);
  return { manifestHash, contentHash: `0x${manifestHash}`, snapshot, blobs, record, media,
    resolver: createNftPublicContentResolver({ record, media }) };
}

describe('canonical NFT snapshot presentation', () => {
  it('returns only committed item fields and local API paths without reading private records or image bytes', async () => {
    const value = fixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await value.resolver(value.contentHash, '1');
      expect(result).toEqual({ manifestHash: value.manifestHash, tokenId: '1', name: 'Original #1', description: 'A committed original.',
        attributes: [{ trait_type: 'Edition', value: 1 }], imagePath: `/api/media/${imageHash}.webp`, metadataPath: `/api/oneshot/metadata/${value.manifestHash}/1` });
      expect(JSON.stringify(result)).not.toMatch(/private-account|ownerUserId|createdAt|allowlist|session|revision/);
      expect(value.record.mock.calls).toEqual([['oneshot_snapshots', value.manifestHash], ['media', value.snapshot.items[0].metadataId]]);
      expect(value.media).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('deduplicates simultaneous requests and shares a manifest only within this response', async () => {
    const value = fixture({}, 2);
    const results = await Promise.all([value.resolver(value.contentHash, '1'), value.resolver(value.contentHash, '1'), value.resolver(value.contentHash.toUpperCase().replace('0X', '0x'), '2')]);
    expect(results[0]).toEqual(results[1]); expect(results[2]?.name).toBe('Original #2');
    expect(value.record.mock.calls.filter(([namespace]) => namespace === 'oneshot_snapshots')).toHaveLength(1);
    expect(value.media).toHaveBeenCalledTimes(2);
    value.blobs.get(value.snapshot.items[0].metadataId)!.buffer = Buffer.from('altered after response');
    const fresh = createNftPublicContentResolver({ record: value.record, media: value.media });
    expect(await fresh(value.contentHash, '1')).toBeNull();
  });

  it.each(['0', '01', '-1', '1.5', '1001', '99999', '../1'])('refuses invalid serial %s before storage', async serial => {
    const value = fixture(); expect(await value.resolver(value.contentHash, serial)).toBeNull(); expect(value.record).not.toHaveBeenCalled();
  });
  it.each(['', 'abc', `0x${'g'.repeat(64)}`, 'https://private-rpc/key'])('refuses invalid commitment %s before storage', async contentHash => {
    const value = fixture(); expect(await value.resolver(contentHash, '1')).toBeNull(); expect(value.record).not.toHaveBeenCalled();
  });

  it('keeps unavailable and out-of-range metadata absent without consulting a draft', async () => {
    const value = fixture();
    expect(await value.resolver(`0x${sha('unknown snapshot')}`, '1')).toBeNull();
    expect(await value.resolver(value.contentHash, '2')).toBeNull();
    expect(value.media).not.toHaveBeenCalled();
  });
  it.each(['imageHash', 'metadataHash', 'metadataId', 'serial', 'manifestHash'])('rejects a changed snapshot %s', async field => {
    const value = fixture();
    if (field === 'manifestHash') value.snapshot.manifestHash = sha('different');
    else Object.assign(value.snapshot.items[0], { [field]: field === 'serial' ? 2 : sha('different') + (field === 'metadataId' ? '.json' : '') });
    expect(await value.resolver(value.contentHash, '1')).toBeNull(); expect(value.media).not.toHaveBeenCalled();
  });

  it('rejects bytes that no longer match the metadata commitment', async () => {
    const value = fixture(); value.blobs.get(value.snapshot.items[0].metadataId)!.buffer = Buffer.from('{"name":"swapped"}');
    expect(await value.resolver(value.contentHash, '1')).toBeNull();
  });
  it('rejects unexpected MIME and missing metadata without losing the resolver contract', async () => {
    const value = fixture(); value.blobs.get(value.snapshot.items[0].metadataId)!.mimeType = 'text/html';
    expect(await value.resolver(value.contentHash, '1')).toBeNull();
    const missing = fixture(); missing.media.mockRejectedValue(new Error('object missing, private provider details'));
    expect(await missing.resolver(missing.contentHash, '1')).toBeNull();
  });
  it('does not hide a failed SQL transaction as absent content', async () => {
    const record = vi.fn().mockRejectedValue(new Error('query aborted'));
    const resolver = createNftPublicContentResolver({ record });
    await expect(resolver(`0x${sha('manifest')}`, '1')).rejects.toThrow('query aborted');
  });
  it('stops new content work after the response deadline is cancelled', async () => {
    const value = fixture(); const controller = new AbortController(); controller.abort();
    const resolver = createNftPublicContentResolver({ record: value.record, media: value.media, signal: controller.signal });
    expect(await resolver(value.contentHash, '1')).toBeNull(); expect(value.record).not.toHaveBeenCalled();
  });

  it.each([
    'https://tracker.attacker.com/image.webp', `http://api.oneshot.app/api/media/${imageHash}.webp`,
    `https://api.oneshot.app/api/media/${sha('swapped art')}.webp`, `https://api.oneshot.app/api/media/${imageHash}.webp?track=1`,
    `https://user:secret@api.oneshot.app/api/media/${imageHash}.webp`, `https://api.oneshot.app/api/media/${imageHash}.webp#fragment`,
    `https://127.0.0.1/api/media/${imageHash}.webp`, `data:image/svg+xml,<svg/>`,
  ])('refuses a committed image URL outside the exact sanitized art mapping: %s', async image => {
    const value = fixture({ image }); expect(await value.resolver(value.contentHash, '1')).toBeNull();
  });
  it.each([{ ownerUserId: 'secret' }, { attributes: [{ trait_type: 'HTML', value: { html: '<script>' } }] }, { name: 'n'.repeat(101) }])(
    'rejects unrecognized or malformed metadata fields', async changes => {
      const value = fixture(changes); expect(await value.resolver(value.contentHash, '1')).toBeNull();
    },
  );
  it('accepts strings as plain display text and never turns them into a destination', async () => {
    const value = fixture({ name: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>', attributes: [{ trait_type: '<b>Trait</b>', value: 'javascript:alert(1)' }] });
    expect(await value.resolver(value.contentHash, '1')).toMatchObject({ name: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>', attributes: [{ trait_type: '<b>Trait</b>', value: 'javascript:alert(1)' }] });
  });

  it('caps unique presentations and metadata I/O per response', async () => {
    const value = fixture({}, 60);
    const results = [];
    for (let serial = 1; serial <= 60; serial++) results.push(await value.resolver(value.contentHash, String(serial)));
    expect(results.slice(0, 50).every(Boolean)).toBe(true); expect(results.slice(50)).toEqual(Array(10).fill(null));
    expect(value.media).toHaveBeenCalledTimes(50);
    const oversized = fixture(); const id = oversized.snapshot.items[0].metadataId;
    oversized.blobs.get(id)!.buffer = Buffer.alloc(256 * 1024 + 1);
    expect(await oversized.resolver(oversized.contentHash, '1')).toBeNull();
  });
});
