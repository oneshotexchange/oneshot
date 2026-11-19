import { z } from 'zod';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch } from './customer-http';
import { accountExternalNftImportPageSchema, accountExternalNftImportSchema, externalImportDeploymentIdSchema, externalNftImportInputSchema, type AccountExternalNftImport, type AccountExternalNftImportPage, type ExternalNftImportStatus } from './external-nft-import';

const label = z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value));
const configSchema = z.object({
  available: z.boolean(), deployments: z.array(z.object({ deploymentId: externalImportDeploymentIdSchema, chainId: z.union([z.literal(31337), z.literal(84532)]), label }).strict()).max(20),
}).strict().refine(value => value.available ? value.deployments.length > 0 : value.deployments.length === 0)
  .refine(value => new Set(value.deployments.map(deployment => deployment.deploymentId)).size === value.deployments.length);
export type ExternalNftImportConfig = z.infer<typeof configSchema>;
const base = '/api/oneshot/external-nfts';
const cursorValid = (value: string) => value.length > 0 && value.length <= 2048 && /^[\w-]+$/.test(value);
const invalidResponse = () => new ExternalNftImportError('Collection import data could not be verified. Reload and try again.', 'INVALID_RESPONSE');
// Fifty valid records fit even when every text code unit is escaped as a lone
// surrogate (six JSON bytes). The customer page requests twenty at a time.
const maximumResponseBytes = 2 * 1024 * 1024;
export class ExternalNftImportError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) { super(message); this.name = 'ExternalNftImportError'; }
}
async function readBoundedJson(response: Response, signal: AbortSignal, assertScope: () => void): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maximumResponseBytes)) { void response.body?.cancel().catch(() => {}); throw invalidResponse(); }
  const reader = response.body?.getReader(); if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); assertScope(); const part = await reader.read(); signal.throwIfAborted(); assertScope();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > maximumResponseBytes) throw invalidResponse();
      chunks.push(part.value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { if (!response.ok) return null; throw invalidResponse(); }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ExternalNftImportError) throw error;
    throw invalidResponse();
  } finally { signal.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock(); }
}
function safeError(code: string | undefined, status: number) {
  const messages: Record<string, string> = {
    EXTERNAL_IMPORT_CHANGED: 'This request changed elsewhere. Reload your requests before trying again.',
    EXTERNAL_IMPORT_DUPLICATE: 'You already have an active request for this collection. Reload your requests to check its review.',
    EXTERNAL_IMPORT_LIMIT: 'You can have up to 20 active requests. Withdraw an existing request before submitting another.',
    EXTERNAL_IMPORT_CURSOR_INVALID: 'This request page could not be opened. Reload your requests from the beginning.',
    EXTERNAL_IMPORT_INPUT_INVALID: 'Check the collection address, selected network and request notes.',
    EXTERNAL_IMPORT_NOT_FOUND: 'This request is no longer available in this account. Reload your requests.',
    EXTERNAL_IMPORT_UNAVAILABLE: 'Collection import requests are temporarily unavailable. Please try again later.',
  };
  const mapped = code && Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : null;
  return status === 401 ? 'Sign in again to manage your collection import requests.' : mapped
    || (status === 403 ? 'This request is not available to the selected account. Sign in with its account and try again.'
      : status === 429 ? 'Too many requests. Wait a moment, then reload your requests.' : 'The collection import request could not be completed. Reload and try again.');
}
export function validateExternalNftImportConfig(input: unknown): ExternalNftImportConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ExternalNftImportError('Collection import requests are currently unavailable. Reload to try again.', 'CONFIG_UNAVAILABLE');
  return parsed.data;
}
function validateRecord(input: unknown): AccountExternalNftImport {
  const parsed = accountExternalNftImportSchema.safeParse(input);
  if (!parsed.success) throw invalidResponse();
  const value = parsed.data, created = Date.parse(value.createdAt), updated = Date.parse(value.updatedAt), reviewed = value.reviewedAt === null ? null : Date.parse(value.reviewedAt);
  if (updated < created || reviewed !== null && (reviewed < created || reviewed > updated)
    || (reviewed === null) !== (value.customerNote === null)
    || value.status === 'submitted' && (value.reviewedAt !== null || value.customerNote !== null || value.revision !== 1 || value.updatedAt !== value.createdAt)
    || ['review-approved', 'rejected'].includes(value.status) && (reviewed === null || value.customerNote === null || value.revision < 2)
    || value.status === 'withdrawn' && value.revision < 2) throw invalidResponse();
  return value;
}
export function validateExternalNftImportPage(input: unknown, limit = 20): AccountExternalNftImportPage {
  const parsed = (limit > 50 ? accountExternalNftImportPageSchema.extend({ items: z.array(accountExternalNftImportSchema).max(1000) }) : accountExternalNftImportPageSchema).safeParse(input);
  if (!parsed.success || parsed.data.items.length > limit || parsed.data.nextCursor !== null && (!cursorValid(parsed.data.nextCursor) || !parsed.data.items.length)) throw invalidResponse();
  const items = parsed.data.items.map(validateRecord), seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index], previous = items[index - 1];
    if (seen.has(item.id) || previous && (item.createdAt > previous.createdAt || item.createdAt === previous.createdAt && item.id >= previous.id)) throw invalidResponse();
    seen.add(item.id);
  }
  return { items, nextCursor: parsed.data.nextCursor };
}
export function appendExternalNftImportPage(previous: AccountExternalNftImportPage, next: AccountExternalNftImportPage): AccountExternalNftImportPage {
  if (previous.items.length + next.items.length > 1000) throw new ExternalNftImportError('Up to 1,000 requests can be shown at once. Reload your requests to view the latest.', 'HISTORY_LIMIT');
  if (!previous.nextCursor || previous.nextCursor === next.nextCursor || !next.items.length) throw invalidResponse();
  return validateExternalNftImportPage({ items: [...previous.items, ...next.items], nextCursor: next.nextCursor }, 1000);
}
const sameInput = (left: AccountExternalNftImport, right: z.infer<typeof externalNftImportInputSchema>) => left.deploymentId === right.deploymentId && left.collection === right.collection && left.note === right.note && left.reference === right.reference;

/** Requests stay account-private; a fresh bearer and exact identity are checked around every await. */
export function createExternalNftImportsApi(options: { identityScope(): string | null; getAccessToken(): Promise<string | null>; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher || fetch;
  async function request(path: string, input?: unknown, method = 'GET', signal?: AbortSignal, publicRead = false): Promise<unknown> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(20_000), deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const scope = options.identityScope(), headers = new Headers();
    const assertScope = () => { if (!publicRead && (!scope || options.identityScope() !== scope)) throw new ExternalNftImportError('Your account or wallet changed. Reload your requests before continuing.', 'IDENTITY_CHANGED'); };
    if (!publicRead) {
      assertScope(); const token = await options.getAccessToken(); assertScope(); signal?.throwIfAborted();
      if (!token) throw new ExternalNftImportError('Your session expired. Sign in again.', 'AUTH_REQUIRED', 401);
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (input !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response | undefined;
    try {
      deadline.throwIfAborted();
      response = await customerFetch(apiUrl(path), { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: deadline }, fetcher);
      assertScope(); deadline.throwIfAborted();
      const body = await readBoundedJson(response, deadline, assertScope);
      assertScope(); deadline.throwIfAborted();
      if (!response.ok) { const error = customerErrorDetails(body); throw new ExternalNftImportError(safeError(error.code, response.status), error.code || 'REQUEST_FAILED', response.status); }
      return body;
    } catch (error) {
      // Abort or identity change can win immediately after fetch, before a reader
      // exists. The reader's own cleanup covers later failures during consumption.
      void response?.body?.cancel().catch(() => {});
      signal?.throwIfAborted();
      if (deadline.aborted) throw new ExternalNftImportError('The request took too long. Reload your requests to check their latest status.', 'REQUEST_TIMEOUT');
      throw error;
    }
  }
  return {
    async config(signal?: AbortSignal) { return validateExternalNftImportConfig(await request(`${base}/config`, undefined, 'GET', signal, true)); },
    async list(input: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<AccountExternalNftImportPage> {
      const limit = input.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || input.cursor !== undefined && !cursorValid(input.cursor)) throw new ExternalNftImportError('Reload your requests from the beginning.', 'INVALID_INPUT');
      const query = new URLSearchParams({ limit: String(limit) }); if (input.cursor) query.set('cursor', input.cursor);
      return validateExternalNftImportPage(await request(`${base}/imports?${query}`, undefined, 'GET', signal), limit);
    },
    async submit(input: unknown): Promise<AccountExternalNftImport> {
      const parsed = externalNftImportInputSchema.safeParse(input);
      if (!parsed.success) throw new ExternalNftImportError('Check the collection address, selected network and request notes.', 'INVALID_INPUT', 400);
      const result = validateRecord(await request(`${base}/imports`, parsed.data, 'POST'));
      if (!sameInput(result, parsed.data) || result.revision !== 1 || result.status !== 'submitted' || result.createdAt !== result.updatedAt) throw invalidResponse();
      return result;
    },
    async withdraw(previous: AccountExternalNftImport): Promise<AccountExternalNftImport> {
      const selected = validateRecord(previous);
      if (selected.status === 'withdrawn' || selected.revision >= Number.MAX_SAFE_INTEGER) throw new ExternalNftImportError('Reload your requests before withdrawing this request.', 'INVALID_INPUT');
      const result = validateRecord(await request(`${base}/imports/${encodeURIComponent(selected.id)}`, { expectedRevision: selected.revision }, 'DELETE'));
      if (result.id !== selected.id || result.revision !== selected.revision + 1 || result.status !== 'withdrawn' || !sameInput(result, selected)
        || result.createdAt !== selected.createdAt || result.reviewedAt !== selected.reviewedAt || result.customerNote !== selected.customerNote || Date.parse(result.updatedAt) < Date.parse(selected.updatedAt)) throw invalidResponse();
      return result;
    },
  };
}
export type ExternalNftImportsApi = ReturnType<typeof createExternalNftImportsApi>;
export const externalNftImportStatusLabel = (status: ExternalNftImportStatus) => ({ submitted: 'Submitted', 'review-approved': 'Review approved', rejected: 'Not approved', withdrawn: 'Withdrawn' })[status];
