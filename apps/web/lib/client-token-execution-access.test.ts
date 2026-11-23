import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { nftNetworkForChainId, type IndexedTokenContext, type TokenExecutionReview, type TokenExecutionStatus } from '@oneshot/evm';
import { tokenExecutionAccess, TokenExecutionAccessGuidance, TokenExecutionResult, TokenExecutionSummary } from '../components/token-execution-panel';
import type { TokenExecutionState } from './client-token-execution';

const address = (n: string) => `0x${n.repeat(40)}` as `0x${string}`, hash = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const network = nftNetworkForChainId(84532)!, deploymentId = 'a'.repeat(64), factory = address('1');
const status: TokenExecutionStatus = { enabled: true, network, deploymentId, factory, reason: null };
const unavailable: TokenExecutionStatus = { enabled: false, network: null, deploymentId: null, factory: null, reason: 'unavailable' };
const snapshot = { available: true, network, deploymentId, source: { factory: { address: factory } } } as IndexedTokenContext;
const base = { status, failed: false, snapshot, pricingMatches: true, configured: true, authenticated: true, connected: true, scope: 'owner', chainId: 84532 };
const guidance = (access: ReturnType<typeof tokenExecutionAccess>, current: TokenExecutionStatus | null = status) => renderToStaticMarkup(createElement(TokenExecutionAccessGuidance, { access, status: current, onRefresh: vi.fn(), walletAction: createElement('button', null, 'Connect wallet') }));
const review: TokenExecutionReview = { id: '00000000-0000-4000-8000-000000000001', reviewHash: 'b'.repeat(64), expiresAt: '2099-11-16T12:00:00Z', action: 'buy', chainId: 84532, deploymentId, network,
  from: address('2'), to: address('3'), data: '0x1234', value: '1000000000000000001', simulation: { blockNumber: '9007199254740993', blockHash: hash('4'), gasEstimate: '120000' },
  summary: { amountRaw: '1000000000000000001', quotedExecutionFeeRaw: '15000000000000000', executionFeeBps: '150', quotedReceiveRaw: '123456789', minimumReceiveRaw: '120000001', totalDexFeePips: '3497', lpFeePips: '2500', protocolFeePips: '1000', recipient: address('2') } };

describe('token execution access and customer guidance', () => {
  it('checks availability before showing sign-in, wallet or network prompts', () => {
    for (const input of [{ ...base, status: null }, { ...base, status: null, failed: true }, { ...base, status: unavailable }, { ...base, snapshot: { ...snapshot, deploymentId: 'c'.repeat(64) } }, { ...base, snapshot: { ...snapshot, source: { ...snapshot.source!, factory: { address: address('9'), codeHash: hash('9') } } } }]) {
      const access = tokenExecutionAccess({ ...input, authenticated: false, connected: false, chainId: 8453 });
      expect(['checking', 'unavailable']).toContain(access);
      const html = guidance(access, input.status); expect(html).not.toMatch(/Connect wallet|Select Base|Approve in wallet|Review buy/);
      if (access === 'unavailable') expect(html).toContain('Check availability'); else expect(html).toContain('Loading');
    }
  });

  it('gives a signed-in customer without a linked wallet a connection action before any network instruction', () => {
    const access = tokenExecutionAccess({ ...base, connected: false, chainId: null }); expect(access).toBe('wallet');
    const html = guidance(access); expect(html).toContain('Connect wallet'); expect(html).toContain('Connect a linked wallet'); expect(html).not.toContain('Select Base');
  });

  it('names Base Sepolia exactly for a wrong chain and suppresses prompts only after matching wallet/source readiness', () => {
    for (const chainId of [31337, 8453, null]) expect(tokenExecutionAccess({ ...base, chainId })).toBe('network');
    const html = guidance('network'); expect(html).toContain('Base Sepolia testnet (84532)'); expect(html).toContain('in your wallet');
    expect(tokenExecutionAccess(base)).toBe('ready'); expect(guidance('ready')).toBe('');
  });

  it('keeps legacy planned ZRO terms behind explicit Base repricing before wallet prompts', () => {
    const access = tokenExecutionAccess({ ...base, pricingMatches: false, authenticated: false }); expect(access).toBe('pricing');
    const html = guidance(access); expect(html).toContain('planned ZRO'); expect(html).toContain('enter a test ETH valuation'); expect(html).not.toContain('Connect wallet');
  });

  it('renders exact quoted/minimum quantities and the actual directional pool fee without invented analytics', () => {
    const html = renderToStaticMarkup(createElement(TokenExecutionSummary, { review, symbol: 'ORBIT' }));
    for (const value of ['1.000000000000000001 test ETH', '1.23456789 ORBIT', '1.20000001 ORBIT', '0.3497%', '0.25%', '0.1%', 'Actual output may change', 'full input reverts']) expect(html).toContain(value);
    expect(html).not.toMatch(/Market cap|24h|Holders|ZRO/);

    const maintainHtml = renderToStaticMarkup(createElement(TokenExecutionSummary, {
      review: {
        ...review, action: 'maintain', value: '0',
        summary: {
          maximumNativeBudgetRaw: '1000000000000000000', maximumTokenBudgetRaw: '1000000000000000',
          pendingLpNativeRaw: '10000000000000000', pendingLpTokenRaw: '500000000',
          pendingLiquidityNativeRaw: '20000000000000000', pendingLiquidityTokenRaw: '0', pendingBurnNativeRaw: '5000000000000000',
        },
      },
      symbol: 'ORBIT',
    }));
    for (const value of ['Max native spending budget', '1 test ETH', '10000000 ORBIT', 'Pending LP fees (native)', '0.01 test ETH', '5 ORBIT', '0%']) expect(maintainHtml).toContain(value);
  });

  it('keeps a submitted receipt and IDs visible without another approval action, and links a verified created market', () => {
    const state: TokenExecutionState = { phase: 'submitted', review, hash: hash('5'), receipt: null, message: 'Pending', storageWarning: null };
    const render = (value: TokenExecutionState) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TokenExecutionResult, { state: value, symbol: 'ORBIT', canApprove: false, onApprove: vi.fn(), onDiscard: vi.fn(), onReceipt: vi.fn() })));
    const html = render(state); expect(html).toContain('Check receipt'); expect(html).toContain(review.id); expect(html).toContain(hash('5')); expect(html).not.toContain('Approve in wallet');
    const launched = render({ ...state, phase: 'confirmed', review: { ...review, action: 'launch', summary: { name: 'Orbit', symbol: 'ORBIT', initialSupplyRaw: '100000000000000000', openingValuationNativeRaw: '1000000000000000001', effectiveOpeningValuationNativeRaw: '1001000000000000000', effectiveUpperValuationNativeRaw: '1001000000000000000000', executionFeeBps: '150', feeMode: 'creator' } }, receipt: { reviewId: review.id, hash: hash('5'), status: 'confirmed', blockNumber: '1', blockHash: hash('4'), finalized: false, createdMarket: { market: address('6'), token: address('7') } } });
    expect(launched).toContain(`/tokens/${address('6')}`); expect(launched).toContain('View your token market');
  });
});
