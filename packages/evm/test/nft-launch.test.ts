import { describe, expect, it } from 'vitest';
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, padHex, parseAbiParameters, toFunctionSelector, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { UINT256_MAX } from '../src/economics';
import { NFT_ALLOWLIST_DOMAIN, NFT_COLLECTION_ABI, NFT_FACTORY_ABI, NFT_MARKETPLACE_ABI, NftLaunchError, nftAllowlistLeaf, prepareNftTerms, type NftLaunchDraft, type NftTermsContext } from '../src/nft-launch';

const creator = '0x1111111111111111111111111111111111111111' as Address;
const collection = '0x2222222222222222222222222222222222222222' as Address;
const wallets = [
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '0xcccccccccccccccccccccccccccccccccccccccc',
  '0xdddddddddddddddddddddddddddddddddddddddd',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
] as const;
const context: NftTermsContext = { chainId: 31337, nativeDecimals: 18, collection, nowSeconds: 1_792_713_600n };
const manifestHash = 'ab'.repeat(32);
function draft(changes: Partial<NftLaunchDraft> = {}): NftLaunchDraft {
  return {
    status: 'prepared', name: 'Oneshot Editions', symbol: 'ONE', maxSupply: 10, royaltyBps: 500,
    publicPrice: '0.123456789012345678', allowlistPrice: '0.01', perWalletLimit: 2,
    publicStart: '2026-11-01T00:00:00Z', publicEnd: '2026-11-02T00:00:00Z',
    allowlistAddresses: [], creatorWallet: creator,
    snapshot: { manifestHash, contentHash: `0x${manifestHash}`, baseUri: `https://oneshot.example/api/oneshot/metadata/${manifestHash}/`, collectionUri: 'ipfs://bafycollection/collection.json', itemCount: 10 },
    ...changes,
  };
}
function allowlisted(addresses: readonly string[] = wallets): NftLaunchDraft {
  return draft({ allowlistAddresses: addresses, allowlistStart: '2026-10-31T00:00:00Z', allowlistEnd: '2026-11-01T00:00:00Z' });
}
function expectCode(run: () => unknown, code: string) {
  try { run(); throw new Error('Expected launch planning to reject input'); }
  catch (error) { expect(error).toBeInstanceOf(NftLaunchError); expect((error as NftLaunchError).code).toBe(code); }
}
// This verifier deliberately works from raw ABI words rather than the planner's leaf/tree helpers.
function solidityLeaf(chainId: number, contract: Address, wallet: Address): Hex {
  const words = concatHex([NFT_ALLOWLIST_DOMAIN, padHex(`0x${BigInt(chainId).toString(16)}`), padHex(contract), padHex(wallet)]);
  return keccak256(keccak256(words));
}
function verify(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  return proof.reduce((node, sibling) => keccak256(concatHex(node < sibling ? [node, sibling] : [sibling, node])), leaf) === root;
}

describe('exact NFT contract terms', () => {
  it('encodes and hashes Solidity abi.encode(Terms) with its widths and nested stage order', () => {
    const planned = prepareNftTerms(allowlisted(wallets.slice(0, 3)), context);
    const terms = planned.terms;
    const independentlyEncoded = encodeAbiParameters(
      parseAbiParameters('(uint64,uint16,bytes32,bytes32,string,string,(uint64,uint64,uint64,uint256),(uint64,uint64,uint64,uint256))'),
      [[10n, 500, terms.allowlistRoot, `0x${manifestHash}`, terms.metadataBaseURI, terms.collectionURI,
        [1_793_404_800n, 1_793_491_200n, 2n, 10_000_000_000_000_000n],
        [1_793_491_200n, 1_793_577_600n, 2n, 123_456_789_012_345_678n]]],
    );
    expect(planned.termsHash).toBe(keccak256(independentlyEncoded));
    const call = encodeFunctionData({ abi: NFT_COLLECTION_ABI, functionName: 'configure', args: [terms] });
    expect(call.slice(0, 10)).toBe(toFunctionSelector('configure((uint64,uint16,bytes32,bytes32,string,string,(uint64,uint64,uint64,uint256),(uint64,uint64,uint64,uint256)))'));
    expect(call.slice(10)).toBe(independentlyEncoded.slice(2));
    expect(decodeFunctionData({ abi: NFT_COLLECTION_ABI, data: call })).toMatchObject({ functionName: 'configure', args: [terms] });
    expect(planned.summary).toMatchObject({ creator, collection, nativeDecimals: 18, publicPriceRaw: 123_456_789_012_345_678n, allowlistPriceRaw: 10_000_000_000_000_000n });
  });

  it('uses every uint256 bit without floating point and rejects overflow', () => {
    const large = prepareNftTerms(draft({ publicPrice: UINT256_MAX.toString() }), { ...context, nativeDecimals: 0 });
    expect(large.terms.publicMint.price).toBe(UINT256_MAX);
    expectCode(() => prepareNftTerms(draft({ publicPrice: (UINT256_MAX + 1n).toString() }), { ...context, nativeDecimals: 0 }), 'INVALID_PRICE');
    const precise = prepareNftTerms(draft({ publicPrice: '9007199254740993.000000000000000001' }), context);
    expect(precise.terms.publicMint.price).toBe(9_007_199_254_740_993_000_000_000_000_000_001n);
  });

  it('requires verified precision and rejects excess fractional digits even when zero', () => {
    expectCode(() => prepareNftTerms(draft(), { ...context, nativeDecimals: null }), 'UNKNOWN_PRECISION');
    for (const nativeDecimals of [-1, 39, 1.5, NaN]) expectCode(() => prepareNftTerms(draft(), { ...context, nativeDecimals }), 'UNKNOWN_PRECISION');
    for (const value of ['1.0000000', '0.0000001']) expectCode(() => prepareNftTerms(draft({ publicPrice: value }), { ...context, nativeDecimals: 6 }), 'INVALID_PRICE');
    for (const value of ['-1', '+1', '.1', '1.', '1e18', '01', ' NaN', ' 1']) expectCode(() => prepareNftTerms(draft({ publicPrice: value }), context), 'INVALID_PRICE');
    expect(prepareNftTerms(draft({ publicPrice: '1.000001' }), { ...context, nativeDecimals: 6 }).terms.publicMint.price).toBe(1_000_001n);
  });

  it('commits a zero allowlist stage when the allowlist is disabled', () => {
    const result = prepareNftTerms(draft(), context);
    expect(result.allowlist).toEqual({ root: zeroHash, addresses: [], proofs: {} });
    expect(result.terms.allowlist).toEqual({ start: 0n, end: 0n, walletLimit: 0n, price: 0n });
    expect(result.summary.allowlistPriceRaw).toBe(0n);
    expectCode(() => prepareNftTerms(draft({ allowlistStart: '2026-10-31T00:00:00Z' }), context), 'INVALID_ALLOWLIST');
  });

  it('exposes the reviewed factory, collection, and marketplace calls', () => {
    expect(encodeFunctionData({ abi: NFT_FACTORY_ABI, functionName: 'createCollection', args: ['Oneshot', 'ONE'] }).slice(0, 10)).toBe(toFunctionSelector('createCollection(string,string)'));
    expect(encodeFunctionData({ abi: NFT_COLLECTION_ABI, functionName: 'mint', args: [2n, creator, 7n, []] }).slice(0, 10)).toBe(toFunctionSelector('mint(uint256,address,uint256,bytes32[])'));
    expect(encodeFunctionData({ abi: NFT_COLLECTION_ABI, functionName: 'open' }).slice(0, 10)).toBe(toFunctionSelector('open()'));
    expect(encodeFunctionData({ abi: NFT_MARKETPLACE_ABI, functionName: 'list', args: [collection, 1n, 99n] }).slice(0, 10)).toBe(toFunctionSelector('list(address,uint256,uint256)'));
    expect(encodeFunctionData({ abi: NFT_MARKETPLACE_ABI, functionName: 'buy', args: [1n, 99n, creator] }).slice(0, 10)).toBe(toFunctionSelector('buy(uint256,uint256,address)'));
    expect(encodeFunctionData({ abi: NFT_MARKETPLACE_ABI, functionName: 'cancelTo', args: [1n, creator] }).slice(0, 10)).toBe(toFunctionSelector('cancelTo(uint256,address)'));
    expect(encodeFunctionData({ abi: NFT_MARKETPLACE_ABI, functionName: 'claimTo', args: [creator] }).slice(0, 10)).toBe(toFunctionSelector('claimTo(address)'));
    expect(NFT_COLLECTION_ABI.find(item => item.type === 'function' && item.name === 'mint')).toMatchObject({ stateMutability: 'payable' });
    expect(NFT_MARKETPLACE_ABI.find(item => item.type === 'function' && item.name === 'buy')).toMatchObject({ stateMutability: 'payable' });
  });
});

describe('collection- and chain-bound OpenZeppelin Merkle proofs', () => {
  it.each([1, 2, 3, 5])('verifies every leaf for %i wallets, including promoted odd nodes', (count) => {
    const result = prepareNftTerms(allowlisted(wallets.slice(0, count)), context);
    for (const wallet of result.allowlist.addresses) {
      const leaf = solidityLeaf(context.chainId, collection, wallet);
      expect(nftAllowlistLeaf(context.chainId, collection, wallet)).toBe(leaf);
      expect(verify(result.allowlist.root, leaf, result.allowlist.proofs[wallet]!)).toBe(true);
      expect(verify(result.allowlist.root, solidityLeaf(context.chainId + 1, collection, wallet), result.allowlist.proofs[wallet]!)).toBe(false);
    }
    if (count === 1) {
      expect(result.allowlist.root).toBe(solidityLeaf(context.chainId, collection, wallets[0]));
      expect(result.allowlist.proofs[wallets[0]]).toEqual([]);
    }
  });

  it('normalizes and deduplicates wallets deterministically before building proofs', () => {
    const upperWallet = `0x${wallets[0].slice(2).toUpperCase()}`;
    const a = prepareNftTerms(allowlisted([wallets[2], upperWallet, wallets[1], wallets[0]]), context);
    const b = prepareNftTerms(allowlisted(wallets.slice(0, 3)), context);
    expect(a.allowlist).toEqual(b.allowlist);
    expect(a.termsHash).toBe(b.termsHash);
  });

  it('does not reuse roots or proofs across collections or chains', () => {
    const a = prepareNftTerms(allowlisted(), context);
    const b = prepareNftTerms(allowlisted(), { ...context, chainId: context.chainId + 1 });
    const c = prepareNftTerms(allowlisted(), { ...context, collection: creator });
    expect(new Set([a.allowlist.root, b.allowlist.root, c.allowlist.root]).size).toBe(3);
    expect(new Set([a.termsHash, b.termsHash, c.termsHash]).size).toBe(3);
    expect(verify(c.allowlist.root, solidityLeaf(context.chainId, collection, wallets[0]), a.allowlist.proofs[wallets[0]]!)).toBe(false);
    expect(verify(a.allowlist.root, solidityLeaf(context.chainId, collection, creator), a.allowlist.proofs[wallets[0]]!)).toBe(false);
    const altered = [...a.allowlist.proofs[wallets[0]]!]; altered[0] = zeroHash;
    expect(verify(a.allowlist.root, solidityLeaf(context.chainId, collection, wallets[0]), altered)).toBe(false);
  });

  it('rejects malformed and zero wallets rather than silently dropping them', () => {
    for (const value of [zeroAddress, '0x123', 'bad', '0x' + 'z'.repeat(40)]) expectCode(() => prepareNftTerms(allowlisted([value]), context), 'INVALID_ADDRESS');
    expectCode(() => prepareNftTerms(allowlisted(Array(10_001).fill(wallets[0])), context), 'INVALID_ALLOWLIST');
  });
});

describe('launch planning fails closed for incomplete or expired drafts', () => {
  it('requires a prepared snapshot, creator, and Solidity byte-limited identity', () => {
    for (const status of ['draft', 'deleted', 'unknown']) expectCode(() => prepareNftTerms(draft({ status }), context), 'DRAFT_NOT_PREPARED');
    for (const symbol of [undefined, '', ' ', 'a'.repeat(21), 'é'.repeat(11), 'ONE\n']) expectCode(() => prepareNftTerms(draft({ symbol }), context), 'INVALID_IDENTITY');
    for (const name of ['', 'a'.repeat(101), 'é'.repeat(51), ' Oneshot']) expectCode(() => prepareNftTerms(draft({ name }), context), 'INVALID_IDENTITY');
    for (const creatorWallet of [undefined, zeroAddress, '0x123']) expectCode(() => prepareNftTerms(draft({ creatorWallet }), context), 'INVALID_ADDRESS');
    expect(prepareNftTerms(draft({ name: 'é'.repeat(50), symbol: 'é'.repeat(10) }), context).summary.symbol).toBe('é'.repeat(10));
  });

  it('checks chain, uint64 ranges, wallet limits, and royalty bounds', () => {
    for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expectCode(() => prepareNftTerms(draft(), { ...context, chainId }), 'INVALID_CHAIN');
    for (const nowSeconds of [-1n, 1n << 64n]) expectCode(() => prepareNftTerms(draft(), { ...context, nowSeconds }), 'INVALID_SCHEDULE');
    expectCode(() => prepareNftTerms(draft(), { ...context, collection: zeroAddress }), 'INVALID_ADDRESS');
    for (const maxSupply of [0, -1, 1.5, Number((1n << 64n) - 1n), NaN]) expectCode(() => prepareNftTerms(draft({ maxSupply }), context), 'INVALID_INTEGER');
    for (const perWalletLimit of [0, 11, 1.5]) expectCode(() => prepareNftTerms(draft({ perWalletLimit }), context), 'INVALID_INTEGER');
    for (const royaltyBps of [-1, 1001, 0.5, NaN]) expectCode(() => prepareNftTerms(draft({ royaltyBps }), context), 'INVALID_ROYALTY');
  });

  it('checks snapshot count, nonzero content commitment, and committed URI syntax', () => {
    const valid = draft().snapshot!;
    expectCode(() => prepareNftTerms(draft({ snapshot: undefined }), context), 'INVALID_SNAPSHOT');
    for (const changes of [{ itemCount: 9 }, { contentHash: zeroHash }, { contentHash: `0x${'cd'.repeat(32)}` }, { manifestHash: 'not-a-hash' }]) expectCode(() => prepareNftTerms(draft({ snapshot: { ...valid, ...changes } }), context), 'INVALID_SNAPSHOT');
    for (const baseUri of ['http://oneshot.example/', 'https://oneshot.example', 'https://user:pass@oneshot.example/', 'https://oneshot.example/#x', 'https://oneshot.example/?x=1', 'ipfs://', 'https://oneshot.example/a b/', 'https://oneshot.example/' + 'a'.repeat(2048) + '/']) expectCode(() => prepareNftTerms(draft({ snapshot: { ...valid, baseUri } }), context), 'INVALID_SNAPSHOT');
    expect(prepareNftTerms(draft({ snapshot: { ...valid, baseUri: 'ar://immutable-transaction/' } }), context).terms.metadataBaseURI).toBe('ar://immutable-transaction/');
  });

  it('requires explicit, valid whole-second dates and ordered non-overlapping stages', () => {
    for (const publicStart of [undefined, '2026-11-01', '2026-11-01T00:00:00', '2026-11-01T00:00:00.001Z', '2026-02-30T00:00:00Z', '99999-11-01T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T00:00:00+24:00']) expectCode(() => prepareNftTerms(draft({ publicStart }), context), 'INVALID_SCHEDULE');
    expectCode(() => prepareNftTerms(draft({ publicEnd: '2026-11-01T00:00:00Z' }), context), 'INVALID_SCHEDULE');
    expectCode(() => prepareNftTerms(allowlisted(), { ...context, nowSeconds: 1_793_404_801n }), 'SCHEDULE_EXPIRED');
    expectCode(() => prepareNftTerms({ ...allowlisted(), allowlistStart: undefined }, context), 'INVALID_SCHEDULE');
    expectCode(() => prepareNftTerms({ ...allowlisted(), allowlistEnd: '2026-11-01T00:00:01Z' }, context), 'INVALID_SCHEDULE');
    expectCode(() => prepareNftTerms({ ...allowlisted(), allowlistEnd: '2026-10-31T00:00:00Z' }, context), 'INVALID_SCHEDULE');
    const equalBoundary = prepareNftTerms(allowlisted(), { ...context, nowSeconds: 1_793_404_800n });
    expect(equalBoundary.summary.firstStart).toBe(1_793_404_800n);
    const utc = prepareNftTerms(draft({ publicStart: '2026-11-01T06:00:00.000+06:00' }), context);
    expect(utc.terms.publicMint.start).toBe(1_793_491_200n);
  });
});
