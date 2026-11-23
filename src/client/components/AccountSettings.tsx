import { useState } from 'react';
import { EMAIL_RE, PASSWORD_MIN, USERNAME_COOLDOWN_DAYS, USERNAME_RE, type Me } from '../../shared/accounts';
import { changePassword, changeUsername, logout, savePresets, sendConfirmEmail, updateMe, useAccount } from '../account';
import { PRESET_NAME_MAX, PRESET_SLOTS, cleanPresetName, presetSummary, type Preset } from '../../shared/presets';
import { sharePreset } from './Presets';
import { AccountDialog } from './Account';

const DAY = 86_400_000;
const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Account settings: username (once a week), email and its optional confirmation, password, log out. */
export function AccountSettings({ onClose }: { onClose: () => void }) {
  const { me } = useAccount();
  const [dialog, setDialog] = useState<null | 'login' | 'signup'>(null);

  if (!me) {
    return (
      <>
        <div className="as-body">
          <section className="as-group">
            <h3>Account</h3>
            <p>You’re playing as a guest. An account keeps your stats from every game, lets you add friends, and remembers your name and settings on any device.</p>
            <div className="row gap"><button className="btn primary" onClick={() => setDialog('signup')}>Sign up</button><button className="btn" onClick={() => setDialog('login')}>Log in</button></div>
          </section>
        </div>
        {dialog && <AccountDialog initial={dialog} onClose={() => setDialog(null)} />}
      </>
    );
  }

  return (
    <>
      <div className="as-body account-settings">
        <UsernameSection me={me} />
        <EmailSection me={me} />
        <PasswordSection />
        <PresetsSection me={me} />
        <section className="as-group">
          <h3>Profile</h3>
          <p className="muted small">Display name, bio, colors, pinned stats and who can see your profile are under <a href={`/u/${me.username}`}>Edit profile</a>.</p>
        </section>
      </div>
      <div className="row between as-foot">
        <button className="btn ghost" onClick={() => { void logout(); onClose(); }}>Log out</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

/** Shared busy / error / done state for the small forms below. */
function useForm() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setErr(null); setDone(null);
    try { setDone(await fn()); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return { busy, err, done, run, setErr };
}

function UsernameSection({ me }: { me: Me }) {
  const [name, setName] = useState(me.username);
  const f = useForm();
  const next = me.usernameChangedAt ? me.usernameChangedAt + USERNAME_COOLDOWN_DAYS * DAY : 0;
  const waiting = Date.now() < next;
  const clean = name.trim();
  const changed = clean !== me.username;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!USERNAME_RE.test(clean)) return f.setErr('Usernames are 3–20 letters, numbers or underscores.');
    if (!confirm(`Change your username to @${clean}? You won’t be able to change it again for ${USERNAME_COOLDOWN_DAYS} days.`)) return;
    const old = me.username;
    void f.run(async () => {
      const u = await changeUsername(clean);
      // On your own profile, follow it to the new address.
      if (location.pathname.toLowerCase() === `/u/${old.toLowerCase()}`) location.replace(`/u/${u.username}`);
      return `You’re now @${u.username}.`;
    });
  };

  return (
    <form className="as-group" onSubmit={save}>
      <h3>Username</h3>
      <div className="row gap as-inline">
        <input className="grow" value={name} maxLength={20} autoCapitalize="off" spellCheck={false} disabled={waiting || f.busy}
          aria-label="Username" onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={waiting || f.busy || !changed || !clean}>Change</button>
      </div>
      <small className="muted">
        {waiting
          ? `You changed it recently. You can change it again ${when(next)}.`
          : `Your profile link becomes /u/${clean || 'name'}. After a change, you have to wait ${USERNAME_COOLDOWN_DAYS} days to change it again.`}
      </small>
      {f.err && <p className="error small">{f.err}</p>}
      {f.done && <p className="as-done small">{f.done}</p>}
    </form>
  );
}

function EmailSection({ me }: { me: Me }) {
  const [email, setEmail] = useState(me.email ?? '');
  const [password, setPassword] = useState('');
  const f = useForm();
  const clean = email.trim().toLowerCase();
  const changed = clean !== (me.email ?? '');

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (clean && !EMAIL_RE.test(clean)) return f.setErr('That email address doesn’t look right.');
    void f.run(async () => {
      await updateMe({ email: clean, password });
      setPassword('');
      return clean ? 'Saved. We sent a link to confirm it (optional).' : 'Email removed.';
    });
  };

  return (
    <form className="as-group" onSubmit={save}>
      <h3>Email</h3>
      <input type="email" value={email} maxLength={254} autoComplete="email" autoCapitalize="off" spellCheck={false} placeholder="you@example.com"
        aria-label="Email" onChange={(e) => setEmail(e.target.value)} />
      <EmailStatus email={clean} changed={changed} />
      {changed && (
        <div className="row gap as-inline">
          <input className="grow" type="password" value={password} autoComplete="current-password" placeholder="Current password" aria-label="Current password"
            onChange={(e) => setPassword(e.target.value)} />
          <button className="btn" disabled={f.busy || !password}>{clean ? 'Save' : 'Remove'}</button>
        </div>
      )}
      <small className="muted">Only you see it. It’s used to reset a forgotten password, and you can log in with it.</small>
      {f.err && <p className="error small">{f.err}</p>}
      {f.done && <p className="as-done small">{f.done}</p>}
    </form>
  );
}

/** Whether the saved email is confirmed, and a way to send the (optional) confirmation link. */
function EmailStatus({ email, changed }: { email: string; changed: boolean }) {
  const { me, emailOn } = useAccount();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);
  if (!email) return <small className="muted">Without an email, a forgotten password can’t be reset.</small>;
  if (me?.emailVerified && !changed) return <small className="email-ok">✓ Confirmed</small>;
  // Until the server can send email, there's no link to offer: just keep the address.
  if (!emailOn) return <small className="muted">{changed ? 'Enter your current password to save it.' : 'Saved for password resets.'}</small>;
  if (changed) return <small className="muted">Enter your current password to save it. We’ll email a link to confirm it; confirming is optional.</small>;
  const send = async () => {
    setState('busy'); setErr(null);
    try { await sendConfirmEmail(); setState('sent'); } catch (e: any) { setErr(e.message); setState('idle'); }
  };
  return (
    <small className="muted">
      Not confirmed (optional).{' '}
      {state === 'sent' ? 'Link sent. Check your inbox and spam folder.' : <button type="button" className="link" disabled={state === 'busy'} onClick={send}>Send a confirmation link</button>}
      {err && <span className="error"> {err}</span>}
    </small>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const f = useForm();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) return f.setErr(`Passwords need at least ${PASSWORD_MIN} characters.`);
    if (password !== again) return f.setErr('The two new passwords don’t match.');
    void f.run(async () => {
      await changePassword(current, password);
      setCurrent(''); setPassword(''); setAgain('');
      return 'Password changed. Your other devices were logged out.';
    });
  };

  return (
    <form className="as-group" onSubmit={save}>
      <h3>Password</h3>
      <input type="password" value={current} autoComplete="current-password" placeholder="Current password" aria-label="Current password" onChange={(e) => setCurrent(e.target.value)} />
      <input type="password" value={password} autoComplete="new-password" placeholder={`New password (at least ${PASSWORD_MIN} characters)`} aria-label="New password" onChange={(e) => setPassword(e.target.value)} />
      <div className="row gap as-inline">
        <input className="grow" type="password" value={again} autoComplete="new-password" placeholder="New password again" aria-label="New password again" onChange={(e) => setAgain(e.target.value)} />
        <button className="btn" disabled={f.busy || !current || !password || !again}>Change</button>
      </div>
      {f.err && <p className="error small">{f.err}</p>}
      {f.done && <p className="as-done small">{f.done}</p>}
    </form>
  );
}

/** Their saved game presets: share, rename or delete. New ones are saved from a room's lobby. */
function PresetsSection({ me }: { me: Me }) {
  const f = useForm();
  const list = me.presets;
  const rename = (p: Preset) => {
    const n = prompt(`New name (up to ${PRESET_NAME_MAX} characters):`, p.name);
    const name = n === null ? '' : cleanPresetName(n);
    if (name) void f.run(async () => { await savePresets(list.map((x) => (x.id === p.id ? { ...x, name } : x))); return `Renamed to “${name}”.`; });
  };
  const remove = (p: Preset) => {
    if (confirm(`Delete the preset “${p.name}”?`)) void f.run(async () => { await savePresets(list.filter((x) => x.id !== p.id)); return `Deleted “${p.name}”.`; });
  };
  return (
    <section className="as-group">
      <h3>My game presets <span className="muted">({list.length}/{PRESET_SLOTS})</span></h3>
      {!list.length && <small className="muted">None yet. In a room’s lobby, set the rules you like and choose “Save the current rules as a preset”.</small>}
      <ul className="preset-slots compact">
        {list.map((p) => (
          <li key={p.id}>
            <div className="preset-slot-use static"><b>{p.name}</b><small>{presetSummary(p.settings)}</small></div>
            <div className="preset-slot-actions">
              <button type="button" className="link small" onClick={() => void sharePreset(p.name, p.settings)}>Share</button>
              <button type="button" className="link small" disabled={f.busy} onClick={() => rename(p)}>Rename</button>
              <button type="button" className="link small danger" disabled={f.busy} onClick={() => remove(p)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      {f.err && <p className="error small">{f.err}</p>}
      {f.done && <p className="as-done small">{f.done}</p>}
    </section>
  );
}
