import { describe, expect, it } from 'vitest';
import {
  isMainnetExecutionNetwork,
  isValidZeroChainId,
  nativeCurrencyLabel,
  nftNetworkForChainId,
  RESERVED_NON_ZERO_CHAIN_IDS,
  ZERION_ZERO_CHAIN_ID,
} from '../src/execution-network';

describe('execution network identity and Zero guards', () => {
  it('blocks reserved EVM chains including Zerion ZER0 (543210)', () => {
    expect(ZERION_ZERO_CHAIN_ID).toBe(543210);
    for (const id of RESERVED_NON_ZERO_CHAIN_IDS) {
      expect(isValidZeroChainId(id)).toBe(false);
    }
    expect(isValidZeroChainId(-1)).toBe(false);
    expect(isValidZeroChainId('33001')).toBe(false);
    expect(isValidZeroChainId(33001)).toBe(true);
  });

  it('derives accurate native labels and mainnet detection without breaking NFT networks', () => {
    expect(nftNetworkForChainId(84532)).toMatchObject({ mode: 'base-sepolia', chainId: 84532, nativeSymbol: 'ETH' });
    expect(nativeCurrencyLabel({ mode: 'base-sepolia' })).toBe('test ETH');
    expect(nativeCurrencyLabel({ mode: 'zero-testnet' })).toBe('test ZRO');
    expect(nativeCurrencyLabel({ mode: 'zero-mainnet' })).toBe('ZRO');
    expect(isMainnetExecutionNetwork({ mode: 'zero-testnet', isTestnet: true })).toBe(false);
    expect(isMainnetExecutionNetwork({ mode: 'zero-mainnet', isTestnet: false })).toBe(true);
  });
});
