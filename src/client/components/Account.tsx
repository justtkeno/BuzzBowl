import { useEffect, useRef, useState } from 'react';
import { EMAIL_RE, PASSWORD_MIN, USERNAME_RE } from '../../shared/accounts';
import { DEFAULT_COLOR, DEFAULT_FRAME, colorById } from '../../shared/profile';
import { confirmEmail, forgotPassword, login, logout, resetPassword, signup, useAccount } from '../account';
import { useTheme } from '../App';
import '../accounts.css';
import { SiteAdminPanel } from './SiteAdmin';
import { Icon } from './Icon';

/**
 * Class and style that give an element (and what's inside it) a profile color as its accent, in either theme.
 * The default color leaves the site's own accent alone unless `force` is set (for previews inside a tinted card).
 */
export function tint(color: string | undefined, force = false): { className?: string; style?: React.CSSProperties } {
  if (!force && (!color || color === DEFAULT_COLOR)) return {};
  const c = colorById(color);
  return { className: 'tinted', style: { '--c-light': c.light, '--c-dark': c.dark } as React.CSSProperties };
}

/** A player's avatar: the first letter of their name in their profile color, with their frame. */
export function Avatar({ name, color, frame, size, className, force, children }: {
  name: string; color?: string; frame?: string; size?: 'big'; className?: string; force?: boolean; children?: React.ReactNode;
}) {
  const t = tint(color, force);
  const cls = ['avatar', size, frame && frame !== DEFAULT_FRAME ? `frame-${frame}` : '', t.className, className].filter(Boolean).join(' ');
  return (
    <span className={cls} style={t.style} aria-hidden="true">
      {(Array.from(name.trim())[0] ?? '?').toUpperCase()}
      {children}
    </span>
  );
}

/** Small check mark next to a logged-in player's name, linking to their profile. Admins get a creator badge too. */
export function Verified({ username, admin }: { username?: string; admin?: boolean }) {
  if (!username) return null;
  return (
    <>
      <a className="verified" href={`/u/${username}`} target="_blank" rel="noreferrer" title={`Signed in as @${username} · view profile`} aria-label={`Verified account @${username}, view profile`}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 0l1.9 1.4 2.3-.2.8 2.2 2 1.2-.6 2.3.6 2.3-2 1.2-.8 2.2-2.3-.2L8 16l-1.9-1.4-2.3.2-.8-2.2-2-1.2.6-2.3L1 6.8l2-1.2.8-2.2 2.3.2L8 0zm-1 10.6l4.6-4.6-1-1L7 8.6 5.4 7l-1 1L7 10.6z" /></svg>
      </a>
      {admin && <CreatorBadge username={username} />}
    </>
  );
}

/** The site creator's badge. */
export function CreatorBadge({ username }: { username?: string }) {
  const inner = <><Crown />creator</>;
  return username
    ? <a className="creator-badge" href={`/u/${username}`} target="_blank" rel="noreferrer" title="Trivio creator · view profile">{inner}</a>
    : <span className="creator-badge" title="Trivio creator">{inner}</span>;
}

function Crown() {
  return <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M1 4l3.5 3L8 2l3.5 5L15 4l-1.5 8h-11L1 4zm1.5 9.5h11V15h-11v-1.5z" /></svg>;
}

/** Log in / sign up buttons, or who you are when logged in. */
export function AccountBar() {
  const { me, loaded } = useAccount();
  const [open, setOpen] = useState<null | 'login' | 'signup'>(null);
  const [admin, setAdmin] = useState(false);
  if (!loaded) return <div className="account-bar" />;
  return (
    <div className="account-bar">
      {me ? (
        <>
          <a className="account-me" href={`/u/${me.username}`}>
            <Avatar name={me.displayName} color={me.color} frame={me.frame} />
            <span>{me.displayName}</span>
            {me.admin && <CreatorBadge />}
            <span className="muted small">@{me.username}</span>
          </a>
          {me.admin && <button className="btn ghost small" onClick={() => setAdmin(true)} title="Site admin: announce to everyone, rooms, badges" aria-label="Site admin"><Icon name="shield" /></button>}
          <button className="btn ghost small" onClick={() => void logout()}>Log out</button>
        </>
      ) : (
        <>
          <span className="muted small grow">Playing as a guest</span>
          <button className="btn ghost small" onClick={() => setOpen('login')}>Log in</button>
          <button className="btn small" onClick={() => setOpen('signup')}>Sign up</button>
        </>
      )}
      {open && <AccountDialog initial={open} onClose={() => setOpen(null)} />}
      {admin && <SiteAdminPanel onClose={() => setAdmin(false)} />}
    </div>
  );
}

export function AccountDialog({ initial, onClose }: { initial: 'login' | 'signup'; onClose: () => void }) {
  const [tab, setTab] = useState<'login' | 'signup' | 'forgot'>(initial);
  const { emailOn } = useAccount();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => { first.current?.focus(); setErr(null); setSent(false); }, [tab]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    const em = email.trim();
    if (tab === 'signup') {
      if (!USERNAME_RE.test(u)) return setErr('Usernames are 3–20 letters, numbers or underscores.');
      if (em && !EMAIL_RE.test(em)) return setErr('That email address doesn’t look right.');
      if (password.length < PASSWORD_MIN) return setErr(`Passwords need at least ${PASSWORD_MIN} characters.`);
    }
    setBusy(true);
    setErr(null);
    try {
      if (tab === 'forgot') { await forgotPassword(u); setSent(true); return; }
      if (tab === 'signup') await signup(u, password, displayName.trim() || u, em);
      else await login(u, password);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (tab === 'forgot') {
    return (
      <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <form className="modal account-dialog" onSubmit={submit} aria-label="Reset your password">
          <h2>Reset your password</h2>
          {sent ? (
            <>
              <p>If that account has an email address, a reset link is on its way. It works for an hour. Check your spam folder too.</p>
              <p className="muted small">No email on the account? Then it can’t be reset. You can make a new account.</p>
              <div className="row gap end"><button type="button" className="btn primary" onClick={() => setTab('login')}>Back to log in</button></div>
            </>
          ) : (
            <>
              <p className="muted small">We’ll email a link to the address on your account.</p>
              <label className="field">
                <span>Username or email</span>
                <input ref={first} value={username} maxLength={254} autoComplete="username" autoCapitalize="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
              </label>
              {err && <p className="error">{err}</p>}
              <div className="row gap end">
                <button type="button" className="btn ghost" onClick={() => setTab('login')}>Back</button>
                <button className="btn primary" disabled={busy || !username.trim()}>Send reset link</button>
              </div>
            </>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal account-dialog" onSubmit={submit} aria-label={tab === 'signup' ? 'Create an account' : 'Log in'}>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'login'} className={tab === 'login' ? 'on' : ''} onClick={() => setTab('login')}>Log in</button>
          <button type="button" role="tab" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'on' : ''} onClick={() => setTab('signup')}>Sign up</button>
        </div>
        {tab === 'signup' && <p className="muted small">An account keeps your stats from every game on a public profile, puts a check mark by your name, lets you add friends and join their games, and remembers your name and room settings on any device.</p>}
        <label className="field">
          <span>{tab === 'signup' ? 'Username' : 'Username or email'}</span>
          <input ref={first} value={username} maxLength={tab === 'signup' ? 20 : 254} autoComplete="username" autoCapitalize="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} placeholder={tab === 'signup' ? 'letters, numbers, _' : ''} />
        </label>
        {tab === 'signup' && (
          <label className="field">
            <span>Display name <span className="muted">(what others see in games; optional)</span></span>
            <input value={displayName} maxLength={24} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || 'e.g. Alex'} />
          </label>
        )}
        {tab === 'signup' && (
          <label className="field">
            <span>Email <span className="muted">(optional, to reset a forgotten password; never shown)</span></span>
            <input type="email" value={email} maxLength={254} autoComplete="email" autoCapitalize="off" spellCheck={false} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
        )}
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} onChange={(e) => setPassword(e.target.value)} placeholder={tab === 'signup' ? `at least ${PASSWORD_MIN} characters` : ''} />
        </label>
        {err && <p className="error">{err}</p>}
        <div className="row gap end">
          {tab === 'login' && emailOn && <button type="button" className="link grow forgot" onClick={() => setTab('forgot')}>Forgot password?</button>}
          {tab === 'login' && !emailOn && <span className="grow" />}
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !username.trim() || !password}>{tab === 'signup' ? 'Create account' : 'Log in'}</button>
        </div>
        {tab === 'signup' && !email.trim() && <p className="muted small">Without an email, a forgotten password can’t be reset. You can add one later on your profile.</p>}
        {tab === 'signup' && !!email.trim() && <p className="muted small">We’ll email you a link to confirm it. That’s optional: resets work either way.</p>}
      </form>
    </div>
  );
}

/** The page an emailed reset link opens (/reset#token). */
export function ResetPassword() {
  useTheme();
  const [token] = useState(() => location.hash.slice(1));
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = 'Reset password · Trivio';
    // Keep the token out of the address bar and history once it's read.
    if (token) history.replaceState(null, '', '/reset');
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) return setErr(`Passwords need at least ${PASSWORD_MIN} characters.`);
    if (password !== again) return setErr('The two passwords don’t match.');
    setBusy(true); setErr(null);
    try { await resetPassword(token, password); setDone(true); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back reset-page">
      <form className="modal account-dialog" onSubmit={submit} aria-label="Choose a new password">
        <h2>Choose a new password</h2>
        {!token ? (
          <><p>This link is missing its code. Open the link from the email again, or ask for a new one from Log in → Forgot password.</p><a className="btn primary" href="/">Go to Trivio</a></>
        ) : done ? (
          <><p>Your password is changed and you’re logged in. Any other devices were logged out.</p><a className="btn primary" href="/">Go to Trivio</a></>
        ) : (
          <>
            <label className="field"><span>New password</span>
              <input type="password" autoFocus value={password} autoComplete="new-password" placeholder={`at least ${PASSWORD_MIN} characters`} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field"><span>Type it again</span>
              <input type="password" value={again} autoComplete="new-password" onChange={(e) => setAgain(e.target.value)} />
            </label>
            {err && <p className="error">{err}</p>}
            <div className="row gap end"><a className="btn ghost" href="/">Cancel</a><button className="btn primary" disabled={busy || !password || !again}>Save password</button></div>
          </>
        )}
      </form>
    </div>
  );
}

/** The page an emailed confirmation link opens (/confirm#token). */
export function ConfirmEmail() {
  useTheme();
  const [token] = useState(() => location.hash.slice(1));
  const [result, setResult] = useState<{ ok: true; username: string } | { ok: false; error: string } | null>(null);
  const once = useRef(false);

  useEffect(() => {
    document.title = 'Confirm email · Trivio';
    if (once.current) return;
    once.current = true;
    if (!token) { setResult({ ok: false, error: 'This link is missing its code. Open the link from the email again.' }); return; }
    history.replaceState(null, '', '/confirm');
    confirmEmail(token).then((username) => setResult({ ok: true, username }), (e) => setResult({ ok: false, error: e.message }));
  }, [token]);

  return (
    <div className="modal-back reset-page">
      <div className="modal account-dialog" role="dialog" aria-label="Confirm your email">
        <h2>{!result ? 'Confirming…' : result.ok ? 'Email confirmed' : 'Couldn’t confirm'}</h2>
        {result && <p>{result.ok ? `Password-reset links for @${result.username} will go to this address.` : result.error}</p>}
        {result && <div className="row gap end">{result.ok && <a className="btn ghost" href={`/u/${result.username}`}>Your profile</a>}<a className="btn primary" href="/">Go to Trivio</a></div>}
      </div>
    </div>
  );
}
