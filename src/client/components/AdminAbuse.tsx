import { useEffect, useState } from 'react';
import { BOOST_MINUTES, BOOST_MULTIPLIERS, fmtMultiplier } from '../../shared/levels';
import { adminUnlockBadges, useAccount } from '../account';
import { call } from '../socket';
import { MyLevel } from './AdminXp';

type Run = (fn: () => Promise<string | void>) => Promise<void>;
interface BoostRow { id: string; multiplier: number; startedAt: number; endsAt: number; username: string | null }

const LENGTH_LABEL = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} day`);
const left = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''} left`;
};

/** Abuse tab: the admin's own perks. XP boosts for everyone, one player or yourself, your level and badges. */
export function AdminAbuse({ run, busy }: { run: Run; busy: boolean }) {
  const { me } = useAccount();
  const [list, setList] = useState<BoostRow[] | null>(null);
  const [mult, setMult] = useState(2);
  const [minutes, setMinutes] = useState(60);
  const [who, setWho] = useState<'everyone' | 'player' | 'me'>('everyone');
  const [name, setName] = useState('');
  const [, tick] = useState(0);

  const load = () => call<{ boosts: BoostRow[] }>('site:boosts').then((r) => setList(r.boosts), () => {});
  useEffect(() => {
    void load();
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  const target = who === 'me' ? me?.username ?? '' : who === 'player' ? name.trim().replace(/^@/, '') : '';
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    if (who === 'player' && !target) return;
    void run(async () => {
      const r = await call<{ boosts: BoostRow[] }>('site:boostStart', { multiplier: mult, minutes, username: target });
      setList(r.boosts);
      return `${fmtMultiplier(mult)} XP for ${who === 'everyone' ? 'everyone' : who === 'me' ? 'you' : `@${target}`} for ${LENGTH_LABEL(minutes)}.`;
    });
  };
  const end = (b: BoostRow) => void run(async () => {
    const r = await call<{ boosts: BoostRow[] }>('site:boostEnd', b.id);
    setList(r.boosts);
    return 'Boost ended.';
  });
  const badges = (unlock: boolean) => me && run(async () => {
    await adminUnlockBadges(me.username, unlock);
    return unlock ? 'Every badge is unlocked on your profile.' : 'Your badges are back to the ones you earned.';
  });

  return (
    <>
      <h3>XP boost</h3>
      <form className="abuse-form" onSubmit={start}>
        <div className="chips" role="radiogroup" aria-label="Multiplier">
          {BOOST_MULTIPLIERS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mult === m} className={`chip ${mult === m ? 'on' : ''}`} onClick={() => setMult(m)}>{fmtMultiplier(m)}</button>
          ))}
        </div>
        <div className="chips" role="radiogroup" aria-label="How long">
          {BOOST_MINUTES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={minutes === m} className={`chip ${minutes === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>{LENGTH_LABEL(m)}</button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Who gets it">
          {([['everyone', 'Everyone'], ['player', 'One player'], ['me', 'Just me']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={who === k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{label}</button>
          ))}
        </div>
        {who === 'player' && (
          <input value={name} maxLength={21} autoCapitalize="off" spellCheck={false} placeholder="Username" aria-label="Username to boost" onChange={(e) => setName(e.target.value)} />
        )}
        <button className="btn primary" disabled={busy || (who === 'player' && !target)}>
          Start {fmtMultiplier(mult)} XP for {LENGTH_LABEL(minutes)}
        </button>
      </form>
      <p className="muted small">Counts on games that end while it runs. Everyone it covers sees a small “{fmtMultiplier(mult)} XP” chip on the home page and in the lobby. When boosts overlap, the biggest one counts.</p>

      <h4>Running now</h4>
      {list && !list.length && <p className="muted small">No boosts running.</p>}
      <ul className="admin-list">
        {list?.map((b) => (
          <li key={b.id}>
            <div className="admin-list-name">
              <b>{fmtMultiplier(b.multiplier)} XP</b> for {b.username ? <a href={`/u/${b.username}`} target="_blank" rel="noreferrer">@{b.username}</a> : 'everyone'}
              <span className="muted small"> · {left(b.endsAt - Date.now())}</span>
            </div>
            <div className="row gap admin-list-actions">
              <button className="btn small bad" disabled={busy} onClick={() => end(b)}>End now</button>
            </div>
          </li>
        ))}
      </ul>

      {me && (
        <>
          <h3>My level{me.level ? <span className="muted small"> · now {me.level}</span> : null}</h3>
          <MyLevel username={me.username} level={me.level} run={run} busy={busy} />
          <p className="muted small">Unlocks every color, frame and title up to that level. “Back to earned XP” puts it back to what your games are worth.</p>

          <h3>My badges</h3>
          <div className="row gap">
            <button className="btn small" disabled={busy} onClick={() => badges(true)}>Unlock all my badges</button>
            <button className="btn small ghost" disabled={busy} onClick={() => badges(false)}>Back to earned only</button>
            <a className="btn small ghost" href={`/u/${me.username}`}>View my profile</a>
          </div>
        </>
      )}
    </>
  );
}
