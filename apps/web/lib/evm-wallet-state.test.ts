import { describe, expect, it } from 'vitest';
import { parseEvmIdentity } from './evm-wallet-state';

describe('EVM wallet identity', () => {
  it('clears both account and network on disconnect', () => {
    expect(parseEvmIdentity([], '0x7a69')).toEqual({ connected: false, account: null, network: null });
  });
  it('labels local Anvil explicitly and never calls a random chain Zero', () => {
    const address = `0x${'AB'.repeat(20)}`;
    expect(parseEvmIdentity([address], '0x7a69').network?.name).toBe('Local Anvil (not Zero)');
    expect(parseEvmIdentity([address], '0x1').network?.name).toBe('Chain 1 · unverified');
    expect(parseEvmIdentity([address], '0x1').account?.address).toBe(address.toLowerCase());
  });
  it('rejects Aptos-length addresses and malformed chain identities', () => {
    expect(() => parseEvmIdentity([`0x${'ab'.repeat(32)}`], '0x2')).toThrow();
    for (const chain of ['2', '0x0', '0x20000000000000', undefined]) expect(() => parseEvmIdentity([`0x${'ab'.repeat(20)}`], chain)).toThrow();
  });
});
