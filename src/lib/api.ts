import { currentAccessToken } from './auth';
const configuredApi = String(import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const OWNER_KEY = 'paperdesk-owner-id';
let transientOwner: string | undefined;

export function projectOwnerId() {
  try {
    let id = localStorage.getItem(OWNER_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(OWNER_KEY, id); }
    return id;
  } catch {
    try {
      let id = sessionStorage.getItem(OWNER_KEY);
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(OWNER_KEY, id); }
      return id;
    } catch {
      transientOwner ??= crypto.randomUUID();
      return transientOwner;
    }
  }
}

/** Signed in: the Supabase access token; otherwise this browser's anonymous project key. */
export const ownerHeaders = (): Record<string, string> => {
  const token = currentAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : { 'X-PaperDesk-Owner': projectOwnerId() };
};

/** Uses same-origin `/api` during development and the configured backend origin in production. */
export function apiUrl(path: string) {
  return `${configuredApi}${path.startsWith('/') ? path : `/${path}`}`;
}

export const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

/** Render's free web service may return its proxy page or briefly refuse connections while it wakes. */
export async function fetchWithWake(url: string, init: RequestInit, waking: () => void, attempts = 24) {
  let response: Response | undefined;
  let needsWake = false;
  try {
    response = await fetch(url, init);
    if (response.status === 502 || response.status === 504) needsWake = true;
    else if (response.status === 503) {
      const body = await response.clone().json().catch(() => null) as { error?: string } | null;
      needsWake = !body?.error || !/Docker isn’t running|compiler image|LaTeX tools are not installed/i.test(body.error);
    }
  } catch (error) {
    // A cancelled compile is not a sleeping server.
    if (init.signal?.aborted) throw error;
    needsWake = true;
  }

  if (!needsWake && response) return response;
  waking();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(5_000);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const health = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
      if (!health.ok) continue;
      const retried = await fetch(url, init);
      if (retried.status !== 502 && retried.status !== 504) return retried;
    } catch { /* keep polling the sleeping instance */ }
  }
  throw new Error('The compile server did not wake up. Please try again in a moment.');
}
