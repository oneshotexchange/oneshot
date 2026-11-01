import { describe, expect, it } from 'vitest';
import { nftDeploymentLinkIssue } from './client-nft-deployment-link';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { IndexedItemCards, IndexedItemRecord } from '../components/indexed-nfts';
import type { IndexedNftItem } from '@oneshot/evm';
const deployment = 'ab'.repeat(32);
describe('deployment-bound public collection handoff', () => {
  it('preserves ordinary discovery links and accepts only the expected verified deployment', () => {
    expect(nftDeploymentLinkIssue('', null)).toBeNull();
    expect(nftDeploymentLinkIssue(`?deployment=${deployment}`, deployment)).toBeNull();
    expect(nftDeploymentLinkIssue(`?deployment=${deployment}`, 'cd'.repeat(32))).toContain('test network has changed');
  });
  it('requires current verified context and rejects duplicate/malformed references', () => {
    expect(nftDeploymentLinkIssue(`?deployment=${deployment}`, null)).toContain('original test network');
    for (const query of ['?deployment=', '?deployment=not-a-manifest', `?deployment=${deployment}&deployment=${deployment}`, '?deployment=https://attacker.invalid'])
      expect(nftDeploymentLinkIssue(query, deployment)).toContain('link is invalid');
  });
  it('preserves the shared deployment through item and collection navigation', () => {
    const collection = `0x${'12'.repeat(20)}`;
    const item: IndexedNftItem = { id: `${collection}:1`, collection, tokenId: '1', owner: `0x${'34'.repeat(20)}`, burned: false, listing: null };
    const cards = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(IndexedItemCards, { items: [item], deploymentId: deployment })));
    const record = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(IndexedItemRecord, { item, deploymentId: deployment })));
    expect(cards).toContain(`href="/nfts/${collection}/1?deployment=${deployment}"`);
    expect(record).toContain(`href="/nfts/${collection}?deployment=${deployment}"`);
  });
});
