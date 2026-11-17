import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { guardedListingPermitHash } from '../src/guarded-market';
import { GUARDED_MARKETPLACE_V3_ABI, guardedOfferAcceptancePermitHash, guardedOfferAcceptancePermitTypedData, type GuardedOfferAcceptancePermit } from '../src/nft-offers';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const context = { chainId: 84532, verifyingContract: a(1) };
const permit: GuardedOfferAcceptancePermit = { seller: a(2), offerId: 7n, collection: a(3), tokenId: 12n, totalPrice: 123n, nonce: 0n, policyCommitment: h(4), deadline: 1000n, deploymentSalt: h(5) };
describe('guarded NFT offer acceptance and batch interface', () => {
  it('deep freezes the exact acceptance domain and snapshots input', () => {
    const input = { ...permit }; const data = guardedOfferAcceptancePermitTypedData(context, input); input.totalPrice = 999n;
    expect(data.message.totalPrice).toBe(123n); expect(data.primaryType).toBe('OfferAcceptancePermit');
    expect(data.domain).toMatchObject({ name: 'OneshotGuardedMarketplace', version: '1', chainId: 84532, verifyingContract: a(1) });
    for (const value of [data, data.message, data.domain, data.types, data.types.OfferAcceptancePermit, ...data.types.OfferAcceptancePermit]) expect(Object.isFrozen(value)).toBe(true);
  });
  it('binds every settlement, policy, replay and deployment field independently', () => {
    const original = guardedOfferAcceptancePermitHash(context, permit);
    for (const change of [{ seller: a(9) }, { offerId: 8n }, { collection: a(9) }, { tokenId: 13n }, { totalPrice: 124n }, { nonce: 1n }, { policyCommitment: h(9) }, { deadline: 999n }, { deploymentSalt: h(9) }]) expect(guardedOfferAcceptancePermitHash(context, { ...permit, ...change })).not.toBe(original);
    expect(guardedOfferAcceptancePermitHash({ ...context, chainId: 31337 }, permit)).not.toBe(original);
    expect(guardedOfferAcceptancePermitHash({ ...context, verifyingContract: a(9) }, permit)).not.toBe(original);
    expect(guardedListingPermitHash(context, { seller: permit.seller, collection: permit.collection, tokenId: permit.tokenId, totalPrice: permit.totalPrice, nonce: permit.nonce, policyCommitment: permit.policyCommitment, deadline: permit.deadline, deploymentSalt: permit.deploymentSalt })).not.toBe(original);
  });
  it('rejects unsafe networks, malformed identities and out-of-range integers', () => {
    for (const chainId of [1, 8453, 0]) expect(() => guardedOfferAcceptancePermitTypedData({ ...context, chainId }, permit)).toThrow();
    expect(() => guardedOfferAcceptancePermitTypedData({ ...context, verifyingContract: zeroAddress }, permit)).toThrow();
    for (const change of [{ seller: zeroAddress }, { collection: zeroAddress }, { totalPrice: -1n }, { offerId: 1n << 256n }, { deadline: 1 as never }, { deploymentSalt: '0x00' as Hex }]) expect(() => guardedOfferAcceptancePermitTypedData(context, { ...permit, ...change })).toThrow();
  });
  it('encodes exact native offer funding, acceptance and ordered batch arguments', () => {
    const create = encodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, functionName: 'createOffer', args: [a(3), 0n, 123n, 2n, a(4), 1000n] });
    expect(decodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, data: create })).toEqual({ functionName: 'createOffer', args: [a(3), 0n, 123n, 2n, a(4), 1000n] });
    const batch = encodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, functionName: 'buyBatch', args: [[7n, 3n], 100n, a(4)] });
    expect(decodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, data: batch }).args).toEqual([[7n, 3n], 100n, a(4)]);
    const accept = encodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, functionName: 'acceptOffer', args: [7n, 12n, 0n, h(4), 1000n, '0x1234'] });
    expect(decodeFunctionData({ abi: GUARDED_MARKETPLACE_V3_ABI, data: accept }).args).toEqual([7n, 12n, 0n, h(4), 1000n, '0x1234']);
  });
});
