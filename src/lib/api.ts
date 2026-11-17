export class ApiError extends Error {
  code: string;
  status: number;
  correlationId?: string;

  constructor(code: string, message: string, status: number, correlationId?: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.correlationId = correlationId;
  }
}

const API_BASE = (() => {
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL;
  return configured ? configured.replace(/\/+$/, '') : '';
})();

let inMemoryAccessToken: string | null = null;
let inMemoryViewStepUpToken: { token: string; expiresAt: number } | null = null;

export function setAccessToken(token: string | null) {
  inMemoryAccessToken = token;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setViewStepUpToken(token: string | null, expiresInSeconds = 300) {
  if (!token) {
    inMemoryViewStepUpToken = null;
    return;
  }
  inMemoryViewStepUpToken = {
    token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

export function getValidViewStepUpToken(): string | null {
  if (!inMemoryViewStepUpToken) return null;
  if (Date.now() >= inMemoryViewStepUpToken.expiresAt - 5000) {
    inMemoryViewStepUpToken = null;
    return null;
  }
  return inMemoryViewStepUpToken.token;
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface RememberedLoginHint {
  identifier: string;
  channel: 'email' | 'phone';
  surface: 'wallet' | 'admin';
  lastUsedAt: string;
}

const REMEMBERED_KEY = 'csw_returning_accounts_v1';

export function getRememberedLogins(surface?: 'wallet' | 'admin'): RememberedLoginHint[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(REMEMBERED_KEY);
    const list: RememberedLoginHint[] = raw ? JSON.parse(raw) : [];
    const filtered = surface ? list.filter((x) => x.surface === surface) : list;
    return filtered.slice(0, 4);
  } catch {
    return [];
  }
}

export function rememberLoginHint(hint: Omit<RememberedLoginHint, 'lastUsedAt'>) {
  if (typeof window === 'undefined' || !hint.identifier) return;
  try {
    const existing = getRememberedLogins().filter(
      (x) => !(x.identifier.toLowerCase() === hint.identifier.toLowerCase() && x.surface === hint.surface),
    );
    const updated: RememberedLoginHint[] = [
      { ...hint, lastUsedAt: new Date().toISOString() },
      ...existing,
    ].slice(0, 6);
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & {
    stepUpToken?: string;
    idempotencyKey?: string;
    skipRefresh?: boolean;
  } = {},
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryAccessToken) {
    headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);
  }
  if (options.stepUpToken) {
    headers.set('X-Step-Up-Token', options.stepUpToken);
  }
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  const csrf = getCookie('csw_csrf');
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && !options.skipRefresh && !path.startsWith('/auth/')) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, skipRefresh: true });
    }
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/pdf') || contentType.includes('text/csv')) {
    if (!res.ok) throw new ApiError('DOWNLOAD_FAILED', 'Could not generate document', res.status);
    return (await res.blob()) as unknown as T;
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errObj = json?.error || {};
    const fallbackMessage =
      res.status === 405
        ? 'API endpoint rejected POST (HTTP 405). Ensure Cloudflare Worker routing (wrangler.toml main + run_worker_first) or Pages Functions are active and API_ORIGIN does not point back to your frontend host.'
        : `Request failed (${res.status})`;
    throw new ApiError(
      errObj.code || (res.status === 405 ? 'METHOD_NOT_ALLOWED' : 'API_ERROR'),
      errObj.message || fallbackMessage,
      res.status,
      errObj.correlationId,
    );
  }
  return json as T;
}

export async function tryRefreshSession(): Promise<{ accessToken: string; user: unknown } | null> {
  try {
    const csrf = getCookie('csw_csrf');
    if (!csrf && !inMemoryAccessToken) {
      return null;
    }
    const headers: Record<string, string> = {};
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      inMemoryAccessToken = null;
      return null;
    }
    const data = await res.json();
    inMemoryAccessToken = data.accessToken;
    return data;
  } catch {
    return null;
  }
}
