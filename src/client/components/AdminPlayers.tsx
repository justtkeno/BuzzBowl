import { useEffect, useState } from 'react';
import { adminDeleteAccount, adminResetProfile, adminUnlockBadges } from '../account';
import { call } from '../socket';

interface OnlinePerson { key: string; name: string; username: string | null; admin: boolean; screens: number; rooms: string[]; busy: boolean }
interface Found { key: string; username: string; displayName: string; createdAt: number; admin: boolean; email: boolean; emailVerified: boolean; usernameChangedAt: number | null; online: boolean }

type Run = (fn: () => Promise<string | void>) => Promise<void>;

/** Players tab: who's on the site right now, and account search with moderation and a few tricks. */
export function AdminPlayers({ run, busy }: { run: Run; busy: boolean }) {
  const [online, setOnline] = useState<OnlinePerson[] | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);

  const loadOnline = () => call<{ people: OnlinePerson[] }>('site:online').then((r) => setOnline(r.people), () => {});
  useEffect(() => {
    void loadOnline();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadOnline(); }, 5000);
    return () => clearInterval(t);
  }, []);

  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    void run(async () => { setFound((await call<{ users: Found[] }>('site:users', q.trim())).users); });
  };
  const whisper = (key: string, name: string) => {
    const text = prompt(`Whisper to ${name} (a big message only they see):`);
    if (text?.trim()) void run(async () => { const r = await call<{ sent: number }>('site:whisper', { key, text }); return `Whispered to ${name} on ${r.sent} screen${r.sent === 1 ? '' : 's'}.`; });
  };
  const shake = (key: string, name: string) => void run(async () => { const r = await call<{ sent: number }>('site:shake', key); return r.sent ? `Shook ${name}’s screen.` : `${name} can’t be shaken right now.`; });
  const logout = (u: Found) => {
    if (!confirm(`Log @${u.username} out on every device?`)) return;
    void run(async () => { await call('site:logoutUser', u.username); return `@${u.username} is logged out everywhere.`; });
  };
  const reset = (u: Found, name: boolean, bio: boolean) => void run(async () => {
    await adminResetProfile(u.username, { name, bio });
    if (name) setFound((f) => f?.map((x) => (x.username === u.username ? { ...x, displayName: x.username } : x)) ?? null);
    return name ? `@${u.username}’s display name is back to their username.` : `@${u.username}’s bio is cleared.`;
  });
  const badges = (u: Found, unlock: boolean) => void run(async () => {
    await adminUnlockBadges(u.username, unlock);
    return unlock ? `Every badge is unlocked for @${u.username}.` : `@${u.username}’s badges are back to the ones they earned.`;
  });
  const remove = (u: Found) => {
    if (prompt(`This deletes @${u.username}, their games and friends for good. Type their username to confirm:`) !== u.username) return;
    void run(async () => {
      await adminDeleteAccount(u.username);
      setFound((f) => f?.filter((x) => x.username !== u.username) ?? null);
      return `Deleted @${u.username}.`;
    });
  };

  return (
    <>
      <div className="row between">
        <h3>Online now{online ? ` (${online.length})` : ''}</h3>
        <button className="btn small ghost" onClick={() => void loadOnline()}>Refresh</button>
      </div>
      {online && !online.length && <p className="muted small">Nobody else is online.</p>}
      <ul className="admin-list">
        {online?.map((p) => (
          <li key={p.key}>
            <div className="admin-list-name">
              {p.username ? <a href={`/u/${p.username}`} target="_blank" rel="noreferrer">{p.name}</a> : p.name}
              {p.username ? <span className="muted small"> @{p.username}</span> : <span className="badge">guest</span>}
              {p.admin && <span className="badge">admin</span>}
              <span className="muted small"> · {p.rooms.length ? p.rooms.join(', ') : 'home screen'}{p.screens > 1 ? ` · ${p.screens} screens` : ''}{p.busy ? ' · in a daily or survival run' : ''}</span>
            </div>
            {!p.admin && (
              <div className="row gap admin-list-actions">
                <button className="btn small" disabled={busy || p.busy} onClick={() => whisper(p.key, p.name)}>Whisper</button>
                <button className="btn small" disabled={busy || p.busy} onClick={() => shake(p.key, p.name)}>Shake</button>
                {p.rooms.filter((r) => !r.startsWith('watching')).slice(0, 1).map((r) => <a key={r} className="btn small ghost" href={`/watch/${r}`} target="_blank" rel="noreferrer">Watch {r}</a>)}
              </div>
            )}
          </li>
        ))}
      </ul>

      <h3>Find an account</h3>
      <form className="row gap" onSubmit={search}>
        <input className="grow" value={q} maxLength={21} autoCapitalize="off" spellCheck={false} placeholder="Username or part of it" aria-label="Search usernames" onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={busy || !q.trim()}>Search</button>
      </form>
      {found && !found.length && <p className="muted small">No usernames match.</p>}
      <ul className="admin-list">
        {found?.map((u) => (
          <li key={u.key}>
            <div className="admin-list-name">
              <a href={`/u/${u.username}`} target="_blank" rel="noreferrer">{u.displayName}</a>
              <span className="muted small"> @{u.username}</span>
              {u.admin && <span className="badge">admin</span>}
              {u.online && <span className="badge ok">online</span>}
              <div className="muted small">
                Joined {new Date(u.createdAt).toLocaleDateString()} · {u.email ? (u.emailVerified ? 'email confirmed' : 'email not confirmed') : 'no email'}
                {u.usernameChangedAt ? ` · renamed ${new Date(u.usernameChangedAt).toLocaleDateString()}` : ''}
              </div>
            </div>
            {!u.admin && (
              <div className="row gap admin-list-actions">
                {u.online && <button className="btn small" disabled={busy} onClick={() => whisper(u.key, u.displayName)}>Whisper</button>}
                <button className="btn small" disabled={busy} onClick={() => reset(u, true, false)}>Reset name</button>
                <button className="btn small" disabled={busy} onClick={() => reset(u, false, true)}>Clear bio</button>
                <button className="btn small" disabled={busy} onClick={() => badges(u, true)}>Unlock badges</button>
                <button className="btn small ghost" disabled={busy} onClick={() => badges(u, false)}>Re-lock badges</button>
                <button className="btn small" disabled={busy} onClick={() => logout(u)}>Log out everywhere</button>
                <button className="btn small bad" disabled={busy} onClick={() => remove(u)}>Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Emails stay private: you only see whether someone has one.</p>
    </>
  );
}
