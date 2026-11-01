import type { NextRequest } from 'next/server';

// This finite table keeps identifiers and attacker-controlled path fragments out
// of logs. Matching never decodes a path, emits a URL or inspects query values.
const address = '0x[\\da-fA-F]{40}';
const uuid = '[\\da-fA-F]{8}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{12}';
const hash = '[a-f0-9]{64}';
const routes = [
  ['/api/health', /^\/api\/health$/],
  ['/api/ready', /^\/api\/ready$/],
  ['/api/oneshot/session', /^\/api\/oneshot\/session$/],
  ['/api/oneshot/network', /^\/api\/oneshot\/network$/],
  ['/api/oneshot/media', /^\/api\/oneshot\/media$/],
  ['/api/oneshot/drafts', /^\/api\/oneshot\/drafts$/],
  ['/api/oneshot/drafts/:draftId', new RegExp(`^/api/oneshot/drafts/${uuid}$`)],
  ['/api/oneshot/drafts/:draftId/prepare', new RegExp(`^/api/oneshot/drafts/${uuid}/prepare$`)],
  ['/api/oneshot/metadata/:manifest/:item', new RegExp(`^/api/oneshot/metadata/${hash}/[1-9]\\d{0,3}$`)],
  ['/api/oneshot/launch/status', /^\/api\/oneshot\/launch\/status$/],
  ['/api/oneshot/launch/collections/:collection', new RegExp(`^/api/oneshot/launch/collections/${address}$`)],
  ['/api/oneshot/launch/floor/:collection', new RegExp(`^/api/oneshot/launch/floor/${address}$`)],
  ['/api/oneshot/launch/reviews/:reviewId', new RegExp(`^/api/oneshot/launch/reviews/${uuid}$`)],
  ['/api/oneshot/launch/transactions', /^\/api\/oneshot\/launch\/transactions$/],
  ['/api/oneshot/launch/review', /^\/api\/oneshot\/launch\/review$/],
  ['/api/oneshot/launch/submitted', /^\/api\/oneshot\/launch\/submitted$/],
  ['/api/oneshot/launch/validate', /^\/api\/oneshot\/launch\/validate$/],
  ['/api/oneshot/launch/receipt', /^\/api\/oneshot\/launch\/receipt$/],
  ['/api/oneshot/indexed/status', /^\/api\/oneshot\/indexed\/status$/],
  ['/api/oneshot/indexed/collections', /^\/api\/oneshot\/indexed\/collections$/],
  ['/api/oneshot/indexed/collections/:collection', new RegExp(`^/api/oneshot/indexed/collections/${address}$`)],
  ['/api/oneshot/indexed/collections/:collection/items', new RegExp(`^/api/oneshot/indexed/collections/${address}/items$`)],
  ['/api/oneshot/indexed/collections/:collection/items/:tokenId', new RegExp(`^/api/oneshot/indexed/collections/${address}/items/[1-9]\\d{0,77}$`)],
  ['/api/oneshot/indexed/listings', /^\/api\/oneshot\/indexed\/listings$/],
  ['/api/oneshot/indexed/activity', /^\/api\/oneshot\/indexed\/activity$/],
  ['/api/oneshot/indexed/wallets/:wallet/items', new RegExp(`^/api/oneshot/indexed/wallets/${address}/items$`)],
  ['/api/oneshot/indexed/wallets/:wallet/claims', new RegExp(`^/api/oneshot/indexed/wallets/${address}/claims$`)],
] as const;

export type RequestRoute = typeof routes[number][0] | 'unmatched';
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type RequestMetric = {
  event: 'oneshot_request';
  route: RequestRoute;
  method: typeof methods[number] | 'OTHER';
  status: number;
  durationMs: number;
};

export function requestMetricRoute(pathname: unknown): RequestRoute {
  if (typeof pathname !== 'string' || pathname.length > 1024 || /[?#%\\\s]/.test(pathname)) return 'unmatched';
  const path = pathname.replace(/\/$/, '');
  return routes.find(([, pattern]) => pattern.test(path))?.[0] ?? 'unmatched';
}

type MetricOptions = {
  enabled?: boolean;
  clock?: () => number;
  sink?: (event: RequestMetric) => void;
};

/** A best-effort request completion event; no counters, unbounded labels or endpoint. */
export function beginRequestMetric(request: Pick<NextRequest, 'method' | 'nextUrl'>, options: MetricOptions = {}): (status: number) => void {
  if (!(options.enabled ?? process.env.ONESHOT_REQUEST_METRICS === 'true')) return () => undefined;
  const clock = options.clock ?? (() => performance.now());
  const sink = options.sink ?? (event => console.info(JSON.stringify(event)));
  // A metrics failure, including a custom sink/clock, must not change a response.
  try {
    const started = clock();
    const route = requestMetricRoute(request.nextUrl.pathname);
    const method = methods.find(value => value === request.method) ?? 'OTHER';
    let completed = false;
    return status => {
      if (completed) return;
      completed = true;
      try {
        const elapsed = clock() - started;
        sink({ event: 'oneshot_request', route, method,
          status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
          durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed * 1000) / 1000) : 0 });
      } catch { /* Logging is deliberately best-effort. */ }
    };
  } catch { return () => undefined; }
}
