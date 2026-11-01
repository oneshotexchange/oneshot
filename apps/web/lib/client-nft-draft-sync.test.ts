import { describe, expect, it } from 'vitest';
import { accountDraftChanges } from './client-nft-draft-sync';
import { collectionAccountInput, type LocalCollectionDraft } from './client-oneshot-api';

const creator = `0x${'ab'.repeat(20)}`, nextCreator = `0x${'cd'.repeat(20)}`;
const draft: LocalCollectionDraft = {
  id: 'local-one', name: 'Originals', symbol: 'SHOT', description: 'Our collection', supply: '2', royalty: '5.5',
  price: '9007199254740993.000000000000000001', limit: '2', metadataMode: 'url', metadataUrl: 'https://example.com/manifest.json',
  fileNames: [], publicStart: '2026-11-01T12:00:17.123456Z', publicEnd: '2026-11-03T12:10:42.999999Z',
  allowlist: false, allowlistStart: '', allowlistEnd: '', allowlistPrice: '0', addresses: '', savedAt: '2026-10-31T12:00:00Z',
};
const uploadDraft: LocalCollectionDraft = { ...draft, metadataMode: 'upload', metadataUrl: '', fileNames: ['one.png', 'two.png'] };
const art = (letter: string) => ({ reference: `/api/media/${letter.repeat(64)}.webp`, url: `https://example.com/${letter}.webp`, hash: letter.repeat(64), size: 100 });
const uploadedInput = () => collectionAccountInput(uploadDraft, creator, [art('a'), art('b')]);

describe('saved NFT account version and artwork', () => {
  it('recognizes unchanged saved terms without comparing browser bookkeeping', () => {
    const input = collectionAccountInput(draft, creator);
    const current = { ...draft, id: 'account:remote', savedAt: '2026-11-01T00:00:00Z', name: '  Originals  ', symbol: ' SHOT ' };
    expect(accountDraftChanges(current, input, [], creator.toUpperCase().replace('0X', '0x'))).toEqual({ needsSave: false, needsArtUpload: false });
  });

  it.each([
    { name: 'Different originals' }, { symbol: 'NEW' }, { description: 'New description' }, { supply: '3' },
    { royalty: '5.6' }, { limit: '1' }, { metadataUrl: 'https://example.com/updated.json' },
    { publicEnd: '2026-11-03T12:10:43Z' },
  ])('requires an account save after changing collection terms: %j', changed => {
    expect(accountDraftChanges({ ...draft, ...changed }, collectionAccountInput(draft, creator), [], creator)).toEqual({ needsSave: true, needsArtUpload: false });
  });

  it('compares exact price and fractional schedule edits without rounding them away', () => {
    const input = collectionAccountInput(draft, creator);
    expect(accountDraftChanges({ ...draft, price: '9007199254740993.000000000000000002' }, input, [], creator).needsSave).toBe(true);
    expect(accountDraftChanges({ ...draft, publicStart: '2026-11-01T12:00:17.123457Z' }, input, [], creator).needsSave).toBe(true);
    expect(accountDraftChanges({ ...draft, publicStart: '2026-11-01T18:00:17.123456+06:00' }, input, [], creator).needsSave).toBe(false);
    expect(accountDraftChanges({ ...draft, publicStart: '2026-11-01T12:00:17.1234560Z' }, input, [], creator).needsSave).toBe(false);
  });

  it('requires saving a changed or removed creator wallet', () => {
    const input = collectionAccountInput(draft, creator);
    expect(accountDraftChanges(draft, input, [], nextCreator).needsSave).toBe(true);
    expect(accountDraftChanges(draft, input, []).needsSave).toBe(true);
  });

  it('detects allowlist recipients and exact allowlist-price edits', () => {
    const allowlist = { ...draft, allowlist: true, allowlistStart: '2026-11-01T10:00:00Z', allowlistEnd: '2026-11-01T11:00:00Z', addresses: creator, allowlistPrice: '0.000000000000000001' };
    const input = collectionAccountInput(allowlist, creator);
    expect(accountDraftChanges({ ...allowlist, addresses: `${creator.toUpperCase().replace('0X', '0x')}, ${creator}` }, input, [], creator).needsSave).toBe(false);
    expect(accountDraftChanges({ ...allowlist, addresses: nextCreator }, input, [], creator).needsSave).toBe(true);
    expect(accountDraftChanges({ ...allowlist, allowlistPrice: '0.000000000000000002' }, input, [], creator).needsSave).toBe(true);
  });

  it('keeps unchanged uploaded art references without mutating the saved account input', () => {
    const input = uploadedInput(), before = JSON.stringify(input);
    expect(accountDraftChanges(uploadDraft, input, uploadDraft.fileNames, creator)).toEqual({ needsSave: false, needsArtUpload: false });
    expect(JSON.stringify(input)).toBe(before);
    const single = { ...uploadDraft, fileNames: ['edition.png'] };
    const singleInput = collectionAccountInput(single, creator, [art('a')]);
    expect(accountDraftChanges(single, singleInput, single.fileNames, creator)).toEqual({ needsSave: false, needsArtUpload: false });
  });

  it.each([{ fileNames: ['replacement.png', 'two.png'] }, { fileNames: ['two.png', 'one.png'] }, { fileNames: ['one.png'] }])('requires upload when image selection changes even with the same count: %j', ({ fileNames }) => {
    expect(accountDraftChanges({ ...uploadDraft, fileNames }, uploadedInput(), uploadDraft.fileNames, creator)).toEqual({ needsSave: true, needsArtUpload: true });
  });

  it('requires uploading newly selected image bytes even when filenames are unchanged', () => {
    expect(accountDraftChanges(uploadDraft, uploadedInput(), uploadDraft.fileNames, creator, true)).toEqual({ needsSave: true, needsArtUpload: true });
    expect(accountDraftChanges(draft, collectionAccountInput(draft, creator), [], creator, true)).toEqual({ needsSave: false, needsArtUpload: false });
  });

  it('requires uploading selected images when the account has no uploaded references', () => {
    expect(accountDraftChanges(uploadDraft, collectionAccountInput(uploadDraft, creator), uploadDraft.fileNames, creator)).toEqual({ needsSave: true, needsArtUpload: true });
  });

  it('compares metadata mode and ignores filename bookkeeping for URL metadata', () => {
    const input = collectionAccountInput(draft, creator);
    expect(accountDraftChanges({ ...draft, fileNames: ['ignored.png'] }, input, ['old.png'], creator)).toEqual({ needsSave: false, needsArtUpload: false });
    expect(accountDraftChanges(uploadDraft, input, [], creator)).toEqual({ needsSave: true, needsArtUpload: true });
    expect(accountDraftChanges(draft, uploadedInput(), uploadDraft.fileNames, creator)).toEqual({ needsSave: true, needsArtUpload: false });
  });

  it.each([{ symbol: '' }, { publicEnd: '' }, { price: 'not a price' }, { supply: '0' }, { publicEnd: '2026-02-30T12:00:00Z' }])('keeps preparation blocked for invalid current fields: %j', changed => {
    expect(accountDraftChanges({ ...draft, ...changed }, collectionAccountInput(draft, creator), [], creator).needsSave).toBe(true);
  });
});
