import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './errors';
import { stableJson } from './media';

const snapshotItem = z.object({
  serial: z.number().int().min(1).max(1000),
  metadataId: z.string().regex(/^[a-f0-9]{64}\.json$/),
  metadataHash: z.string().regex(/^[a-f0-9]{64}$/),
  imageHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const snapshotRecord = z.object({ manifestHash: z.string(), items: z.array(snapshotItem).min(1).max(1000) });

/** The same immutable serial-to-metadata/art commitment is used for launch and display. */
export function verifiedNftSnapshot(value: unknown, manifestHash: string) {
  const parsed = snapshotRecord.safeParse(value);
  if (!/^[a-f0-9]{64}$/.test(manifestHash) || !parsed.success || parsed.data.manifestHash !== manifestHash
    || parsed.data.items.some((item, index) => item.serial !== index + 1 || item.metadataId !== `${item.metadataHash}.json`)
    || createHash('sha256').update(stableJson({ items: parsed.data.items })).digest('hex') !== manifestHash) {
    throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored metadata commitment failed its content check.');
  }
  return parsed.data;
}
