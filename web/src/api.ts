export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Array<{ path: string; message: string }>) { super(message); }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-cg-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json as T;
}

/** Random key so an accidental double submit of the join form cannot create two members. */
export function randomKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Reads `key` from the URL fragment, then removes the fragment from the address bar. */
const fragmentCache = new Map<string, URLSearchParams>();
/** Reads `key` from the URL fragment (all keys are captured on first read), then removes the fragment from the address bar. */
export function takeFragment(key: string): string | null {
  // Cached so React StrictMode's double render cannot lose the value after it is removed from the URL.
  const path = window.location.pathname;
  if (!fragmentCache.has(path)) {
    const params = new URLSearchParams(window.location.hash.slice(1));
    fragmentCache.set(path, params);
    if (window.location.hash) window.history.replaceState(null, '', path);
  }
  return fragmentCache.get(path)!.get(key);
}

export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
