import { apiUrl } from './api-url';

const VISITOR_STORAGE_KEY = 'oneshot.visitor.id';
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DEDUPE_WINDOW_MS = 3_000;

let fallbackVisitorId: string | null = null;
let lastTrackedPath = '';
let lastTrackedAt = 0;

function createVisitorId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fall through to deterministic-length fallback below.
  }
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function getVisitorId(): string {
  if (typeof window === 'undefined') return createVisitorId();
  try {
    const stored = window.localStorage.getItem(VISITOR_STORAGE_KEY);
    if (stored && VISITOR_ID_PATTERN.test(stored)) {
      fallbackVisitorId = stored;
      return stored;
    }
  } catch {
    // Ignore storage access restrictions.
  }
  try {
    const sessionStored = window.sessionStorage.getItem(VISITOR_STORAGE_KEY);
    if (sessionStored && VISITOR_ID_PATTERN.test(sessionStored)) {
      fallbackVisitorId = sessionStored;
      return sessionStored;
    }
  } catch {
    // Ignore sessionStorage restrictions.
  }

  const next = fallbackVisitorId && VISITOR_ID_PATTERN.test(fallbackVisitorId)
    ? fallbackVisitorId
    : createVisitorId();
  fallbackVisitorId = next;

  try {
    window.localStorage.setItem(VISITOR_STORAGE_KEY, next);
  } catch {
    try {
      window.sessionStorage.setItem(VISITOR_STORAGE_KEY, next);
    } catch {
      // Memory fallback already holds `next`.
    }
  }
  return next;
}

export function trackPageVisit(rawPathname: string): void {
  if (typeof window === 'undefined') return;
  try {
    const pathname = rawPathname.trim() || '/';
    const lower = pathname.toLowerCase();
    if (lower === '/whitelist' || lower === '/admin' || lower.startsWith('/admin/')) return;

    const now = Date.now();
    if (lower === lastTrackedPath && now - lastTrackedAt < DEDUPE_WINDOW_MS) return;
    lastTrackedPath = lower;
    lastTrackedAt = now;

    const visitorId = getVisitorId();
    const endpoint = apiUrl('/api/oneshot/analytics/visit');
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, path: pathname.slice(0, 256) }),
      credentials: 'omit',
      keepalive: true,
      mode: 'cors',
    }).catch(() => undefined);
  } catch {
    // Analytics must never interrupt page rendering or navigation.
  }
}
