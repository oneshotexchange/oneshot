import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NftCreatorProgress, NftCreatorWorkspace, NftLaunchCandidate } from '@oneshot/evm';
import { NftCreatorProgressPanel } from '../components/nft-creator-progress';
import { createNftLaunchApi, type NftTransactionRecord } from './client-nft-launch';
import { assertCreatorRecovery, creatorCanStart, creatorCollectionHref, creatorWorkspaceKey, NftCreatorWorkspaceLoader, validateCreatorWorkspace, type CreatorWorkspaceScope, type CreatorWorkspaceState } from './client-nft-creator-progress';

const draftId = '11111111-1111-4111-8111-111111111111', firstId = '22222222-2222-4222-8222-222222222222', secondId = '33333333-3333-4333-8333-333333333333';
const from = `0x${'a'.repeat(40)}`, collection = `0x${'b'.repeat(40)}`, hash = `0x${'c'.repeat(64)}`, deploymentId = 'd'.repeat(64);
const scope: CreatorWorkspaceScope = { identityScope: 'account-a:session-wallet-chain', userId: 'account-a', draftId, revision: 4, from, deploymentId };
const candidate = (id = firstId): NftLaunchCandidate => ({ id, collection, createHash: hash, createdAt: '2026-10-27T01:00:00Z' });
const selected = (changes: Partial<NftCreatorProgress> = {}): NftCreatorProgress => ({ id: firstId, collection, createHash: hash, phase: 'created', nextAction: 'configure', termsMatch: false, blockNumber: '20', blockHash: hash, ...changes });
const workspace = (changes: Partial<NftCreatorWorkspace> = {}): NftCreatorWorkspace => ({ draftId, revision: 4, from, deploymentId, items: [], nextCursor: null, pending: [], selected: null, ...changes });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { vi.unstubAllEnvs(); });

describe('private creator progress loading', () => {
  it('checks the sole saved collection read-only instead of starting another creation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(workspace({ items: [candidate()] })).mockResolvedValueOnce(workspace({ items: [candidate()], selected: selected() }));
    const loader = new NftCreatorWorkspaceLoader(fetcher);
    await loader.open(scope);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toEqual({ draftId, expectedRevision: 4, from, launchId: firstId });
    expect(loader.snapshot()).toMatchObject({ loading: false, data: { selected: { phase: 'created', nextAction: 'configure' } } });
    expect(creatorCanStart(loader.snapshot().data, false, null)).toBe(false);
  });

  it('requires an explicit choice among multiple candidates, including a partially loaded list', async () => {
    const fetcher = vi.fn().mockResolvedValue(workspace({ items: [candidate(), candidate(secondId)] }));
    const loader = new NftCreatorWorkspaceLoader(fetcher); await loader.open(scope);
    expect(fetcher).toHaveBeenCalledOnce(); expect(loader.snapshot().data?.selected).toBeNull();
    fetcher.mockResolvedValueOnce(workspace({ items: [candidate(), candidate(secondId)], selected: selected({ id: secondId }) }));
    await loader.select(secondId); expect(loader.snapshot().data?.selected?.id).toBe(secondId);
    const partialFetcher = vi.fn().mockResolvedValue(workspace({ items: [candidate()], nextCursor: 'next' }));
    const partial = new NftCreatorWorkspaceLoader(partialFetcher); await partial.open(scope);
    expect(partialFetcher).toHaveBeenCalledOnce(); expect(partial.snapshot().data?.selected).toBeNull();
  });

  it('aborts and ignores an old account response after a wallet, draft or deployment changes', async () => {
    const old = deferred<NftCreatorWorkspace>(), current = deferred<NftCreatorWorkspace>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const loader = new NftCreatorWorkspaceLoader(fetcher), first = loader.open(scope);
    const replacement = { ...scope, identityScope: 'account-b', userId: 'account-b', from: collection, deploymentId: 'e'.repeat(64) };
    const second = loader.open(replacement);
    expect(fetcher.mock.calls[0][1].aborted).toBe(true);
    current.resolve(workspace({ from: collection, deploymentId: replacement.deploymentId })); await second;
    old.resolve(workspace({ items: [candidate()] })); await first;
    expect(loader.snapshot()).toMatchObject({ key: creatorWorkspaceKey(replacement), data: { from: collection, items: [] }, error: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not restore a late selected collection after the view closes or another choice wins', async () => {
    const late = deferred<NftCreatorWorkspace>();
    const fetcher = vi.fn().mockResolvedValueOnce(workspace({ items: [candidate(), candidate(secondId)] })).mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(workspace({ items: [candidate(), candidate(secondId)], selected: selected({ id: secondId }) }));
    const loader = new NftCreatorWorkspaceLoader(fetcher); await loader.open(scope);
    const obsolete = loader.select(firstId); await loader.select(secondId);
    late.resolve(workspace({ items: [candidate()], selected: selected() })); await obsolete;
    expect(loader.snapshot().data?.selected?.id).toBe(secondId);
    await loader.open(null); expect(loader.snapshot()).toMatchObject({ key: null, data: null, loading: false });
  });

  it('clears previously checked progress on a failed refresh and can return to the saved collection list', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(workspace({ items: [candidate()], selected: selected() }))
      .mockRejectedValueOnce(new Error('The local checkpoint changed.'))
      .mockResolvedValueOnce(workspace({ items: [candidate(), candidate(secondId)] }));
    const loader = new NftCreatorWorkspaceLoader(fetcher); await loader.open(scope, firstId); await loader.refresh();
    expect(loader.snapshot()).toMatchObject({ data: null, error: 'The local checkpoint changed.', loading: false });
    expect(creatorCanStart(loader.snapshot().data, false, loader.snapshot().error)).toBe(false);
    await loader.list(); expect(fetcher.mock.calls[2][0]).not.toHaveProperty('launchId');
    expect(loader.snapshot().data?.items).toHaveLength(2);
  });

  it('loads one next page at a time without combining its cursor with a selected launch', async () => {
    const more = deferred<NftCreatorWorkspace>();
    const fetcher = vi.fn().mockResolvedValueOnce(workspace({ items: [candidate()], nextCursor: 'next-page' })).mockReturnValueOnce(more.promise);
    const loader = new NftCreatorWorkspaceLoader(fetcher); await loader.open(scope);
    const loading = loader.loadMore(); await loader.loadMore();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][0]).toMatchObject({ cursor: 'next-page' });
    expect(fetcher.mock.calls[1][0]).not.toHaveProperty('launchId');
    more.resolve(workspace({ items: [candidate(secondId)] })); await loading;
    expect(loader.snapshot().data?.items.map(item => item.id)).toEqual([firstId, secondId]);
    expect(loader.snapshot().data?.selected).toBeNull();
  });

  it.each([
    { draftId: secondId }, { revision: 5 }, { from: collection }, { deploymentId: 'e'.repeat(64) },
    { selected: selected() }, { pending: [{ reviewId: firstId, hash: 'bad' }] },
  ])('rejects a mismatched private workspace before exposing its controls %j', changes => {
    expect(() => validateCreatorWorkspace(workspace(changes), scope)).toThrow('does not match');
  });

  it('does not accept a different collection identity or contradictory next action for the selected launch', () => {
    expect(() => validateCreatorWorkspace(workspace({ items: [candidate()], selected: selected({ collection: from }) }), scope, firstId)).toThrow();
    expect(() => validateCreatorWorkspace(workspace({ selected: selected({ phase: 'orphaned', nextAction: 'open' }) }), scope, firstId)).toThrow();
    expect(() => validateCreatorWorkspace(workspace({ selected: selected({ phase: 'configured', nextAction: 'open', termsMatch: false }) }), scope, firstId)).toThrow();
    expect(validateCreatorWorkspace(workspace({ selected: selected() }), scope, firstId).selected?.id).toBe(firstId);
  });
});

describe('creator progress authentication and recovery', () => {
  it('uses private fresh-token GET requests with cancellation and validated draft parameters', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.example');
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(workspace())), getAccessToken = vi.fn().mockResolvedValue('fresh-token');
    const api = createNftLaunchApi({ identityScope: () => 'account-a', getAccessToken, fetcher }), abort = new AbortController();
    await api.progress({ draftId, expectedRevision: 4, from, launchId: firstId }, abort.signal);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`https://api.oneshot.example/api/oneshot/launch/drafts/${draftId}?wallet=${from}&revision=4&launchId=${firstId}`);
    expect(init).toMatchObject({ method: 'GET', signal: abort.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh-token');
    expect(() => api.progress({ draftId, expectedRevision: 4, from, launchId: firstId, cursor: 'next' })).toThrow('saved draft');
    expect(() => api.progress({ draftId: '../other', expectedRevision: 4, from })).toThrow('saved draft');
    abort.abort(); await expect(api.progress({ draftId, expectedRevision: 4, from }, abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('never returns old private progress after a session changes while the response is in flight', async () => {
    const response = deferred<Response>(); let identity = 'account-a';
    const api = createNftLaunchApi({ identityScope: () => identity, getAccessToken: async () => 'token', fetcher: () => response.promise });
    const request = api.progress({ draftId, expectedRevision: 4, from }); await Promise.resolve(); identity = 'account-b';
    response.resolve(Response.json(workspace())); await expect(request).rejects.toThrow('account or wallet changed');
  });

  const record: NftTransactionRecord = { review: { id: firstId, action: 'create', scope: 'draft', draftId, revision: 4, deploymentId, from } as NftTransactionRecord['review'], transactionHash: hash, outcome: 'submitted', updatedAt: '2026-10-27T01:00:00Z' };
  it('only admits the exact saved create broadcast for this prepared revision and creator', () => {
    expect(() => assertCreatorRecovery(record, scope, firstId, hash)).not.toThrow();
    for (const changes of [{ action: 'open' }, { draftId: secondId }, { revision: 3 }, { from: collection }, { deploymentId: 'e'.repeat(64) }, { scope: 'public' }]) {
      expect(() => assertCreatorRecovery({ ...record, review: { ...record.review, ...changes } as NftTransactionRecord['review'] }, scope, firstId, hash)).toThrow('does not belong');
    }
    expect(() => assertCreatorRecovery({ ...record, transactionHash: `0x${'f'.repeat(64)}` }, scope, firstId, hash)).toThrow('does not belong');
  });
});

describe('guided creator progress display', () => {
  const render = (data: NftCreatorWorkspace | null, error: string | null = null, loading = false) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NftCreatorProgressPanel, {
    state: { key: creatorWorkspaceKey(scope), data, loading, loadingMore: false, error } satisfies CreatorWorkspaceState,
    disabled: false, onRefresh() {}, onSelect() {}, onMore() {}, onStart() {}, onContinue() {}, onRecover() {},
  })));
  it('offers an explicit creation only after an empty successful workspace check', () => {
    expect(render(workspace())).toContain('Set up a new collection');
    expect(render(null, null, true)).not.toContain('Set up a new collection');
    expect(render(null, 'Launch progress is unavailable.')).not.toContain('Set up a new collection');
    expect(render(workspace({ pending: [{ reviewId: firstId, hash }] }))).not.toContain('Set up a new collection');
    expect(render(workspace({ pending: [{ reviewId: firstId, hash }] }))).toContain('Check creation transaction');
  });

  it('shows the verified next step without wallet approval or automatic transaction controls', () => {
    const html = render(workspace({ items: [candidate()], selected: selected() }));
    expect(html).toContain('>Set mint phases</button>'); expect(html).toContain('Progress checked against the network.');
    expect(html).toContain('Review this step, then approve it in your wallet.');
    expect(html).not.toContain('Set up a new collection'); expect(html).not.toContain('Approve in wallet');
    expect(html).not.toContain('Copy collection link');
  });

  it('exposes only a verified opened collection link bound to the active local deployment', () => {
    const progress = selected({ phase: 'opened', nextAction: null, termsMatch: true });
    const href = `/nfts/${collection}?deployment=${deploymentId}`;
    expect(creatorCollectionHref(progress, deploymentId)).toBe(href);
    const html = render(workspace({ items: [candidate()], selected: progress }));
    expect(html).toContain(`href="${href}"`); expect(html).toContain('Copy collection link');
    expect(html).toContain('recent activity to appear'); expect(html).toContain('on the test network');
    expect(creatorCollectionHref({ ...progress, termsMatch: false }, deploymentId)).toBeNull();
    expect(creatorCollectionHref(progress, 'https://outside.example')).toBeNull();
    expect(creatorCollectionHref({ ...progress, collection: '//outside.example' }, deploymentId)).toBeNull();
  });

  it.each(['schedule-expired', 'orphaned', 'pending', 'mismatch'] as const)('keeps %s launches from offering a setup action or public mint link', phase => {
    const html = render(workspace({ items: [candidate()], selected: selected({ phase, nextAction: null }) }));
    expect(html).not.toContain('>Set mint phases</button>'); expect(html).not.toContain('Open mint</button>');
    expect(html).not.toContain('Copy collection link'); expect(html).not.toContain('Set up a new collection');
    if (phase === 'schedule-expired') expect(html).toContain('Copy these terms to a new draft');
  });

  it.each([[true, 2], [false, 1]] as const)('retains %s configured progress when an unopened schedule expires', (termsMatch, completedSteps) => {
    const html = render(workspace({ items: [candidate()], selected: selected({ phase: 'schedule-expired', nextAction: null, termsMatch }) }));
    expect(html.match(/<li class="done"/g)).toHaveLength(completedSteps);
    expect(html).toContain('<li class=""><span aria-hidden="true">3</span>Open mint</li>');
    expect(html).toContain('Copy these terms to a new draft');
    expect(html).not.toContain('Open mint</button>');
  });

  it.each(['orphaned', 'pending'] as const)('offers explicit original-receipt recovery for a selected %s association excluded from the pending list', phase => {
    const onRecover = vi.fn();
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NftCreatorProgressPanel, {
      state: { key: creatorWorkspaceKey(scope), data: workspace({ items: [candidate()], selected: selected({ phase, nextAction: null }) }), loading: false, loadingMore: false, error: null },
      disabled: false, onRefresh() {}, onSelect() {}, onMore() {}, onStart() {}, onContinue() {}, onRecover,
    })));
    expect(html).toContain('Check creation transaction'); expect(html).toContain('Checking does not submit another transaction.');
    expect(onRecover).not.toHaveBeenCalled();
    expect(html).not.toContain('>Set mint phases</button>'); expect(html).not.toContain('Open mint</button>');
  });
});
