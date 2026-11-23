import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { customerNetwork, customerNetworkBanner } from './customer-network';
import { AdminDiagnostics, SettingsNetwork } from '../components/workspace-pages';

describe('customer configured network labels', () => {
  it.each(['Base Sepolia', 'Base Sepolia testnet', 'base-sepolia'])('recognizes the actual Base network name %s without claiming transaction availability', network => {
    expect(customerNetwork({ network, chainId: 84532, nativeSymbol: 'ETH', nativeDecimals: 18 })).toMatchObject({ kind: 'base-sepolia', label: 'Base Sepolia testnet (84532)' });
  });
  it.each(['Local Anvil', 'Local Anvil (not Zero)', 'local'])('keeps local label %s separate from Base', network => {
    expect(customerNetwork({ network, chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 })).toMatchObject({ kind: 'local', label: 'Local test network (31337)' });
  });
  it('handles canonical name/chain fields and preserved Zero plans without defaulting unknown responses to Base', () => {
    expect(customerNetwork({ name: 'Base Sepolia', chainId: 84532 }).kind).toBe('base-sepolia');
    expect(customerNetwork({ chainId: 31337 }).kind).toBe('local');
    expect(customerNetwork({ network: 'Zero', chainId: null, nativeSymbol: 'ZRO', nativeDecimals: null })).toMatchObject({ kind: 'zero', label: 'Zero (planned)' });
    for (const value of [null, {}, { network: 'Unknown' }, { network: 'Base Sepolia', chainId: 8453 }, { network: 'Base Sepolia', chainId: '84532' }, { network: 'Base Sepolia', chainId: 84532, nativeSymbol: 'ZRO' }, { network: 'Zero', chainId: 84532 }]) {
      expect(customerNetwork(value).kind).toBe('unknown'); expect(customerNetworkBanner(value, false, false)).not.toContain('Base Sepolia');
    }
    expect(customerNetworkBanner({ network: 'Zero' }, false, false)).not.toContain('test ETH');
  });
  it('does not turn legacy static feature flags into global service claims', () => {
    const profile = { network: 'Base Sepolia testnet', chainId: 84532 };
    const disabled = customerNetworkBanner({ ...profile, features: { nftLaunch: { enabled: false }, tokenLaunch: false, trading: false } }, false, false);
    const enabled = customerNetworkBanner({ ...profile, features: { nftLaunch: true, tokenLaunch: true, trading: true } }, false, false);
    expect(disabled).toBe(enabled); expect(disabled).toContain('Test ETH'); expect(disabled).not.toMatch(/minting|trading|launches|available|deployed/);
    expect(customerNetworkBanner(null, true, false)).toBe('Loading network details…');
    expect(customerNetworkBanner(profile, false, true)).toContain('could not be loaded');
  });
  it('settings point to asset-specific availability and retain useful network-load recovery', () => {
    const render = (data: unknown, failed = false) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SettingsNetwork, { data, loading: false, failed, onRefresh: vi.fn() })));
    const html = render({ network: 'Base Sepolia', chainId: 84532, features: { trading: false, nftLaunch: false } });
    for (const text of ['Base Sepolia testnet (84532)', 'with each token or collection', 'href="/tokens"', 'href="/nfts"']) expect(html).toContain(text);
    expect(html).not.toMatch(/Currently unavailable|NFT minting|Token trading|RPC|configuration/);
    const zero = render({ network: 'Zero', chainId: null }); expect(zero).toContain('Zero (planned)'); expect(zero).not.toContain('Base Sepolia');
    expect(customerNetwork({ network: 'Zero Testnet', chainId: 33001, nativeSymbol: 'ZRO' })).toMatchObject({ kind: 'zero-testnet', label: 'Zero Testnet (33001)' });
    expect(customerNetwork({ network: 'Zero Mainnet', chainId: 33000, nativeSymbol: 'ZRO' })).toMatchObject({ kind: 'zero-mainnet', label: 'Zero Mainnet (33000)' });
    expect(customerNetwork({ network: 'Zero Testnet', chainId: 543210, nativeSymbol: 'ZRO' }).kind).toBe('unknown');
    expect(customerNetworkBanner({ network: 'Zero Mainnet', chainId: 33000, nativeSymbol: 'ZRO' }, false, false)).toContain('real ZRO');
    const failure = render(null, true); expect(failure).toContain('Try again'); expect(failure).not.toContain('Base Sepolia');
  });

  it('renders active-network titles and mainnet warnings inside AdminDiagnostics', () => {
    const baseHtml = renderToStaticMarkup(createElement(AdminDiagnostics, {
      status: {
        executionScope: 'Base Sepolia',
        nativeSymbol: 'ETH',
        reviewedNfts: { readsEnabled: true, executionEnabled: true },
        tokenAnalytics: { readsEnabled: true },
        networkConfig: { name: 'Base Sepolia testnet', mode: 'base-sepolia', chainId: 84532, nativeDecimals: 18, isTestnet: true, configurationReady: true, missing: [] },
      },
      readiness: null,
    }));
    expect(baseHtml).toContain('Base Sepolia execution');
    expect(baseHtml).toContain('Base Sepolia contract deployment');
    expect(baseHtml).toContain('Base Sepolia documentation');
    expect(baseHtml).toContain('Reviewed NFTs checkout');

    const mainnetHtml = renderToStaticMarkup(createElement(AdminDiagnostics, {
      status: {
        executionScope: 'Zero Mainnet',
        nativeSymbol: 'ZRO',
        networkConfig: { name: 'Zero Mainnet', mode: 'zero-mainnet', chainId: 33000, nativeDecimals: 18, isTestnet: false, configurationReady: false, missing: ['Explicit mainnet opt-in'] },
      },
      readiness: null,
    }));
    expect(mainnetHtml).toContain('Zero Mainnet execution');
    expect(mainnetHtml).toContain('Mainnet (real ZRO)');
  });
});
