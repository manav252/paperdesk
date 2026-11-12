import type { Session, SupabaseClient } from '@supabase/supabase-js';

// Supabase sign-in. The project URL and publishable ("anon") key are public by design: they only let the browser
// talk to Supabase Auth. Which projects a user may open is decided by PaperDesk's API from the verified token.
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');
export const authConfigured = !!(SUPABASE_URL && SUPABASE_KEY);

export type Account = { id: string; email?: string; name?: string; avatar?: string };
/** Project ids that changed when an anonymous browser's projects moved to the account. */
export type Moved = { from: string; to: string }[];

const OWNER_KEY = 'paperdesk-owner-id';
const CLAIMED_KEY = 'paperdesk-claimed-owner';
let accessToken: string | null = null;
let account: Account | null = null;
const listeners = new Set<(account: Account | null) => void>();
export const currentAccessToken = () => accessToken;
export const currentAccount = () => account;

let clientPromise: Promise<SupabaseClient> | null = null;
function client() {
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_KEY, {
      // PKCE returns ?code=… instead of a #token fragment, which would clash with the #/paper/… routes.
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'paperdesk-auth',
      },
    }),
  );
  return clientPromise;
}

const toAccount = (session: Session | null): Account | null => {
  const user = session?.user;
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email,
    name: typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : undefined,
    avatar: typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined,
  };
};
function setSession(session: Session | null) {
  accessToken = session?.access_token ?? null;
  const next = toAccount(session);
  const changed = next?.id !== account?.id;
  account = next;
  if (changed) listeners.forEach((listener) => listener(account));
}

export function onAccountChange(listener: (account: Account | null) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Moves this browser's anonymous projects to the signed-in account, once per anonymous key. */
async function claimAnonymousProjects(apiBase: string): Promise<Moved> {
  let anonymous: string | null = null;
  try {
    anonymous = localStorage.getItem(OWNER_KEY);
  } catch {
    return [];
  }
  if (!anonymous || !accessToken) return [];
  try {
    if (localStorage.getItem(CLAIMED_KEY) === `${anonymous}:${account?.id}`) return [];
  } catch {
    /* claim anyway */
  }
  const response = await fetch(`${apiBase}/api/account/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ anonymousId: anonymous }),
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({}))).error ?? 'Your projects could not be moved to your account.',
    );
  try {
    localStorage.setItem(CLAIMED_KEY, `${anonymous}:${account?.id}`);
  } catch {
    /* moving again finds nothing */
  }
  return ((await response.json()).moved ?? []) as Moved;
}

let readyPromise: Promise<{ moved: Moved; error?: string }> | null = null;
/**
 * Restores the saved session (or finishes a sign-in redirect) and moves anonymous projects to the account.
 * API requests wait for this, so none is sent as the anonymous browser by mistake. Never rejects.
 */
export function authReady(apiBase = String(import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')) {
  readyPromise ??= (async () => {
    if (!authConfigured) return { moved: [] };
    try {
      const supabase = await client();
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      supabase.auth.onAuthStateChange((_event, session) => setSession(session));
      // Drop the one-time ?code=… from the address bar after the redirect.
      const url = new URL(location.href);
      if (url.searchParams.has('code')) {
        url.searchParams.delete('code');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      }
      const moved = data.session ? await claimAnonymousProjects(apiBase) : [];
      return { moved };
    } catch (error) {
      return { moved: [], error: error instanceof Error ? error.message : 'Sign-in could not be restored.' };
    }
  })();
  return readyPromise;
}

let providersPromise: Promise<{ google: boolean }> | null = null;
/** Which sign-in methods the Supabase project has switched on (so a disabled one isn't offered). */
export function enabledProviders() {
  providersPromise ??= fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } })
    .then((r) => (r.ok ? r.json() : null))
    .then((settings) => ({ google: settings?.external?.google === true }))
    .catch(() => ({ google: false }));
  return providersPromise;
}

export const JOIN_KEY = 'paperdesk-pending-join',
  OPEN_KEY = 'paperdesk-pending-open';
/** Where sign-in returns to. It carries the invite or project being opened, so it survives a different tab or browser. */
const redirectTo = (keepTarget = true) => {
  const url = new URL(`${location.origin}${location.pathname}`);
  try {
    const join = keepTarget && localStorage.getItem(JOIN_KEY),
      open = keepTarget && localStorage.getItem(OPEN_KEY);
    if (join) url.searchParams.set('join', join);
    else if (open) url.searchParams.set('open', open);
  } catch {
    /* no storage: sign-in returns to the dashboard */
  }
  return url.toString();
};

export async function signInWithGoogle() {
  const { error } = await (
    await client()
  ).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } });
  if (error) throw error;
}

export async function sendSignInLink(email: string) {
  const { error } = await (
    await client()
  ).auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo(), shouldCreateUser: true } });
  if (error) throw error;
}

/** Signs out and forgets this browser's copies, so the next person on this computer starts empty. */
export async function signOut() {
  await (await client()).auth.signOut().catch(() => undefined);
  try {
    localStorage.removeItem('paperdesk-projects');
    localStorage.removeItem(OWNER_KEY);
    localStorage.removeItem(CLAIMED_KEY);
  } catch {
    /* storage unavailable: nothing kept */
  }
  location.assign(redirectTo(false));
}
