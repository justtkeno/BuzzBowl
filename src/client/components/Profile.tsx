import { useEffect, useState } from 'react';
import { BEST_SUBJECT_MIN_HEARD, BIO_MAX, type GameRecord, type PublicProfile } from '../../shared/accounts';
import { fetchProfile, updateMe, useAccount } from '../account';
import { useTheme } from '../App';
import { AccountBar } from './Account';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fixed = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] ?? 'th'}`;
const when = (t: number) => {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

export function Profile({ username }: { username: string }) {
  useTheme();
  const { me } = useAccount();
  const [p, setP] = useState<PublicProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setP(null); setErr(null);
    fetchProfile(username).then(setP, (e) => setErr(e.message));
  }, [username]);

  useEffect(() => { document.title = p ? `${p.displayName} (@${p.username}) · BuzzBowl` : 'BuzzBowl'; }, [p]);

  const mine = !!me && !!p && me.username.toLowerCase() === p.username.toLowerCase();

  return (
    <div className="profile-page">
      <header className="profile-top">
        <a className="brand small" href="/"><span className="logo">QB</span> BuzzBowl</a>
        <AccountBar />
      </header>
      <main className="profile">
        {err && <div className="card"><h2>Player not found</h2><p className="muted">{err}</p><a className="btn" href="/">Back to BuzzBowl</a></div>}
        {!p && !err && <p className="muted">Loading profile…</p>}
        {p && (
          <>
            <section className="card profile-head">
              <span className="avatar big" aria-hidden="true">{p.displayName.slice(0, 1).toUpperCase()}</span>
              <div className="grow">
                <h1>{p.displayName} <span className="verified" title="Verified BuzzBowl account"><Check /></span></h1>
                <div className="muted small">@{p.username} · joined {new Date(p.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
                {editing ? <EditProfile p={p} onDone={(np) => { if (np) setP(np); setEditing(false); }} /> : p.bio && <p className="bio">{p.bio}</p>}
              </div>
              <div className="row gap">
                {mine && !editing && <button className="btn small" onClick={() => setEditing(true)}>Edit profile</button>}
                <CopyLink />
              </div>
            </section>

            {p.totals.games === 0 ? (
              <section className="card">
                <h2>No games yet</h2>
                <p className="muted">{mine ? 'Play a game while logged in and your stats will show up here once the game ends.' : `${p.displayName} hasn’t finished a game yet.`}</p>
                {mine && <a className="btn primary" href="/">Play now</a>}
              </section>
            ) : (
              <>
                <Tiles p={p} />
                <Subjects p={p} />
                <Recent games={p.recent} />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Check() {
  return <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0l1.9 1.4 2.3-.2.8 2.2 2 1.2-.6 2.3.6 2.3-2 1.2-.8 2.2-2.3-.2L8 16l-1.9-1.4-2.3.2-.8-2.2-2-1.2.6-2.3L1 6.8l2-1.2.8-2.2 2.3.2L8 0zm-1 10.6l4.6-4.6-1-1L7 8.6 5.4 7l-1 1L7 10.6z" /></svg>;
}

function CopyLink() {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* ignore */ }
  };
  return <button className="btn small" onClick={copy}>{done ? 'Copied!' : 'Copy link'}</button>;
}

function EditProfile({ p, onDone }: { p: PublicProfile; onDone: (p: PublicProfile | null) => void }) {
  const [displayName, setDisplayName] = useState(p.displayName);
  const [bio, setBio] = useState(p.bio);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const u = await updateMe({ displayName, bio });
      onDone({ ...p, displayName: u.displayName, bio: u.bio });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <form className="edit-profile" onSubmit={save}>
      <label className="field"><span>Display name</span><input value={displayName} maxLength={24} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="field"><span>Bio <span className="muted">({bio.length}/{BIO_MAX})</span></span>
        <textarea value={bio} maxLength={BIO_MAX} rows={2} placeholder="Favorite categories, team, school…" onChange={(e) => setBio(e.target.value)} />
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row gap"><button className="btn primary small" disabled={busy || !displayName.trim()}>Save</button><button type="button" className="btn ghost small" onClick={() => onDone(null)}>Cancel</button></div>
    </form>
  );
}

function Tiles({ p }: { p: PublicProfile }) {
  const t = p.totals;
  const tiles: { label: string; value: string; sub?: string; tone?: string }[] = [
    { label: 'Games', value: String(t.games), sub: `${plural(t.heard, 'tossup')} heard` },
    t.competitive
      ? { label: 'Wins', value: String(t.wins), sub: `${pct(t.wins / t.competitive)} of ${plural(t.competitive, 'game')} vs. others`, tone: 'accent' }
      : { label: 'Wins', value: '–', sub: 'only solo games so far' },
    { label: 'Points / game', value: fixed(t.points / t.games), sub: `${t.points} total` },
    { label: 'Points / tossup', value: t.heard ? fixed(t.points / t.heard, 2) : '–', sub: 'PPTH' },
    { label: 'Powers', value: String(t.powers), sub: `${plural(t.tens, 'ten')} · ${plural(t.negs, 'neg')}`, tone: 'power' },
    { label: 'Buzz accuracy', value: t.buzzes ? pct((t.powers + t.tens) / t.buzzes) : '–', sub: `${t.buzzes} buzz${t.buzzes === 1 ? '' : 'es'}` },
    { label: 'Buzz depth', value: t.avgCorrectDepth != null ? pct(t.avgCorrectDepth) : '–', sub: 'into the question, on gets' },
    { label: 'Best game', value: String(t.bestGame), sub: `longest streak ${t.bestStreak}` },
  ];
  if (t.bonusesHeard) tiles.push({ label: 'Bonus PPB', value: fixed(t.bonusPoints / t.bonusesHeard), sub: `${t.bonusesHeard} bonus${t.bonusesHeard === 1 ? '' : 'es'}` });
  return (
    <section className="tiles">
      {p.bestSubject && (
        <div className="tile best">
          <div className="tile-label">Best subject</div>
          <div className="tile-value">{p.bestSubject}</div>
          <div className="tile-sub">{fixed(p.subjects[0].ppth, 2)} points per tossup</div>
        </div>
      )}
      {tiles.map((x) => (
        <div key={x.label} className={`tile ${x.tone ?? ''}`}>
          <div className="tile-label">{x.label}</div>
          <div className="tile-value">{x.value}</div>
          {x.sub && <div className="tile-sub">{x.sub}</div>}
        </div>
      ))}
    </section>
  );
}

function Subjects({ p }: { p: PublicProfile }) {
  if (!p.subjects.length) return null;
  const max = Math.max(0.01, ...p.subjects.map((s) => Math.abs(s.ppth)));
  return (
    <section className="card">
      <h2>Subjects</h2>
      <p className="muted small">Points per tossup heard in each subject. Subjects need {BEST_SUBJECT_MIN_HEARD} tossups heard to be ranked.</p>
      <div className="subjects">
        {p.subjects.map((s) => {
          const few = s.heard < BEST_SUBJECT_MIN_HEARD;
          return (
            <div key={s.category} className={`subject ${few ? 'few' : ''}`}>
              <div className="subject-name">{s.category}{s.category === p.bestSubject && <span className="badge best-badge">best</span>}</div>
              <div className="subject-bar" title={`${fixed(s.ppth, 2)} points per tossup`}>
                <div className={`fill ${s.ppth < 0 ? 'neg' : ''}`} style={{ width: `${(Math.abs(s.ppth) / max) * 100}%` }} />
              </div>
              <div className="subject-nums">
                <b>{fixed(s.ppth, 2)}</b>
                <span className="muted small">{s.powers}/{s.tens}/{s.negs} · {pct(s.conversion)} of {s.heard}</span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">Numbers after each bar: powers / tens / negs, then how many of the tossups heard were converted.</p>
    </section>
  );
}

function Recent({ games }: { games: GameRecord[] }) {
  return (
    <section className="card">
      <h2>Recent games</h2>
      <ul className="recent">
        {games.map((g, i) => {
          const solo = g.sides < 2;
          const result = solo ? 'Solo' : g.rank === 1 ? 'Won' : `${ordinal(g.rank)} of ${g.sides}`;
          return (
            <li key={`${g.at}-${i}`}>
              <span className={`result ${solo ? '' : g.rank === 1 ? 'win' : 'loss'}`}>{result}</span>
              <div className="grow">
                <div><b>{g.points} pts</b> <span className="muted small">· {g.powers}/{g.tens}/{g.negs} · {plural(g.tossups, 'tossup')} · {g.mode === 'teams' ? 'teams' : 'free-for-all'}{g.abandoned ? ' · unfinished' : ''}</span></div>
                {!solo && (
                  <div className="standings small">
                    {g.standings.map((s, j) => <span key={j} className={s.you ? 'you' : ''}>{s.name} {s.points}</span>)}
                  </div>
                )}
              </div>
              <span className="muted small when">{when(g.at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
