import { Logo } from './Logo';
import { useEffect, useState } from 'react';
import { BEST_SUBJECT_MIN_HEARD, BIO_MAX, isLocked, type DailyProfile, type GameRecord, type Look, type ProfileView, type PublicProfile, type SurvivalProfile } from '../../shared/accounts';
import {
  AVATAR_FRAMES, BADGE_BY_ID, PIN_MAX, PIN_STATS, PROFILE_COLORS, VISIBILITIES, VISIBILITY_LABEL, colorById, earnedIds, frameById, isUnlocked,
  type Reward, type Visibility, SPECIAL_TITLES, TITLE_MAX, BADGES, type TitleOption,
} from '../../shared/profile';
import { adminDeleteAccount, adminResetProfile, adminSetBadges, adminSetTitles, adminUnlockBadges, fetchProfile, fetchTitles, updateMe, useAccount } from '../account';
import { SettingsMenu } from './AppSettings';
import { Announcement } from './Announcement';
import { CategoryDot } from './CategoryChip';
import { useTheme } from '../App';
import { AccountBar, Avatar, CreatorBadge, TitleTag, tint } from './Account';
import { FriendButton, FriendsTab, InviteBanner } from './Friends';
import { Marks } from './Daily';
import { Icon } from './Icon';

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
  const [p, setP] = useState<ProfileView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleted, setDeleted] = useState(false);
  /** The color and frame being tried out in the Edit form. */
  const [preview, setPreview] = useState<Look | null>(null);

  useEffect(() => {
    setP(null); setErr(null); setDeleted(false);
    fetchProfile(username).then(setP, (e) => setErr(e.message));
  }, [username]);

  useEffect(() => { document.title = p ? `${p.displayName} (@${p.username}) · Trivio` : 'Trivio'; }, [p]);

  const mine = !!me && !!p && me.username.toLowerCase() === p.username.toLowerCase();
  const look = (editing && preview) || p;
  const headTint = tint(look?.color);

  return (
    <div className="profile-page">
      <header className="profile-top">
        <a className="brand small" href="/"><Logo /> Trivio</a>
        <AccountBar />
      </header>
      <main className="profile">
        {err && <div className="card"><h2>Player not found</h2><p className="muted">{err}</p><a className="btn" href="/">Back to Trivio</a></div>}
        {!p && !err && <p className="muted">Loading profile…</p>}
        {deleted && <div className="card"><h2>Account deleted</h2><p className="muted">@{username} and its saved games are gone.</p><a className="btn" href="/">Back to Trivio</a></div>}
        {p && !deleted && (
          <>
            <section className={`card profile-head ${headTint.className ?? ''}`} style={headTint.style}>
              <Avatar name={p.displayName} color={look!.color} frame={look!.frame} size="big" />
              <div className="grow">
                <h1>{p.displayName} <span className="verified" title="Verified Trivio account"><Check /></span>{p.admin && <CreatorBadge />}</h1>
                {p.title && <div className="profile-title"><TitleTag title={p.title} /></div>}
                <div className="muted small">@{p.username} · joined {new Date(p.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
                {!isLocked(p) && p.visibility && p.visibility !== 'public' && !editing && (
                  <div className="visibility-note small"><Icon name="lock" /> {p.visibility === 'private' ? (mine ? 'Private: only you can see your stats' : 'Private profile · you can see it as an admin') : (mine ? 'Friends only: only your friends can see your stats' : 'Friends-only profile · you can see it as an admin')}</div>
                )}
                {!isLocked(p) && (editing ? <EditProfile p={p} onPreview={setPreview} onDone={(np) => { if (np) setP(np); setEditing(false); setPreview(null); }} /> : p.bio && <p className="bio">{p.bio}</p>)}
              </div>
              <div className="row gap">
                {mine && !editing && <button className="btn small" onClick={() => setEditing(true)}>Edit profile</button>}
                {!mine && <FriendButton username={p.username} />}
                <CopyLink />
              </div>
            </section>

            {isLocked(p) ? (
              <section className="card locked-card">
                <h2><Icon name="lock" /> {p.locked === 'private' ? 'This profile is private' : 'Friends only'}</h2>
                <p className="muted">{p.locked === 'private' ? `${p.displayName} keeps their stats, badges and games to themselves.` : `Only ${p.displayName}’s friends can see their stats, badges and games. ${me ? 'Add them as a friend to see more.' : 'Log in and add them as a friend to see more.'}`}</p>
              </section>
            ) : (
            <>
            <Pinned p={p} color={look!.color} mine={mine} onEdit={() => setEditing(true)} />
            <Badges p={p} mine={mine} />
            {p.totals.games === 0 ? (
              <section className="card">
                <h2>No games yet</h2>
                <p className="muted">{mine ? 'Play a game while logged in and your stats will show up here once the game ends.' : `${p.displayName} hasn’t finished a game yet.`}</p>
                {mine && <a className="btn primary" href="/">Play now</a>}
              </section>
            ) : null}
            {p.totals.games === 0 && p.daily && <DailySection d={p.daily} />}
            {p.totals.games === 0 && p.survival && <SurvivalSection sv={p.survival} />}
            {p.totals.games === 0 ? null : (
              <>
                <Tiles p={p} />
                {p.daily && <DailySection d={p.daily} />}
                {p.survival && <SurvivalSection sv={p.survival} />}
                <Subjects p={p} />
                <Recent games={p.recent} />
              </>
            )}
            {me?.admin && !mine && !p.admin && <AdminCard p={p} onChange={setP} onDeleted={() => setDeleted(true)} />}
            {me?.admin && <AdminTitles p={p} onChange={setP} />}
            </>
            )}
          </>
        )}
      </main>
      <FriendsTab />
      <InviteBanner />
      <Announcement />
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

function LockIcon() {
  return <svg className="lock" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.6 0h3.8V5a1.9 1.9 0 0 0-3.8 0z" /></svg>;
}

/** Which badge unlocks a reward, for locked options. */
function unlockText(r: Reward) {
  const b = BADGE_BY_ID.get(r.badge ?? '');
  return b ? `${r.name} unlocks with the ${b.icon} ${b.name} badge (${b.desc.charAt(0).toLowerCase()}${b.desc.slice(1)}).` : r.name;
}

function EditProfile({ p, onDone, onPreview }: { p: PublicProfile; onDone: (p: PublicProfile | null) => void; onPreview: (look: Look) => void }) {
  const [account, setAccount] = useState(false);
  const [displayName, setDisplayName] = useState(p.displayName);
  const [color, setColor] = useState(p.color);
  const [frame, setFrame] = useState(p.frame);
  /** What a tapped locked option needs, shown under its picker. */
  const [hint, setHint] = useState<{ kind: 'color' | 'frame'; text: string } | null>(null);
  const earned = earnedIds(p.badges);
  useEffect(() => onPreview({ color, frame }), [color, frame]);
  const [bio, setBio] = useState(p.bio);
  const { me } = useAccount();
  const [titles, setTitles] = useState<TitleOption[] | null>(null);
  const [title, setTitle] = useState<string | null>(me?.title ?? null);
  useEffect(() => { fetchTitles().then((r) => { setTitles(r.options); setTitle(r.equipped); }, () => setTitles([])); }, []);
  const [visibility, setVisibility] = useState<Visibility>(p.visibility ?? 'public');
  const [pinned, setPinned] = useState<string[]>(p.pinned);
  const [busy, setBusy] = useState(false);
  const togglePin = (id: string) => setPinned((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length < PIN_MAX ? [...x, id] : x));
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const u = await updateMe({ displayName, bio, visibility, pinned, color, frame, ...(titles ? { title } : {}) });
      onDone({ ...p, displayName: u.displayName, bio: u.bio, visibility: u.visibility, pinned: u.pinned, color: u.color, frame: u.frame, title: titles?.find((o) => o.key === u.title)?.name ?? null });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <form className="edit-profile" onSubmit={save}>
      <label className="field"><span>Display name</span><input value={displayName} maxLength={24} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="field"><span>Bio <span className="muted">({bio.length}/{BIO_MAX})</span></span>
        <textarea value={bio} maxLength={BIO_MAX} rows={2} placeholder="Favorite categories, team, school…" onChange={(e) => setBio(e.target.value)} />
      </label>
      <div className="field">
        <span>Who can see your stats, badges and games</span>
        <div className="seg" role="radiogroup" aria-label="Profile visibility">
          {VISIBILITIES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={visibility === v} className={visibility === v ? 'on' : ''} onClick={() => setVisibility(v)}>{VISIBILITY_LABEL[v]}</button>
          ))}
        </div>
        <span className="muted small">Your name and username always show, so friends can find you.</span>
      </div>
      <div className="field">
        <span>Pinned stats <span className="muted">({pinned.length}/{PIN_MAX}, shown at the top in this order)</span></span>
        <div className="pin-picker">
          {PIN_STATS.map((s) => {
            const i = pinned.indexOf(s.id);
            return (
              <button key={s.id} type="button" className={`pin-chip ${i >= 0 ? 'on' : ''}`} aria-pressed={i >= 0} disabled={i < 0 && pinned.length >= PIN_MAX} onClick={() => togglePin(s.id)}>
                {i >= 0 && <span className="pin-num">{i + 1}</span>}{s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="field">
        <span>Profile color <span className="muted">· {colorById(color).name}</span></span>
        <div className="reward-picker" role="radiogroup" aria-label="Profile color">
          {PROFILE_COLORS.map((c) => {
            const open = isUnlocked(c, earned);
            const t = tint(c.id, true);
            return (
              <button key={c.id} type="button" role="radio" aria-checked={color === c.id} aria-disabled={!open}
                className={`swatch ${t.className} ${color === c.id ? 'on' : ''} ${open ? '' : 'locked'}`} style={t.style}
                title={open ? c.name : unlockText(c)} aria-label={open ? c.name : `${c.name}, locked. ${unlockText(c)}`}
                onClick={() => { if (open) { setColor(c.id); setHint(null); } else setHint({ kind: 'color', text: unlockText(c) }); }}>
                {!open && <LockIcon />}
              </button>
            );
          })}
        </div>
        {hint?.kind === 'color' && <span className="reward-hint small"><Icon name="lock" /> {hint.text}</span>}
      </div>
      <div className="field">
        <span>Avatar frame <span className="muted">· {frameById(frame).name}</span></span>
        <div className="reward-picker" role="radiogroup" aria-label="Avatar frame">
          {AVATAR_FRAMES.map((f) => {
            const open = isUnlocked(f, earned);
            return (
              <button key={f.id} type="button" role="radio" aria-checked={frame === f.id} aria-disabled={!open}
                className={`frame-opt ${frame === f.id ? 'on' : ''} ${open ? '' : 'locked'}`}
                title={open ? f.name : unlockText(f)} aria-label={open ? f.name : `${f.name}, locked. ${unlockText(f)}`}
                onClick={() => { if (open) { setFrame(f.id); setHint(null); } else setHint({ kind: 'frame', text: unlockText(f) }); }}>
                <Avatar name={displayName || p.displayName} color={color} frame={f.id} force />
                {!open && <LockIcon />}
              </button>
            );
          })}
        </div>
        {hint?.kind === 'frame' ? <span className="reward-hint small"><Icon name="lock" /> {hint.text}</span> : <span className="muted small">Earn badges to unlock more colors and frames.</span>}
      </div>
      <div className="field">
        <span>Title <span className="muted">· shown with your name on your profile and in games</span></span>
        {titles === null ? <span className="muted small">Loading…</span> : (
          <div className="chips title-picker" role="radiogroup" aria-label="Title">
            <button type="button" role="radio" aria-checked={!title} className={`chip ${!title ? 'on' : ''}`} onClick={() => setTitle(null)}>None</button>
            {titles.map((o) => (
              <button key={o.key} type="button" role="radio" aria-checked={title === o.key} className={`chip ${title === o.key ? 'on' : ''} ${o.from !== 'badge' ? 'special' : ''}`}
                title={o.from === 'badge' ? 'Earned with a badge' : 'Given by Trivio'} onClick={() => setTitle(o.key)}>{o.name}</button>
            ))}
          </div>
        )}
        {titles && !titles.length && <span className="muted small">Earn badges to unlock titles.</span>}
      </div>
      <p className="muted small">Username, email and password are in <button type="button" className="link" onClick={() => setAccount(true)}>Account settings</button>.</p>
      {account && <SettingsMenu start="account" onClose={() => setAccount(false)} />}
      {err && <p className="error">{err}</p>}
      <div className="row gap"><button className="btn primary small" disabled={busy || !displayName.trim()}>Save</button><button type="button" className="btn ghost small" onClick={() => onDone(null)}>Cancel</button></div>
    </form>
  );
}

/** Admin-only moderation tools for someone else's profile. */
/** Site admins: give titles (special or custom) and individual badges. Works on any profile, yours and other admins' too. */
function AdminTitles({ p, onChange }: { p: ProfileView; onChange: (p: ProfileView) => void }) {
  const [titles, setTitles] = useState<string[]>(p.grantedTitles ?? []);
  const [badges, setBadges] = useState<string[]>(isLocked(p) ? [] : p.grantedBadges ?? []);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saveTitles = async (next: string[]) => {
    setBusy(true); setErr(null);
    try { const r = await adminSetTitles(p.username, next); setTitles(r.titles); onChange({ ...(await fetchProfile(p.username)) } as ProfileView); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveBadges = async (next: string[]) => {
    setBusy(true); setErr(null);
    try { const r = await adminSetBadges(p.username, next); setBadges(r.grantedBadges); onChange({ ...(await fetchProfile(p.username)) } as ProfileView); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const customs = titles.filter((t) => t.startsWith('custom:'));
  return (
    <section className="card admin-card admin-titles">
      <h2><Icon name="crown" /> Titles and badges</h2>
      <p className="muted small">Only admins see this. Titles you give show up in their title list; they pick one to wear.</p>
      <h4>Titles</h4>
      <div className="chips">
        {SPECIAL_TITLES.map((t) => {
          const key = `special:${t.id}`;
          const on = titles.includes(key);
          return <button key={key} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy} onClick={() => saveTitles(toggle(titles, key))}>{on ? '✓ ' : ''}{t.name}</button>;
        })}
        {customs.map((k) => (
          <button key={k} type="button" className="chip on" disabled={busy} title="Remove this title" onClick={() => saveTitles(titles.filter((x) => x !== k))}>✓ {k.slice(7)} ✕</button>
        ))}
      </div>
      <form className="row gap admin-custom-title" onSubmit={(e) => { e.preventDefault(); const t = custom.trim(); if (t) { void saveTitles([...titles, `custom:${t}`]); setCustom(''); } }}>
        <input className="grow" value={custom} maxLength={TITLE_MAX} placeholder="Custom title, e.g. Quiz Bowl Legend" aria-label="Custom title" onChange={(e) => setCustom(e.target.value)} />
        <button className="btn small" disabled={busy || !custom.trim()}>Give title</button>
      </form>
      {!isLocked(p) && (
        <>
          <h4>Badges <small className="muted">(given on top of what they earn)</small></h4>
          <div className="chips">
            {BADGES.map((b) => {
              const on = badges.includes(b.id);
              const earnedForReal = p.badges.find((x) => x.id === b.id)?.earned && !on;
              return (
                <button key={b.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy || earnedForReal}
                  title={earnedForReal ? 'They earned this one' : b.desc} onClick={() => saveBadges(toggle(badges, b.id))}>
                  {b.icon} {b.name}{earnedForReal ? ' · earned' : ''}
                </button>
              );
            })}
          </div>
        </>
      )}
      {err && <p className="error small">{err}</p>}
    </section>
  );
}

function AdminCard({ p, onChange, onDeleted }: { p: PublicProfile; onChange: (p: PublicProfile) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null); setNote(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const reset = (name: boolean, bio: boolean) => run(async () => {
    const r = await adminResetProfile(p.username, { name, bio });
    onChange({ ...p, displayName: r.displayName ?? p.displayName, bio: r.bio ?? p.bio });
    setNote(name ? 'Display name reset to the username.' : 'Bio cleared.');
  });
  return (
    <section className="card admin-card">
      <h2><Icon name="crown" /> Admin</h2>
      <p className="muted small">Only you can see this. Use it for offensive names or bios, or accounts that shouldn’t exist.</p>
      <div className="row gap">
        <button className="btn small" disabled={busy || p.displayName === p.username} onClick={() => reset(true, false)}>Reset display name</button>
        <button className="btn small" disabled={busy || !p.bio} onClick={() => reset(false, true)}>Clear bio</button>
        <button className="btn small" disabled={busy} onClick={() => run(async () => {
          const unlock = !p.badgesUnlocked;
          await adminUnlockBadges(p.username, unlock);
          onChange({ ...(await fetchProfile(p.username)) as PublicProfile });
          setNote(unlock ? 'Every badge is unlocked on this profile.' : 'Badges are back to the ones they earned.');
        })}>{p.badgesUnlocked ? 'Re-lock badges' : 'Unlock all badges'}</button>
        {confirming ? (
          <span className="confirm">
            <span className="small">Really delete @{p.username}? This can’t be undone.</span>
            <button className="btn small danger" disabled={busy} onClick={() => run(async () => { await adminDeleteAccount(p.username); onDeleted(); })}>Yes, delete</button>
            <button className="btn small ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn small bad" disabled={busy} onClick={() => setConfirming(true)}>Delete account</button>
        )}
      </div>
      {note && <p className="small muted">{note}</p>}
      {err && <p className="error small">{err}</p>}
    </section>
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
              <div className="subject-name"><CategoryDot category={s.category} />{s.category}{s.category === p.bestSubject && <span className="badge best-badge">best</span>}</div>
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

/** Today's date in US Eastern, when the daily challenge rolls over. */
const easternToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function DailySection({ d }: { d: DailyProfile }) {
  const today = easternToday();
  const tiles: { label: string; value: string; sub: string; tone?: string }[] = [
    { label: '1st place', value: String(d.wins), sub: d.leadingToday ? 'and leading today' : plural(d.wins, 'daily win'), tone: 'accent' },
    { label: 'Days played', value: String(d.played), sub: `${plural(d.podiums, 'top-3 finish').replace('finishs', 'finishes')}` },
    { label: 'Best finish', value: `#${d.bestRank}`, sub: `best score ${d.bestScore}` },
    { label: 'Avg score', value: fixed(d.avgPoints), sub: 'points per daily' },
    { label: 'Streak', value: String(d.streak), sub: `${d.streak === 1 ? 'day' : 'days'} in a row · best ${d.longestStreak}` },
  ];
  return (
    <section className="card">
      <h2>Daily challenge</h2>
      <div className="tiles">
        {tiles.map((x) => (
          <div key={x.label} className={`tile ${x.tone ?? ''}`}>
            <div className="tile-label">{x.label}</div>
            <div className="tile-value">{x.value}</div>
            <div className="tile-sub">{x.sub}</div>
          </div>
        ))}
      </div>
      <ul className="recent daily-recent">
        {d.recent.map((x) => {
          const solo = x.players < 2;
          return (
            <li key={x.day}>
              <span className={`result ${!solo && x.rank === 1 ? 'win' : solo ? '' : 'loss'}`}>{solo ? 'Solo' : `${ordinal(x.rank)} of ${x.players}`}</span>
              <div className="grow">
                <div><b>Daily #{x.number}</b> <span className="muted small">· {x.points} pts{x.day === today ? ' · so far today' : ''}</span></div>
                <Marks marks={x.marks} size="sm" />
              </div>
              <span className="muted small when">{x.day === today ? 'Today' : new Date(`${x.day}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </li>
          );
        })}
      </ul>
      <p className="muted small">A 1st place counts once the day ends (midnight Eastern) and at least two people played. Ties go to whoever buzzed earlier on average.</p>
    </section>
  );
}

function SurvivalSection({ sv }: { sv: SurvivalProfile }) {
  const tiles = [
    { label: 'Best run', value: String(sv.best.correct), sub: `right · ${plural(sv.best.tossups, 'tossup')} · ${sv.best.points} pts`, tone: 'accent' },
    { label: 'All-time rank', value: `#${sv.rank}`, sub: `of ${plural(sv.players, 'player')}` },
    { label: 'Runs', value: String(sv.runs), sub: `best on ${new Date(sv.best.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` },
  ];
  return (
    <section className="card">
      <h2>Survival</h2>
      <div className="tiles">
        {tiles.map((x) => (
          <div key={x.label} className={`tile ${x.tone ?? ''}`}>
            <div className="tile-label">{x.label}</div>
            <div className="tile-value">{x.value}</div>
            <div className="tile-sub">{x.sub}</div>
          </div>
        ))}
      </div>
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
          const result = g.daily ? 'Daily' : g.survival ? 'Survival' : solo ? 'Solo' : g.rank === 1 ? 'Won' : `${ordinal(g.rank)} of ${g.sides}`;
          const kind = g.daily ? `Daily Challenge #${g.daily}` : g.survival ? 'survival run' : g.mode === 'teams' ? 'teams' : 'free-for-all';
          return (
            <li key={`${g.at}-${i}`}>
              <span className={`result ${g.daily || g.survival ? 'daily' : solo ? '' : g.rank === 1 ? 'win' : 'loss'}`}>{result}</span>
              <div className="grow">
                <div><b>{g.points} pts</b> <span className="muted small">· {g.daily && <>{kind} · </>}{g.powers}/{g.tens}/{g.negs} · {plural(g.tossups, 'tossup')}{g.daily ? '' : ` · ${kind}`}{g.abandoned ? ' · unfinished' : ''}</span></div>
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

/** Up to three stats the player chose to show off, above everything else. */
function Pinned({ p, color, mine, onEdit }: { p: PublicProfile; color: string; mine: boolean; onEdit: () => void }) {
  const t = tint(color);
  const stats = p.pinned.map((id) => PIN_STATS.find((s) => s.id === id)).filter((s) => !!s);
  if (!stats.length) {
    return mine ? (
      <button className="pin-empty" onClick={onEdit}><Icon name="pin" /> Pin up to {PIN_MAX} stats to the top of your profile</button>
    ) : null;
  }
  return (
    <section className={`pinned-row n${stats.length} ${t.className ?? ''}`} style={t.style} aria-label="Pinned stats">
      {stats.map((s) => {
        const v = s.get(p);
        return (
          <div key={s.id} className="tile pinned">
            <div className="tile-label">{s.label}</div>
            <div className="tile-value">{v?.value ?? '–'}</div>
            {v?.sub && <div className="tile-sub">{v.sub}</div>}
          </div>
        );
      })}
    </section>
  );
}

/** Earned badges. On your own profile, the ones still to get show with progress. */
function Badges({ p, mine }: { p: PublicProfile; mine: boolean }) {
  const [all, setAll] = useState(false);
  const earned = p.badges.filter((b) => b.earned);
  const locked = p.badges.filter((b) => !b.earned).sort((a, b) => (b.have ?? 0) / (b.need ?? 1) - (a.have ?? 0) / (a.need ?? 1));
  if (!earned.length && !mine) return null;
  const shown = mine && all ? [...earned, ...locked] : earned;
  return (
    <section className="card">
      <div className="row between badges-head">
        <h2>Badges <span className="muted small">{earned.length} of {p.badges.length}</span></h2>
        {mine && locked.length > 0 && <button className="btn ghost small" onClick={() => setAll(!all)}>{all ? 'Earned only' : 'Show all'}</button>}
      </div>
      {!shown.length && <p className="muted small">No badges yet. Finish a game to earn your first.{mine && ' Tap “Show all” to see what’s out there.'}</p>}
      <ul className="badges">
        {shown.map((b) => {
          const d = BADGE_BY_ID.get(b.id);
          if (!d) return null;
          return (
            <li key={b.id} className={`badge-item ${b.earned ? 'earned' : 'locked'}`} title={d.desc}>
              <span className="badge-icon" aria-hidden="true">{d.icon}</span>
              <div className="badge-text">
                <div className="badge-name">{d.name}</div>
                <div className="muted small">{d.desc}</div>
                {!b.earned && b.need && b.need > 1 && (
                  <div className="badge-progress" aria-label={`${b.have} of ${b.need}`}>
                    <div className="track"><div className="fill" style={{ width: `${((b.have ?? 0) / b.need) * 100}%` }} /></div>
                    <span className="small muted">{b.have}/{b.need}</span>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
