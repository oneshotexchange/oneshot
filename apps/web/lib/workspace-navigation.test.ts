import { describe, expect, it } from 'vitest';
import { workspaceNavigationKey } from './workspace-navigation';

const collection = `/nfts/0x${'12'.repeat(20)}`, deployment = 'ab'.repeat(32), otherDeployment = 'cd'.repeat(32);

describe('workspace collection navigation boundaries', () => {
  it('keeps the current collection page and scroll while its complete explorer query changes', () => {
    const current = workspaceNavigationKey(collection, `?deployment=${deployment}`);
    for (const filters of ['q=Nebula', 'q=%2317&availability=listed&minPrice=0.000000000000000001&sort=price-asc', 'owner=0x123&traits=typed-values', 'cursor=next', '']) {
      expect(workspaceNavigationKey(collection, `?${filters}&deployment=${deployment}`)).toBe(current);
    }
    expect(workspaceNavigationKey(collection, '?q=first')).toBe(workspaceNavigationKey(collection, '?q=second'));
  });
  it('resets for changed, newly anchored, malformed or duplicate deployment references', () => {
    const current = workspaceNavigationKey(collection, `?deployment=${deployment}`);
    for (const search of ['', `?deployment=${otherDeployment}`, '?deployment=', '?deployment=broken', `?deployment=${deployment}&deployment=${deployment}`]) {
      expect(workspaceNavigationKey(collection, search)).not.toBe(current);
    }
    expect(workspaceNavigationKey(collection, `?deployment=${deployment}&deployment=${otherDeployment}`)).not.toBe(workspaceNavigationKey(collection, `?deployment=${otherDeployment}&deployment=${deployment}`));
    expect(workspaceNavigationKey(`/nfts/0x${'34'.repeat(20)}`, `?deployment=${deployment}`)).not.toBe(current);
  });
  it.each([
    ['/nfts/new', '?draft=first', '?draft=second'],
    ['/nfts/new', '?draft=first&launchId=one', '?draft=first&launchId=two'],
    ['/tokens/new', '?draft=first', '?draft=second'],
    ['/portfolio', '?wallet=first', '?wallet=second'],
    [`${collection}/17`, `?deployment=${deployment}`, `?deployment=${otherDeployment}`],
    [`${collection}/17`, '?q=first', '?q=second'],
    ['/nfts/cart', `?deployment=${deployment}&chain=31337`, `?deployment=${deployment}&chain=84532`],
    ['/nfts', '?q=first', '?q=second'],
    ['/nfts/not-an-address', '?q=first', '?q=second'],
    ['/tokens', '?sort=new', '?sort=old'],
  ])('retains the full query reset for %s', (pathname, before, after) => {
    expect(workspaceNavigationKey(pathname, before)).toBe(pathname + before);
    expect(workspaceNavigationKey(pathname, after)).not.toBe(workspaceNavigationKey(pathname, before));
  });
});
