import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocalNftPriceSummary } from '../components/nft-launch-review';

describe('local mint denomination review', () => {
  it('preserves exact test ETH terms without claiming a currency conversion', () => {
    const html = renderToStaticMarkup(createElement(LocalNftPriceSummary, {
      publicPrice: '9007199254740993.000000000000000001', allowlistPrice: '0.000000000000000001',
    }));
    expect(html).toContain('9007199254740993.000000000000000001 test ETH');
    expect(html).toContain('0.000000000000000001 test ETH');
    expect(html).toContain('No currency conversion is applied');
    expect(html).not.toContain('Live Zero pricing');
  });
  it('retains a zero mint price and omits an inactive allowlist', () => {
    const html = renderToStaticMarkup(createElement(LocalNftPriceSummary, { publicPrice: '0', allowlistPrice: null }));
    expect(html).toContain('0 test ETH');
    expect(html).not.toContain('Allowlist test mint price');
  });
});
