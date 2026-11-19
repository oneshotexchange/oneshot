import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExternalNftImportRequest } from '../components/external-nft-imports';
import { appendExternalNftImportPage, createExternalNftImportsApi, externalNftImportStatusLabel, validateExternalNftImportConfig, validateExternalNftImportPage } from './client-external-nft-imports';
import type { AccountExternalNftImport } from './external-nft-import';

const deploymentId = 'a'.repeat(64), collection = `0x${'12'.repeat(20)}` as `0x${string}`, createdAt = '2026-11-19T00:00:00.000Z';
const config = { available: true, deployments: [{ deploymentId, chainId: 84532 as const, label: 'Base Sepolia collections' }] };
const record = (n = 1): AccountExternalNftImport => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, deploymentId, collection, note: 'Please review this collection.', reference: 'Collection reference', revision: 1, status: 'submitted', admissionStatus: 'not-established', customerNote: null, createdAt, updatedAt: createdAt, reviewedAt: null });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const api = (fetcher: typeof fetch, identityScope: () => string | null = () => 'owner:null-wallet:null-chain') => createExternalNftImportsApi({ fetcher, identityScope, getAccessToken: async () => 'fresh-token' });

describe('customer import deployment availability', () => {
  it('accepts only advertised supported test deployments and omits account credentials for config', async () => {
    const getAccessToken = vi.fn(async () => 'private-token'), fetcher = vi.fn<typeof fetch>(async () => json(config));
    const client = createExternalNftImportsApi({ fetcher, identityScope: () => null, getAccessToken });
    expect(await client.config()).toEqual(config); expect(getAccessToken).not.toHaveBeenCalled();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(validateExternalNftImportConfig({ available: false, deployments: [] }).available).toBe(false);
  });
  it.each([
    null, {}, { available: true, deployments: [] }, { available: false, deployments: config.deployments },
    { ...config, deployments: [{ ...config.deployments[0], chainId: 8453 }] },
    { ...config, deployments: [config.deployments[0], config.deployments[0]] },
    { ...config, deployments: [{ ...config.deployments[0], deploymentId: 'not-a-manifest' }] },
    { ...config, deployments: [{ ...config.deployments[0], label: 'Base\noperator command' }] },
    { ...config, privateProvider: 'secret' },
  ])('rejects missing, contradictory, unsupported or unreadable config instead of inventing a destination: %j', value => {
    expect(() => validateExternalNftImportConfig(value)).toThrow('unavailable');
  });
});

describe('import requests are strictly account scoped', () => {
  it('loads a private list with a fresh bearer without requiring a linked wallet', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ items: [record()], nextCursor: null }));
    expect((await api(fetcher).list()).items).toHaveLength(1);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fresh-token');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(String(fetcher.mock.calls[0][0])).toContain('/external-nfts/imports?limit=20');
  });
  it('does not start an authenticated request without an identity or after token acquisition changes account', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ items: [], nextCursor: null }));
    await expect(api(fetcher, () => null).list()).rejects.toThrow('account or wallet changed');
    let scope = 'alice';
    const client = createExternalNftImportsApi({ fetcher, identityScope: () => scope, getAccessToken: async () => { scope = 'bob'; return 'fresh'; } });
    await expect(client.submit(record())).rejects.toThrow(); // Extra response-only fields are never submitted.
    await expect(client.list()).rejects.toThrow('account or wallet changed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects late responses after account change, including a change during body reading', async () => {
    let scope = 'alice';
    await expect(api(async () => { scope = 'bob'; return json({ items: [record()], nextCursor: null }); }, () => scope).list()).rejects.toThrow('account or wallet changed');
    scope = 'alice';
    const response = json({ items: [record()], nextCursor: null }), stream = response.body!, reader = stream.getReader(), read = reader.read.bind(reader);
    vi.spyOn(stream, 'getReader').mockReturnValue(reader);
    vi.spyOn(reader, 'read').mockImplementation(async () => { const value = await read(); scope = 'bob'; return value; });
    await expect(api(async () => response, () => scope).list()).rejects.toThrow('account or wallet changed');
  });
  it('rejects successful responses from aborted or rejected reads and never turns failures into empty history', async () => {
    const controller = new AbortController();
    await expect(api(async () => { controller.abort(); return json({ items: [], nextCursor: null }); }).list({}, controller.signal)).rejects.toThrow();
    await expect(api(async () => { throw new Error('private transport endpoint'); }).list()).rejects.toThrow('Could not connect');
    await expect(api(async () => new Response('not JSON')).list()).rejects.toThrow('could not be verified');
    await expect(api(async () => json({ error: { code: 'UNKNOWN', message: 'postgres://private-credentials' } }, 503)).list()).rejects.not.toThrow('postgres');
  });
  it.each([
    {}, { items: 'not-a-list', nextCursor: null }, { items: [], nextCursor: 'next' }, { items: [], nextCursor: '' },
    { items: [record(), record()], nextCursor: null }, { items: [{ ...record(), ownerUserId: 'did:privy:private-owner' }], nextCursor: null },
    { items: [{ ...record(), status: 'review-approved' }], nextCursor: null },
    { items: [{ ...record(), admissionStatus: 'admitted' }], nextCursor: null },
  ])('rejects malformed or inconsistent request history: %j', value => expect(() => validateExternalNftImportPage(value)).toThrow('verified'));
});

describe('review submission and withdrawal are exact non-signing requests', () => {
  it('submits normalized collection data and accepts only an exact new submitted request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(record())), input = { deploymentId, collection: collection.toUpperCase().replace('0X', '0x'), note: '  Please review this collection.  ', reference: 'Collection reference' };
    expect(await api(fetcher).submit(input)).toEqual(record());
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ deploymentId, collection, note: record().note, reference: record().reference });
    for (const result of [{ ...record(), deploymentId: 'b'.repeat(64) }, { ...record(), collection: `0x${'3'.repeat(40)}` }, { ...record(), note: 'Another request' }, { ...record(), revision: 2 }]) await expect(api(async () => json(result)).submit({ deploymentId, collection, note: record().note, reference: record().reference })).rejects.toThrow('verified');
  });
  it('withdraws only the selected revision and preserves review notes and immutable request terms', async () => {
    const selected: AccountExternalNftImport = { ...record(), status: 'review-approved', revision: 2, customerNote: 'Review complete.', reviewedAt: '2026-11-19T01:00:00.000Z', updatedAt: '2026-11-19T01:00:00.000Z' };
    const withdrawn = { ...selected, status: 'withdrawn' as const, revision: 3, updatedAt: '2026-11-19T02:00:00.000Z' }, fetcher = vi.fn<typeof fetch>(async () => json(withdrawn));
    expect(await api(fetcher).withdraw(selected)).toEqual(withdrawn);
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE'); expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ expectedRevision: 2 });
    for (const result of [{ ...withdrawn, id: record(2).id }, { ...withdrawn, revision: 4 }, { ...withdrawn, customerNote: 'Changed privately' }, { ...withdrawn, reference: 'Another reference' }]) await expect(api(async () => json(result)).withdraw(selected)).rejects.toThrow('verified');
    await expect(api(fetcher).withdraw(withdrawn)).rejects.toThrow('Reload');
  });
  it('does not expose arbitrary server errors or automatically retry a failed mutation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ error: { code: 'EXTERNAL_IMPORT_CHANGED', message: 'private operator evidence' } }, 409));
    await expect(api(fetcher).withdraw(record())).rejects.toThrow('Reload your requests'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('bounded import history and honest review copy', () => {
  it.each([20, 50])('accepts a full valid %i-record page at maximum text sizes with escaped surrogate and multibyte data', async limit => {
    const full = (n: number, text: string): AccountExternalNftImport => ({ ...record(n), revision: 2, status: 'review-approved', note: text.repeat(1000), reference: text.repeat(2048), customerNote: text.repeat(500), reviewedAt: createdAt });
    for (const text of ['\ud800', '界']) {
      const body = { items: Array.from({ length: limit }, (_, index) => full(limit - index, text)), nextCursor: null };
      const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
      expect(bytes).toBeLessThan(2 * 1024 * 1024);
      if (text === '\ud800') expect(bytes).toBeGreaterThan(limit === 20 ? 400_000 : 1_000_000);
      expect((await api(async () => json(body)).list({ limit })).items).toHaveLength(limit);
    }
  });
  it('cancels an oversized streamed response without trusting a small content-length header', async () => {
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
    await expect(api(async () => new Response(stream, { headers: { 'content-length': '1' } })).list()).rejects.toThrow('could not be verified');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized advertised response and cancels an interrupted body read', async () => {
    await expect(api(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })).list()).rejects.toThrow('could not be verified');
    const controller = new AbortController(), cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })), stream = response.body!, getReader = stream.getReader.bind(stream);
    let entered!: () => void; const readerEntered = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(stream, 'getReader').mockImplementation(() => { const reader = getReader(); entered(); return reader; });
    const pending = api(async () => response).list({}, controller.signal);
    await readerEntered; controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
    const early = new AbortController(), cancelBeforeReader = vi.fn();
    const earlyResponse = new Response(new ReadableStream<Uint8Array>({ cancel: cancelBeforeReader }, { highWaterMark: 0 }));
    await expect(api(async () => { early.abort(); return earlyResponse; }).list({}, early.signal)).rejects.toThrow();
    expect(cancelBeforeReader).toHaveBeenCalled();
  });
  it('appends later pages past 50 records without changing the requested ordering or losing entries', () => {
    const page = (top: number, cursor: string | null) => ({ items: Array.from({ length: 20 }, (_, index) => record(top - index)), nextCursor: cursor });
    const first = page(60, 'page-2'), second = appendExternalNftImportPage(first, page(40, 'page-3'));
    expect(appendExternalNftImportPage(second, page(20, null)).items).toHaveLength(60);
    expect(() => appendExternalNftImportPage(first, page(60, 'page-3'))).toThrow('verified');
    expect(() => appendExternalNftImportPage(first, page(40, 'page-2'))).toThrow('verified');
    expect(() => appendExternalNftImportPage(first, { items: [], nextCursor: null })).toThrow('verified');
  });
  it('rejects unsupported page sizes and cursors before issuing a request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ items: [], nextCursor: null })), client = api(fetcher);
    for (const input of [{ limit: 0 }, { limit: 51 }, { cursor: '' }, { cursor: 'private?invalid' }]) await expect(client.list(input)).rejects.toThrow('beginning');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('renders review approval as separate from trading, with review and reference text escaped', () => {
    const item: AccountExternalNftImport = { ...record(), revision: 2, status: 'review-approved', customerNote: '<script>private note</script>', reviewedAt: createdAt, note: '<b>my note</b>', reference: 'javascript:alert(1)' };
    const html = renderToStaticMarkup(createElement(ExternalNftImportRequest, { item, config, disabled: false, onWithdraw: () => {} }));
    expect(externalNftImportStatusLabel(item.status)).toBe('Review approved'); expect(html).toContain('Review approved'); expect(html).toContain('Trading not enabled');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
    expect(html.match(/Base Sepolia testnet/g)).toHaveLength(1); expect(html).not.toContain('Base Sepolia collections');
    expect(html).toContain('Withdraw request'); expect(html).not.toContain('creator verified');
    const historical = renderToStaticMarkup(createElement(ExternalNftImportRequest, { item, config: { ...config, deployments: [{ ...config.deployments[0], deploymentId: 'b'.repeat(64) }] }, disabled: false, onWithdraw: () => {} }));
    expect(historical).toContain('Original network details unavailable'); expect(historical).not.toContain('Base Sepolia');
  });
});
