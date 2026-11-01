import { describe, expect, it } from 'vitest';
import { zeroAddress, zeroHash } from 'viem';
import { manifestId, manifestJson, parseManifest } from '../src/manifest';
import type { Manifest } from '../src/types';

const input = () => ({
  schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: `0x${'ab'.repeat(32)}`, startBlock: '12', anchorHash: `0x${'cd'.repeat(32)}`,
  factory: { address: `0x${'ab'.repeat(20)}`, codeHash: `0x${'ef'.repeat(32)}` },
  marketplace: { address: `0x${'cd'.repeat(20)}`, codeHash: `0x${'ac'.repeat(32)}` },
});
const upperHex = (value: string) => `0x${value.slice(2).toUpperCase()}`;

describe('local deployment manifest', () => {
  it('normalizes hex fields and losslessly round-trips decimal block numbers', () => {
    const json = input();
    json.startBlock = '18446744073709551615';
    json.genesisHash = upperHex(json.genesisHash);
    json.anchorHash = upperHex(json.anchorHash);
    json.factory = { address: upperHex(json.factory.address), codeHash: upperHex(json.factory.codeHash) };
    const parsed = parseManifest(json);
    expect(parsed.startBlock).toBe(18_446_744_073_709_551_615n);
    expect(parsed.genesisHash).toBe(input().genesisHash);
    expect(parsed.factory).toEqual(input().factory);
    expect(parseManifest(manifestJson(parsed))).toEqual(parsed);
  });

  it('fingerprints a canonical representation independent of property order and hex casing', () => {
    const canonical = parseManifest(input());
    const json = input();
    const equivalent = parseManifest({
      marketplace: { codeHash: upperHex(json.marketplace.codeHash), address: upperHex(json.marketplace.address) },
      factory: { codeHash: upperHex(json.factory.codeHash), address: upperHex(json.factory.address) },
      anchorHash: upperHex(json.anchorHash), startBlock: json.startBlock, genesisHash: upperHex(json.genesisHash),
      chainId: json.chainId, mode: json.mode, deploymentVersion: json.deploymentVersion, schemaVersion: json.schemaVersion,
    });
    expect(manifestId(equivalent)).toBe(manifestId(canonical));
    expect(manifestId(canonical)).toMatch(/^[\da-f]{64}$/);
  });

  it.each([
    { mode: 'zero' }, { chainId: 1 }, { schemaVersion: 2 }, { deploymentVersion: 'oneshot-nft-v2' },
    { startBlock: '0' }, { startBlock: '-1' }, { startBlock: '01' }, { startBlock: '1.5' },
    { startBlock: 12 }, { startBlock: '100000000000000000000' }, { genesisHash: '0xab' },
    { anchorHash: null }, { extra: 'unreviewed' },
  ])('rejects unsupported or malformed manifest fields: %j', patch => {
    expect(() => parseManifest({ ...input(), ...patch })).toThrow('MANIFEST_INVALID');
  });

  it.each([
    { address: zeroAddress, codeHash: input().factory.codeHash },
    { address: '0x123', codeHash: input().factory.codeHash },
    { address: input().factory.address, codeHash: '0x12' },
    { ...input().factory, extra: 'unreviewed' },
  ])('rejects invalid contract identities: %j', factory => {
    expect(() => parseManifest({ ...input(), factory })).toThrow('MANIFEST_INVALID');
  });

  it('requires distinct factory and marketplace addresses', () => {
    const json = input();
    json.marketplace.address = json.factory.address;
    expect(() => parseManifest(json)).toThrow('MANIFEST_INVALID');
  });

  it('binds the fingerprint to the entire deployment identity', () => {
    const canonical = parseManifest(input());
    const variations = [
      { ...canonical, startBlock: 13n }, { ...canonical, genesisHash: canonical.anchorHash },
      { ...canonical, anchorHash: canonical.genesisHash },
      { ...canonical, factory: { ...canonical.factory, codeHash: canonical.marketplace.codeHash } },
      { ...canonical, marketplace: { ...canonical.marketplace, codeHash: canonical.factory.codeHash } },
      { ...canonical, factory: { ...canonical.factory, address: `0x${'11'.repeat(20)}` as const } },
    ];
    for (const variation of variations) expect(manifestId(variation)).not.toBe(manifestId(canonical));
  });

  it('revalidates a programmatically supplied manifest before creating a cursor identity', () => {
    const canonical = parseManifest(input());
    expect(() => manifestId({ ...canonical, mode: 'zero' } as unknown as Manifest)).toThrow('MANIFEST_INVALID');
  });

  it('requires the guarded v2 authority and deployment salt and binds both to cursor identity', () => {
    const listingAuthorization = { authority: `0x${'de'.repeat(20)}`, salt: `0x${'fa'.repeat(32)}` };
    const json = { ...input(), deploymentVersion: 'oneshot-nft-v2', listingAuthorization };
    const parsed = parseManifest(json);
    expect(parsed.deploymentVersion).toBe('oneshot-nft-v2');
    expect(parseManifest(manifestJson(parsed))).toEqual(parsed);
    expect(parseManifest({ ...json, listingAuthorization: {
      authority: upperHex(listingAuthorization.authority), salt: upperHex(listingAuthorization.salt),
    } })).toEqual(parsed);
    expect(manifestId(parsed)).not.toBe(manifestId(parseManifest(input())));
    for (const patch of [{ authority: input().factory.address }, { salt: input().factory.codeHash }]) {
      expect(manifestId(parseManifest({ ...json, listingAuthorization: { ...listingAuthorization, ...patch } }))).not.toBe(manifestId(parsed));
    }
    for (const authorization of [undefined, {}, { ...listingAuthorization, authority: zeroAddress },
      { ...listingAuthorization, salt: zeroHash }, { ...listingAuthorization, salt: '0x12' },
      { ...listingAuthorization, extra: true }]) {
      expect(() => parseManifest({ ...json, listingAuthorization: authorization })).toThrow('MANIFEST_INVALID');
    }
    expect(() => parseManifest({ ...input(), listingAuthorization })).toThrow('MANIFEST_INVALID');
    expect(() => parseManifest({ ...json, mode: 'zero', chainId: 1 })).toThrow('MANIFEST_INVALID');
  });
});
