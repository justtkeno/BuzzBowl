import { useEffect, useState } from 'react';
import type { PublicState, SurvivalBoard as Board, SurvivalStatus } from '../../shared/types';
import { useSurvivalStatus } from '../survival';
import { Marks } from './Daily';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lives left as a few small dots. */
export function Lives({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="lives" role="img" aria-label={`${lives} of ${max} lives left`} title={`${lives} ${lives === 1 ? 'life' : 'lives'} left`}>
      {Array.from({ length: max }, (_, i) => <span key={i} className={`life ${i < lives ? 'on' : ''}`} />)}
    </span>
  );
}

/** Room top bar: tossups right so far and lives left. */
export function SurvivalChip({ s }: { s: PublicState }) {
  const sv = s.survival!;
  return (
    <span className="chip daily-chip survival-chip" title={`${plural(sv.correct, 'tossup')} right`}>
      Survival <b>{sv.correct}</b> <Lives lives={sv.lives} max={sv.maxLives} />
    </span>
  );
}

type Tab = 'allTime' | 'week';

/** All-time and this-week boards: each player's best run. */
export function SurvivalBoard({ status, initial = 'allTime' }: { status: SurvivalStatus; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  const b: Board = status[tab];
  const me = b.me;
  return (
    <div className="daily-board">
      <div className="row between daily-head">
        <div className="chips" role="tablist" aria-label="Leaderboard">
          <button role="tab" aria-selected={tab === 'allTime'} className={`chip ${tab === 'allTime' ? 'on' : ''}`} onClick={() => setTab('allTime')}>All time</button>
          <button role="tab" aria-selected={tab === 'week'} className={`chip ${tab === 'week' ? 'on' : ''}`} onClick={() => setTab('week')}>This week</button>
        </div>
        <span className="muted small">{plural(b.players, 'player')}</span>
      </div>
      {me && <div className="muted small">Your best{tab === 'week' ? ' this week' : ''}: <b>{me.correct}</b> right · #{me.rank} of {b.players}</div>}
      {b.entries.length > 0 ? (
        <table className="daily-table">
          <thead><tr><th>#</th><th>Player</th><th className="num hide-sm" title="Tossups played, misses included">Played</th><th className="num">Pts</th><th className="num" title="Tossups answered correctly">Right</th></tr></thead>
          <tbody>
            {b.entries.map((e) => (
              <tr key={`${e.rank}-${e.name}`} className={me && e.rank === me.rank && e.name === me.name ? 'me' : ''}>
                <td className="num">{e.rank}</td>
                <td>{e.username ? <a href={`/u/${e.username}`}>{e.name}</a> : e.name}</td>
                <td className="num muted hide-sm">{e.tossups}</td>
                <td className="num muted">{e.points}</td>
                <td className="num"><b>{e.correct}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">{tab === 'week' ? 'No runs yet this week. Be the first!' : 'Nobody has finished a run yet. Be the first!'}</p>}
      <p className="muted small daily-note">Ranked by tossups answered correctly, then points, then whoever got there first. {tab === 'week' ? 'The week starts Monday, Eastern time.' : ''}</p>
    </div>
  );
}

/** Home page card, under the daily: play (or carry on), your best, and the boards. */
export function SurvivalCard({ busy, connected, onPlay, openOnLoad }: { busy: boolean; connected: boolean; onPlay: () => void; openOnLoad: boolean }) {
  const { status, error, refresh } = useSurvivalStatus(connected);
  const [open, setOpen] = useState(openOnLoad);
  useEffect(() => { if (openOnLoad) setOpen(true); }, [openOnLoad]);
  const best = status?.allTime.me;
  return (
    <section className="daily-card" aria-label="Survival">
      <div className="row between">
        <div>
          <div className="daily-title">Survival</div>
          <div className="muted small">
            {error && !status ? error
              : !status ? 'Loading…'
              : status.running ? 'You have a run going'
              : best ? <>Your best: <b>{best.correct}</b> right · #{best.rank} of {status.allTime.players}</>
              : 'Tossups until you miss 3'}
          </div>
        </div>
        <div className="row gap survival-actions">
          {error && !status
            ? <button className="btn" disabled={!connected} onClick={refresh}>Try again</button>
            : <button className="btn" disabled={!status} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Board'}</button>}
          <button className="btn primary" disabled={busy || !connected} onClick={onPlay}>{status?.running ? 'Continue' : 'Play'}</button>
        </div>
      </div>
      {status && open && <SurvivalBoard status={status} />}
    </section>
  );
}

/** End of a run: how it went, your best, and Play again. */
export function SurvivalResults({ s, onPlayAgain }: { s: PublicState; onPlayAgain?: () => Promise<void> }) {
  const sv = s.survival!;
  const { status, error, refresh } = useSurvivalStatus(true);
  const [board, setBoard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The run is saved a moment after it ends; ask again shortly in case we were early.
  useEffect(() => { const t = setTimeout(refresh, 1500); return () => clearTimeout(t); }, [refresh]);
  const me = s.players.find((p) => p.id === s.you);
  const points = me?.stats.points ?? 0;
  const powers = [...sv.marks].filter((m) => m === 'P').length;
  const best = status?.allTime.me;
  const isBest = !!best && sv.correct > 0 && best.correct === sv.correct && best.points === points;
  const again = async () => {
    if (!onPlayAgain) return;
    setBusy(true);
    setErr(null);
    try { await onPlayAgain(); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="card survival-results">
      <div className="row between daily-head">
        <h3>Run over</h3>
        {isBest && <span className="chip on daily-chip">Your best run</span>}
      </div>
      <div className="daily-me">
        <div className="daily-score"><b>{sv.correct}</b> {sv.correct === 1 ? 'tossup' : 'tossups'} right</div>
        <span className="marks-wrap"><Marks marks={sv.marks} size="sm" /></span>
        <div className="muted small">{plural(sv.tossups, 'tossup')} survived · {plural(powers, 'power')} · {points} pts</div>
        <div className="small">
          {best ? <>Best ever: <b>{best.correct}</b> right · #{best.rank} of {status!.allTime.players} all time</>
            : error ? <span className="muted">{error}</span>
            : <span className="muted">{status ? 'Not on the board: no tossups played.' : 'Saving your run…'}</span>}
        </div>
        <div className="row gap">
          {onPlayAgain && <button className="btn primary" disabled={busy} onClick={again}>Play again</button>}
          <button className="btn" disabled={!status} onClick={() => setBoard(!board)} aria-expanded={board}>{board ? 'Hide board' : 'Leaderboard'}</button>
        </div>
        {err && <p className="error">{err}</p>}
      </div>
      {status && board && <SurvivalBoard status={status} />}
    </div>
  );
}
