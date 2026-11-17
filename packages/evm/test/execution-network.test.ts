import { describe, expect, it } from 'vitest';
import { networkConfig, publicNetwork } from '../src/config';
import { BASE_SEPOLIA_GENESIS_HASH, BASE_SEPOLIA_CONFIG_SOURCE_URL, isNftExecutionNetwork, isSupportedNftChainId, nftExecutionNetwork, nftNetworkForChainId } from '../src/execution-network';

describe('explicit Base Sepolia execution identity', () => {
  it('uses pinned public network facts without claiming a deployed or reachable service', () => {
    const config = networkConfig({ ONESHOT_NETWORK: 'base-sepolia' });
    expect(config).toMatchObject({ mode: 'base-sepolia', chainId: 84532, nativeSymbol: 'ETH', nativeDecimals: 18,
      genesisHash: BASE_SEPOLIA_GENESIS_HASH, sourceUrl: BASE_SEPOLIA_CONFIG_SOURCE_URL, rpcUrl: 'https://sepolia.base.org', explorerUrl: 'https://sepolia.basescan.org', configurationReady: true });
    expect(nftExecutionNetwork(config)).toEqual({ mode: 'base-sepolia', chainId: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH', nativeDecimals: 18 });
    expect(publicNetwork(config)).not.toHaveProperty('rpcUrl');
    expect(publicNetwork(config)).not.toHaveProperty('executionEnabled');
  });

  it('allows a private HTTPS provider while excluding credentials from public metadata', () => {
    const config = networkConfig({ ONESHOT_NETWORK: 'base-sepolia', ONESHOT_RPC_URL: 'https://rpc.example/keep-provider-key-private' });
    expect(config.rpcUrl).toContain('keep-provider-key-private');
    expect(JSON.stringify(publicNetwork(config))).not.toContain('keep-provider-key-private');
    expect(networkConfig({ ONESHOT_NETWORK: 'base-sepolia', ONESHOT_GENESIS_HASH: BASE_SEPOLIA_GENESIS_HASH.toUpperCase().replace('0X', '0x') }).genesisHash).toBe(BASE_SEPOLIA_GENESIS_HASH);
  });

  it.each([
    { ONESHOT_CHAIN_ID: '8453' }, { ONESHOT_CHAIN_ID: '31337' }, { ONESHOT_CHAIN_ID: '1' },
    { ONESHOT_NATIVE_DECIMALS: '8' }, { ONESHOT_NATIVE_DECIMALS: '0' },
    { ONESHOT_GENESIS_HASH: `0x${'1'.repeat(64)}` }, { ONESHOT_GENESIS_HASH: 'not-a-hash' },
    { ONESHOT_RPC_URL: 'http://sepolia.base.org' }, { ONESHOT_RPC_URL: 'https://name:secret@sepolia.base.org' },
    { ONESHOT_RPC_URL: 'https://sepolia.base.org/#secret' }, { ONESHOT_CONFIG_SOURCE_URL: 'https://docs.layerzero.network/chain' },
    { ONESHOT_EXPLORER_URL: 'https://basescan.org' },
  ])('rejects conflicting profile inputs without silently changing their network: %j', override => {
    expect(() => networkConfig({ ONESHOT_NETWORK: 'base-sepolia', ...override })).toThrow();
  });

  it('never accepts a Base chain under the Zero profile or enables an unspecified future chain', () => {
    for (const chainId of ['84532', '8453']) expect(() => networkConfig({ ONESHOT_NETWORK: 'zero', ONESHOT_CHAIN_ID: chainId })).toThrow();
    expect(networkConfig({}).mode).toBe('zero');
    expect(networkConfig({}).configurationReady).toBe(false);
    for (const input of [null, {}, { mode: 'local', chainId: 84532 }, { mode: 'base-sepolia', chainId: 31337 },
      { mode: 'zero', chainId: 84532 }, { mode: 'base-sepolia', chainId: 8453 }, { mode: 'base-sepolia', chainId: '84532' }]) expect(nftExecutionNetwork(input)).toBeNull();
    for (const chain of [8453, 1, 11155111, '84532', 0, NaN]) { expect(isSupportedNftChainId(chain)).toBe(false); expect(nftNetworkForChainId(chain)).toBeNull(); }
  });

  it('admits complete canonical DTOs only, and returns isolated presentation records', () => {
    for (const chain of [31337, 84532]) {
      const value = nftNetworkForChainId(chain)!;
      expect(isSupportedNftChainId(chain)).toBe(true); expect(isNftExecutionNetwork(value)).toBe(true);
      for (const change of [{ nativeSymbol: 'ZRO' }, { nativeDecimals: 8 }, { name: 'Mainnet' }, { mode: 'zero' }]) expect(isNftExecutionNetwork({ ...value, ...change })).toBe(false);
      value.name = 'changed' as typeof value.name;
      expect(nftNetworkForChainId(chain)?.name).not.toBe('changed');
    }
  });
});
