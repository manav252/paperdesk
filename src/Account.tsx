import { useEffect, useRef, useState } from 'react';
import { LogIn, LogOut, Mail, X } from 'lucide-react';
import { authConfigured, currentAccount, enabledProviders, onAccountChange, sendSignInLink, signInWithGoogle, signOut, type Account } from './lib/auth';

export function useAccount() {
  const [account, setAccount] = useState<Account | null>(currentAccount);
  useEffect(() => onAccountChange(setAccount), []);
  return account;
}

/** Header button: “Sign in” when signed out, the account’s initial with a menu when signed in. Hidden if sign-in is off. */
export function AccountButton({ compact = false }: { compact?: boolean }) {
  const account = useAccount();
  const [dialog, setDialog] = useState(false);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  if (!authConfigured) return null;
  if (!account) return <>
    <button className={compact ? 'icon-btn' : 'btn btn-secondary btn-sm'} onClick={() => setDialog(true)} aria-label="Sign in" title="Sign in to keep your projects on any device">
      <LogIn size={14} />{!compact && ' Sign in'}
    </button>
    {dialog && <SignInDialog close={() => setDialog(false)} />}
  </>;
  const label = account.name ?? account.email ?? 'Account';
  return <div className="account" ref={box}>
    <button className="account-button" aria-label={`Account: ${label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)} title={label}>
      {account.avatar ? <img src={account.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{label.slice(0, 1).toUpperCase()}</span>}
    </button>
    {menu && <div className="account-menu" role="menu">
      <div className="account-who"><strong>{account.name ?? 'Signed in'}</strong>{account.email && <span>{account.email}</span>}</div>
      <button role="menuitem" onClick={() => void signOut()}><LogOut size={14} /> Sign out</button>
    </div>}
  </div>;
}

export function SignInDialog({ close, note }: { close: () => void; note?: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{ busy?: 'google' | 'email'; sent?: string; error?: string }>({});
  const [google, setGoogle] = useState(false);
  useEffect(() => { let live = true; void enabledProviders().then(p => { if (live) setGoogle(p.google); }); return () => { live = false; }; }, []);
  const continueWithGoogle = async () => {
    setState({ busy: 'google' });
    try { await signInWithGoogle(); } catch (e) { setState({ error: e instanceof Error ? e.message : 'Google sign-in failed.' }); }
  };
  const sendLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setState({ error: 'Enter a valid email address.' }); return; }
    setState({ busy: 'email' });
    try { await sendSignInLink(email.trim()); setState({ sent: email.trim() }); }
    catch (e) { setState({ error: e instanceof Error ? e.message : 'The sign-in link could not be sent.' }); }
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal sign-in" role="dialog" aria-modal="true" aria-label="Sign in to PaperDesk">
      <div className="modal-head"><h3>Sign in to PaperDesk</h3><button className="icon-btn" aria-label="Close" onClick={close}><X size={17} /></button></div>
      <p className="muted">{note ?? 'Keep your projects on any device. Projects already in this browser move to your account.'}</p>
      {state.sent
        ? <div className="inline-alert success" role="status"><Mail size={15} /><span>Check <strong>{state.sent}</strong> for a sign-in link. Open it in this browser to finish.</span></div>
        : <>
          {google && <>
            <button className="btn btn-secondary sign-in-google" onClick={() => void continueWithGoogle()} disabled={!!state.busy}>
              <GoogleMark /> {state.busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <div className="sign-in-or"><span>or</span></div>
          </>}
          <form onSubmit={e => void sendLink(e)} className="sign-in-email">
            <label htmlFor="sign-in-email">Email</label>
            <input id="sign-in-email" className="text-input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@university.edu" />
            <button className="btn btn-primary" type="submit" disabled={!!state.busy}>{state.busy === 'email' ? 'Sending…' : 'Email me a sign-in link'}</button>
          </form>
        </>}
      {state.error && <div className="inline-alert error" role="alert"><span>{state.error}</span></div>}
    </div>
  </div>;
}

function GoogleMark() {
  return <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" /><path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z" /></svg>;
}
