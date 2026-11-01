import { collectionAccountInput, type LocalCollectionDraft } from './client-oneshot-api';
import { oneshotDraftSchema, type OneshotDraftInput } from './oneshot-draft-schema';

export type AccountDraftChanges = { needsSave: boolean; needsArtUpload: boolean };

// Date retains only milliseconds. Compare the UTC second and the original
// fractional digits separately so sub-millisecond schedule edits are not lost.
function schedule(value: string): string {
  const fraction = (value.match(/\.(\d+)/)?.[1] || '').replace(/0+$/, '');
  return new Date(value).toISOString().slice(0, 19) + (fraction ? `.${fraction}` : '') + 'Z';
}

function comparable(input: OneshotDraftInput): string {
  const value = oneshotDraftSchema.parse(input);
  value.publicStart = schedule(value.publicStart);
  value.publicEnd = schedule(value.publicEnd);
  if (value.allowlistStart) value.allowlistStart = schedule(value.allowlistStart);
  if (value.allowlistEnd) value.allowlistEnd = schedule(value.allowlistEnd);
  value.allowlistAddresses = [...new Set(value.allowlistAddresses.map(address => address.toLowerCase()))];
  if (value.creatorWallet) value.creatorWallet = value.creatorWallet.toLowerCase();
  if (value.metadataMode === 'url') { delete value.imageUrl; delete value.manifest; }
  else delete value.metadataUrl;
  // Schema parsing gives the fields a stable order; prices stay exact strings.
  return JSON.stringify(value);
}

/** Preparation must use the saved account version, including its selected art. */
export function accountDraftChanges(draft: LocalCollectionDraft, input: OneshotDraftInput, savedFileNames: readonly string[], creatorWallet?: string, artworkChanged = false): AccountDraftChanges {
  const upload = draft.metadataMode === 'upload';
  const sameFiles = draft.fileNames.length === savedFileNames.length && draft.fileNames.every((name, index) => name === savedFileNames[index]);
  const savedArt = input.metadataMode === 'upload' && Boolean(input.imageUrl || input.manifest?.items.length);
  const needsArtUpload = upload && (artworkChanged || !sameFiles || draft.fileNames.length > 0 && !savedArt);
  try {
    const current = collectionAccountInput(draft, creatorWallet);
    if (upload && input.metadataMode === 'upload') {
      if (input.imageUrl) current.imageUrl = input.imageUrl;
      if (input.manifest) current.manifest = input.manifest;
    }
    return { needsSave: needsArtUpload || comparable(current) !== comparable(input), needsArtUpload };
  } catch {
    return { needsSave: true, needsArtUpload };
  }
}
