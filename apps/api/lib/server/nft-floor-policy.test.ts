import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyTypedData, zeroHash, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAssetAmount, guardedListingPermitTypedData, guardedPolicyPermitTypedData, UINT256_MAX } from '@oneshot/evm';
import { createNftFloorPolicyService, type FloorContext } from './nft-floor-policy';
import { putRecord } from './store';

const root = resolve('.local/nft-floor-policy-tests');
const creator = '0x1111111111111111111111111111111111111111' as Address;
const collection = '0x2222222222222222222222222222222222222222' as Address;
const market = '0x3333333333333333333333333333333333333333' as Address;
const context: FloorContext = { deploymentId: 'disposable-deployment', collection, creator };
// Public, disposable fixture identity. It is never funded or used on a network.
const fixtureKey = `0x${'12'.repeat(32)}` as Hex;
const authority = privateKeyToAccount(fixtureKey);
let directory: string;
let env: Record<string, string | undefined>;
const create = () => createNftFloorPolicyService(() => env);
const recordKey = (commitment: Hex) => `${context.deploymentId}:${collection}:${commitment}`;

beforeEach(async () => {
  await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'case-'));
  vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('ONESHOT_DATA_DIR', directory);
  env = { ONESHOT_FLOOR_CREATORS: creator, ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY: fixtureKey };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const target = resolve(directory);
  if (dirname(target) !== root || !basename(target).startsWith('case-')) throw new Error('Unsafe policy test cleanup path.');
  await rm(target, { recursive: true, force: true });
});

describe('private, durable protected floor policies', () => {
  it('salts identical proposals independently and resolves historical amounts after service restart', async () => {
    const first = await create().stage(context, true, '5.000000000000000004');
    const second = await create().stage(context, true, '5.000000000000000004');
    expect(first).toMatchObject({ enabled: true, floorRaw: '5000000000000000004', creator, collection });
    if (!('salt' in first) || !('salt' in second)) throw new Error('A newly staged proposal must persist its salt.');
    expect(second.salt).not.toBe(first.salt); expect(second.commitment).not.toBe(first.commitment);
    expect(await create().resolve(context, first.commitment)).toEqual(first);
    expect(await create().resolve(context, second.commitment)).toEqual(second);
    const restaged = await create().stage(context, true, '5.000000000000000004', first.commitment);
    expect(restaged).toEqual(first);
    await expect(create().stage(context, true, '5.000000000000000005', first.commitment)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
  });

  it('uses the full uint256 range without floating point rounding', async () => {
    const value = await create().stage(context, true, formatAssetAmount(UINT256_MAX, 18));
    expect(value.floorRaw).toBe(UINT256_MAX.toString());
    expect((await create().resolve(context, value.commitment)).floorRaw).toBe(UINT256_MAX.toString());
    const oneOver = `${(UINT256_MAX + 1n) / 10n ** 18n}.${((UINT256_MAX + 1n) % 10n ** 18n).toString().padStart(18, '0')}`;
    await expect(create().stage(context, true, oneOver)).rejects.toMatchObject({ code: 'INVALID_FLOOR' });
  });

  it.each(['0', '-1', '1e3', '1.0000000000000000001', 'NaN', ' 5', ''])('rejects an invalid enabled minimum %s', async value => {
    await expect(create().stage(context, true, value)).rejects.toMatchObject({ status: 409, code: 'INVALID_FLOOR' });
  });

  it('keeps a safe disabled default and permits an existing creator to disable after eligibility removal', async () => {
    expect(await create().resolve(context, zeroHash)).toEqual({ enabled: false, floorRaw: '0', commitment: zeroHash });
    const enabled = await create().stage(context, true, '5');
    env.ONESHOT_FLOOR_CREATORS = '';
    expect(await create().resolve(context, enabled.commitment)).toEqual(enabled);
    await expect(create().stage(context, true, '6')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const disabled = await create().stage(context, false, 'ignored');
    expect(disabled).toMatchObject({ enabled: false, floorRaw: '0' });
    expect(disabled.commitment).not.toBe(zeroHash);
    expect(await create().resolve(context, disabled.commitment)).toEqual(disabled);
  });

  it('fails closed for missing records, deployment/collection/creator mismatches and corrupted stored amounts', async () => {
    const policy = await create().stage(context, true, '5');
    const unavailable = { status: 409, code: 'FLOOR_POLICY_UNAVAILABLE' };
    await expect(create().resolve(context, `0x${'ff'.repeat(32)}`)).rejects.toMatchObject(unavailable);
    for (const changed of [{ ...context, deploymentId: 'other' }, { ...context, collection: market }, { ...context, creator: market }]) {
      await expect(create().resolve(changed, policy.commitment)).rejects.toMatchObject(unavailable);
    }
    for (const change of [{ floorRaw: '4' }, { floorRaw: '00' }, { floorRaw: (UINT256_MAX + 1n).toString() }, { enabled: false }, { salt: zeroHash }, { schemaVersion: 2 }]) {
      await putRecord('oneshot_floor_policies', recordKey(policy.commitment), { ...policy, ...change });
      await expect(create().resolve(context, policy.commitment)).rejects.toMatchObject(unavailable);
    }
    await putRecord('oneshot_floor_policies', recordKey(policy.commitment), policy);
    expect(await create().resolve(context, policy.commitment)).toEqual(policy);
  });

  it('validates the entire private creator list and does not disclose it in failures', () => {
    env.ONESHOT_FLOOR_CREATORS = `${creator.toUpperCase().replace('0X', '0x')},\n ${market}`;
    expect(create().eligible(creator)).toBe(true); expect(create().eligible(collection)).toBe(false);
    for (const invalid of [`${creator},private-invalid-value`, `0x${'0'.repeat(40)}`, Array(10_001).fill(creator).join(',')]) {
      env.ONESHOT_FLOOR_CREATORS = invalid;
      try { create().eligible(creator); throw new Error('Expected invalid private configuration.'); }
      catch (error) {
        expect(error).toMatchObject({ status: 503, code: 'FLOOR_CONFIG_INVALID' });
        expect(String(error)).not.toContain('private-invalid-value'); expect(String(error)).not.toContain(creator);
      }
    }
  });

  it('requires persistent database configuration in hosted mode', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(create().stage(context, true, '5')).rejects.toMatchObject({ status: 503, code: 'DATABASE_REQUIRED' });
  });
});

describe('server-only guarded marketplace signatures', () => {
  const deploymentSalt = `0x${'55'.repeat(32)}` as Hex;
  const listing = { seller: creator, collection, tokenId: 1n, totalPrice: 9n * 10n ** 18n, nonce: 7n, policyCommitment: zeroHash, deadline: UINT256_MAX, deploymentSalt };
  const policy = { creator, collection, commitment: deploymentSalt, expectedCommitment: zeroHash, deadline: UINT256_MAX, deploymentSalt };

  it('signs exact typed data with authority, marketplace and deployment binding', async () => {
    const signature = await create().signListing(market, authority.address, listing);
    expect(await verifyTypedData({ ...guardedListingPermitTypedData({ chainId: 31337, verifyingContract: market }, listing), address: authority.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...guardedListingPermitTypedData({ chainId: 31337, verifyingContract: market }, { ...listing, totalPrice: listing.totalPrice - 1n }), address: authority.address, signature })).toBe(false);
    expect(await verifyTypedData({ ...guardedListingPermitTypedData({ chainId: 31337, verifyingContract: collection }, listing), address: authority.address, signature })).toBe(false);
    const policySignature = await create().signPolicy(market, authority.address, policy);
    expect(await verifyTypedData({ ...guardedPolicyPermitTypedData({ chainId: 31337, verifyingContract: market }, policy), address: authority.address, signature: policySignature })).toBe(true);
    expect(await verifyTypedData({ ...guardedPolicyPermitTypedData({ chainId: 31337, verifyingContract: market }, { ...policy, expectedCommitment: deploymentSalt }), address: authority.address, signature: policySignature })).toBe(false);
  });

  it('fails safely for missing, malformed or mismatched authority secrets', async () => {
    for (const secret of [undefined, 'invalid-private-value', `0x${'00'.repeat(32)}`, `0x${'34'.repeat(32)}`]) {
      env.ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY = secret;
      for (const operation of [() => create().signListing(market, authority.address, listing), () => create().signPolicy(market, authority.address, policy)]) {
        const error = await operation().catch(error => error);
        expect(error).toMatchObject({ status: 503, code: 'LISTING_AUTHORITY_UNAVAILABLE' });
        if (secret) expect(String(error)).not.toContain(secret);
      }
    }
  });
});
