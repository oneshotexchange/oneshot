export const CONNECTION_MESSAGE = 'Could not connect to oneshot. Check your connection and try again.';
export const RESPONSE_MESSAGE = 'The response could not be loaded. Please try again.';

function preserveCancellation(error: unknown, signal?: AbortSignal | null): void {
  signal?.throwIfAborted();
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
}

/** Normalize HTTP transport failures only; wallet requests must retain their original outcomes. */
export async function customerFetch(input: RequestInfo | URL, init?: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  try { return await fetcher(input, init); }
  catch (error) {
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    preserveCancellation(error, signal);
    throw new Error(CONNECTION_MESSAGE, { cause: error });
  }
}

/** An unreadable error body still belongs to its HTTP status; unreadable success is never data. */
export async function customerResponseJson<T = unknown>(response: Response, options: {
  signal?: AbortSignal | null;
  invalidResponse?: () => Error;
} = {}): Promise<T | null> {
  try { return await response.json() as T; }
  catch (error) {
    preserveCancellation(error, options.signal);
    if (!response.ok) return null;
    throw options.invalidResponse?.() || new Error(RESPONSE_MESSAGE, { cause: error });
  }
}

/** Accept both supported API error envelopes without trusting an arbitrary response shape. */
export function customerErrorDetails(value: unknown): { code?: string; message?: string } {
  if (!value || typeof value !== 'object') return {};
  const body = value as Record<string, unknown>;
  const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : null;
  const code = error?.code || body.code;
  const message = error?.message || body.message || (typeof body.error === 'string' ? body.error : undefined);
  return { ...(typeof code === 'string' ? { code } : {}), ...(typeof message === 'string' ? { message } : {}) };
}
