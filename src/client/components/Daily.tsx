import { useEffect, useState } from 'react';
import type { DailyEntry, DailyStatus } from '../../shared/types';
import { MARK_LABEL, shareText, untilText, useDailyStatus } from '../daily';
import { isTouch, toast } from './util';

const pctIn = (x: number) => `${Math.round(x * 100)}%`;

/** A row of small squares, one per tossup. */
export function Marks({ marks, size = 'md' }: { marks: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`marks marks-${size}`} role="img" aria-label={[...marks].map((m, i) => `${i + 1}: ${MARK_LABEL[m] ?? 'no buzz'}`).join(', ')}>
      {[...marks].map((m, i) => <span key={i} className={`mk mk-${m === '-' ? 'none' : m}`} />)}
    </span>
  );
}

async function share(number: number, me: DailyEntry) {
  const text = shareText(number, me);
  if (isTouch() && navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Result copied — paste it anywhere.'); } catch { toast(text); }
}

/** Your result, a share button and today's leaderboard. */
export function DailyBoard({ status }: { status: DailyStatus }) {
  const me = status.me;
  return (
    <div className="daily-board">
      <div className="row between daily-head">
        <h3>Daily #{status.number}</h3>
        <span className="muted small">{status.players} played · next in {untilText(status.nextIn)}</span>
      </div>
      {me && (
        <div className="daily-me">
          <div className="daily-score"><b>{me.points}</b> pts <span className="muted">· #{me.rank} of {status.players}</span></div>
          <Marks marks={me.marks} />
          <div className="muted small">{me.powers} power{me.powers === 1 ? '' : 's'} · {me.tens} ten{me.tens === 1 ? '' : 's'} · {me.negs} neg{me.negs === 1 ? '' : 's'}{me.depth != null ? ` · average buzz ${pctIn(me.depth)} in` : ''}</div>
          <button className="btn primary" onClick={() => share(status.number, me)}>Share result</button>
        </div>
      )}
      {status.leaderboard.length > 0 ? (
        <table className="daily-table">
          <thead><tr><th>#</th><th>Player</th><th className="hide-sm">Tossups</th><th className="num" title="Average point in the question where they buzzed on correct answers. Earlier is better.">Buzz</th><th className="num">Pts</th></tr></thead>
          <tbody>
            {status.leaderboard.map((e) => (
              <tr key={`${e.rank}-${e.name}`} className={me && e.rank === me.rank && e.name === me.name ? 'me' : ''}>
                <td className="num">{e.rank}</td>
                <td>{e.username ? <a href={`/u/${e.username}`}>{e.name}</a> : e.name}</td>
                <td className="hide-sm"><Marks marks={e.marks} size="sm" /></td>
                <td className="num muted" title={e.depth != null ? `Buzzed ${pctIn(e.depth)} of the way into the question, on average` : 'No correct buzzes'}>{e.depth != null ? pctIn(e.depth) : '–'}</td>
                <td className="num"><b>{e.points}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">Nobody has played today’s challenge yet. Be the first!</p>}
      {status.leaderboard.length > 1 && <p className="muted small daily-note">Ties go to whoever buzzed earlier on average (Buzz: how far into the question, on correct answers), then to whoever finished first.</p>}
    </div>
  );
}

/** Home page card: play today's challenge, or see how you did. */
export function DailyCard({ busy, connected, onPlay, openOnLoad }: { busy: boolean; connected: boolean; onPlay: () => void; openOnLoad: boolean }) {
  const { status, error } = useDailyStatus(connected);
  const [open, setOpen] = useState(openOnLoad);
  useEffect(() => { if (openOnLoad) setOpen(true); }, [openOnLoad]);
  if (error) return null;
  return (
    <section className="daily-card" aria-label="Daily challenge">
      <div className="row between">
        <div>
          <div className="daily-title">Daily challenge{status ? ` #${status.number}` : ''}</div>
          <div className="muted small">
            {status ? (status.me ? <>You scored <b>{status.me.points}</b> · #{status.me.rank} of {status.players}</> : `${status.total} tossups, the same for everyone · ${status.players} played`) : 'Loading…'}
          </div>
        </div>
        {status && (status.me
          ? <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Results'}</button>
          : <button className="btn primary" disabled={busy || !connected} onClick={onPlay}>Play</button>)}
      </div>
      {status?.me && !open && <Marks marks={status.me.marks} size="sm" />}
      {status && open && <DailyBoard status={status} />}
    </section>
  );
}

/** End of a daily game: results and leaderboard above the usual summary. */
export function DailyResults() {
  const { status, error, refresh } = useDailyStatus(true);
  // The result is saved a moment after the game ends; ask again shortly in case we were early.
  useEffect(() => { const t = setTimeout(refresh, 1500); return () => clearTimeout(t); }, [refresh]);
  if (error) return <div className="card muted">{error}</div>;
  if (!status) return <div className="card muted">Saving your result…</div>;
  return <div className="card"><DailyBoard status={status} /></div>;
}
