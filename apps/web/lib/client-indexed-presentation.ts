import type { IndexedNftPresentation } from '@oneshot/evm';
import { apiUrl } from './api-url';

export type IndexedPresentation = IndexedNftPresentation & { imageUrl: string; metadataUrl: string };

/** Only retained snapshot paths may become browser requests; metadata never supplies an origin. */
export function indexedPresentation(value: IndexedNftPresentation | null | undefined, expectedTokenId: string): IndexedPresentation | null {
  if (!value || typeof value.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestHash)
    || typeof value.tokenId !== 'string' || !/^[1-9]\d{0,77}$/.test(value.tokenId)
    || value.tokenId !== expectedTokenId || BigInt(value.tokenId) >= (1n << 256n)
    || typeof value.imagePath !== 'string' || !/^\/api\/media\/[a-f0-9]{64}\.webp$/.test(value.imagePath)
    || value.metadataPath !== `/api/oneshot/metadata/${value.manifestHash}/${value.tokenId}`
    || typeof value.name !== 'string' || typeof value.description !== 'string'
    || !Array.isArray(value.attributes) || value.attributes.some(trait => !trait || typeof trait.trait_type !== 'string'
      || !(typeof trait.value === 'string' || typeof trait.value === 'number' && Number.isFinite(trait.value)))) return null;
  try {
    return { ...value, imageUrl: apiUrl(value.imagePath), metadataUrl: apiUrl(value.metadataPath) };
  } catch { return null; }
}
