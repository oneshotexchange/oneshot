import { describe, expect, it } from 'vitest';
import { networkConfig, publicNetwork } from '../src/config';

describe('Zero configuration has no inherited Aptos or Ethereum defaults', () => {
  it('leaves unknown chain facts absent even when old production variables are present', () => {
    const value = networkConfig({ APTOS_CHAIN_ID: '2', B20_DEPLOYMENT_VERIFIED: 'true', APTOS_FULLNODE_URL: 'https://api.testnet.aptoslabs.com/v1' });
    expect(value.chainId).toBeNull(); expect(value.nativeDecimals).toBeNull(); expect(value.rpcUrl).toBeNull();
    expect(value.nativeSymbol).toBe('ZRO'); expect(value.configurationReady).toBe(false);
  });
  it('accepts zero decimals only when explicitly provided and keeps RPC URLs server-side', () => {
    const value = networkConfig({ ONESHOT_CHAIN_ID: '999999', ONESHOT_NATIVE_DECIMALS: '0', ONESHOT_RPC_URL: 'https://rpc.example/private-provider-token', ONESHOT_GENESIS_HASH: `0x${'ab'.repeat(32)}`, ONESHOT_CONFIG_SOURCE_URL: 'https://docs.example/network' });
    expect(value.configurationReady).toBe(true); expect(value.nativeDecimals).toBe(0);
    expect(JSON.stringify(publicNetwork(value))).not.toContain('private-provider-token');
  });
  it('rejects invalid, unsafe and impersonated local profiles', () => {
    for (const env of [ { ONESHOT_CHAIN_ID: '31337' }, { ONESHOT_CHAIN_ID: '0' }, { ONESHOT_CHAIN_ID: '1e3' }, { ONESHOT_CHAIN_ID: '9007199254740992' }, { ONESHOT_NATIVE_DECIMALS: '-1' }, { ONESHOT_RPC_URL: 'http://example.com' }, { ONESHOT_RPC_URL: 'https://user:pass@example.com' }, { ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: 'http://example.com' }, { ONESHOT_NETWORK: 'local', ONESHOT_CHAIN_ID: '1' } ]) expect(() => networkConfig(env)).toThrow();
    const value = networkConfig({ ONESHOT_NETWORK: 'local' });
    expect(value.name).toContain('not Zero'); expect(value.nativeSymbol).toBe('ETH'); expect(value.nativeDecimals).toBe(18);
  });
});
