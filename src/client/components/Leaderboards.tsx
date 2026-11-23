import { useEffect, useState } from 'react';
import { useTheme } from '../App';
import { useAccount } from '../account';
import { BOARDS, PERIODS, isBoard, isPeriod, type BoardEntry, type BoardKind, type BoardPeriod, type BoardView } from '../../shared/leaderboards';
import { AccountBar, AccountDialog, Avatar, TitleTag } from './Account';
import { Logo } from './Logo';
import { PhoneTabs } from './PhoneTabs';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** The board and period this page opens on: the link's, else the last one looked at. */
function initial(): { board: BoardKind; period: BoardPeriod } {
  const q = new URLSearchParams(location.search);
  let saved: { board?: unknown; period?: unknown } = {};
  try { saved = JSON.parse(localStorage.getItem('qb:board') ?? '{}'); } catch { /* none */ }
  const b = q.get('board') ?? saved.board;
  const p = q.get('period') ?? saved.period;
  return { board: isBoard(b) ? b : 'wins', period: isPeriod(p) ? p : 'week' };
}

/** What a row's number means, and the small line under it. */
function figures(board: BoardKind, e: BoardEntry): { value: string; unit: string; extra: string } {
  if (board === 'wins') return { value: e.value.toLocaleString(), unit: e.value === 1 ? 'win' : 'wins', extra: `of ${plural(e.extra, 'game')}` };
  if (board === 'correct') return { value: e.value.toLocaleString(), unit: 'right', extra: plural(e.extra, 'power') };
  return { value: e.value.toLocaleString(), unit: 'pts', extra: plural(e.extra, 'day') };
}

const EMPTY: Record<BoardKind, string> = {
  wins: 'No wins yet. Beat another person in a room to be first.',
  correct: 'No correct answers yet. Any game counts, solo practice too.',
  daily: 'Nobody signed in has played the daily challenge yet.',
};

const NONE: Record<BoardKind, string> = {
  wins: 'Win a game against another person (not just bots) to get on this board.',
  correct: 'Answer a tossup right in any game to get on this board.',
  daily: 'Play Today’s challenge to get on this board.',
};

/** /leaderboards: most wins, most correct answers and the daily challenge, for today, this week, this month or all time. */
export function Leaderboards() {
  useTheme();
  const { me } = useAccount();
  const [{ board, period }, setPick] = useState(initial);
  const [view, setView] = useState<BoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState(false);
  useEffect(() => { document.title = 'Leaderboards · Trivio'; }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    history.replaceState(null, '', `/leaderboards?board=${board}&period=${period}`);
    try { localStorage.setItem('qb:board', JSON.stringify({ board, period })); } catch { /* private mode */ }
    fetch(`/api/leaderboards?board=${board}&period=${period}`, { credentials: 'same-origin' })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'The leaderboards are unavailable right now.'); return j as BoardView; })
      .then((v) => { if (live) setView(v); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [board, period, me?.id]);

  const info = BOARDS.find((b) => b.id === board)!;
  const shown = view && view.board === board && view.period === period ? view : null;
  const mine = shown?.me;
  const meInTop = !!mine && shown!.entries.some((e) => e.username === mine.username);

  return (
    <div className="profile-page with-tabbar">
      <header className="profile-top">
        <a className="brand small" href="/"><Logo /> Trivio</a>
        <AccountBar />
      </header>
      <main className="profile boards">
        <section className="card">
          <h1>Leaderboards</h1>
          <div className="seg boards-kind" role="tablist" aria-label="Leaderboard">
            {BOARDS.map((b) => (
              <button key={b.id} role="tab" aria-selected={board === b.id} className={board === b.id ? 'on' : ''} onClick={() => setPick({ board: b.id, period })}>{b.label}</button>
            ))}
          </div>
          <div className="chips boards-period" role="radiogroup" aria-label="Time period">
            {PERIODS.map((p) => (
              <button key={p.id} role="radio" aria-checked={period === p.id} className={`chip ${period === p.id ? 'on' : ''}`} onClick={() => setPick({ board, period: p.id })}>{p.label}</button>
            ))}
          </div>
          <p className="muted small boards-about"><b>{info.title}.</b> {info.about}</p>

          {error && <p className="error">{error}</p>}
          {!shown && !error && <ol className="board-list loading" aria-busy="true">{Array.from({ length: 5 }, (_, i) => <li key={i} className="board-row skeleton-row" />)}</ol>}

          {shown && (
            <>
              {shown.entries.length > 0
                ? (
                  <ol className="board-list">
                    {shown.entries.map((e) => <Row key={e.username} board={board} e={e} me={e.username === me?.username} />)}
                  </ol>
                )
                : <p className="muted board-empty">{EMPTY[board]}</p>}
              {mine && !meInTop && (
                <ol className="board-list board-mine" aria-label="Your place">
                  <Row board={board} e={mine} me />
                </ol>
              )}
              <p className="muted small board-foot">
                {shown.players > 0 && <>{plural(shown.players, 'player')} ranked. </>}
                {shown.meNote === 'none' && NONE[board]}
                {shown.meNote === 'private' && <>Your profile isn’t public, so you’re not listed. You can change that in <b>Edit profile</b>.</>}
                {shown.meNote === 'guest' && <>Only signed-in players are ranked. <button className="link" onClick={() => setLogin(true)}>Sign in or make an account</button>.</>}
              </p>
            </>
          )}
        </section>

        <section className="card board-rules">
          <h2>How it counts</h2>
          <ul className="muted small">
            <li>Days, weeks (from Monday) and months follow US Eastern time, like the daily challenge.</li>
            <li>Only signed-in players with a public profile are listed. Ties share a place.</li>
            <li>Games where a score was changed by hand, a ruling was reversed or a reader accepted an answer the checker didn’t, and games with an uploaded packet, don’t count. They still show on your profile.</li>
            <li>The daily challenge and survival count only on their own boards. Survival’s are under <b>Play solo</b>.</li>
          </ul>
        </section>
      </main>
      {login && <AccountDialog initial="login" onClose={() => setLogin(false)} />}
      <PhoneTabs active="boards" />
    </div>
  );
}

function Row({ board, e, me }: { board: BoardKind; e: BoardEntry; me: boolean }) {
  const f = figures(board, e);
  return (
    <li className={`board-row ${me ? 'me' : ''} ${e.rank <= 3 ? `top top-${e.rank}` : ''}`}>
      <span className="board-rank" aria-label={`Place ${e.rank}`}>{e.rank}</span>
      <a className="board-who" href={`/u/${e.username}`}>
        <Avatar name={e.displayName} color={e.color} frame={e.frame} />
        <span className="board-name">
          <b>{e.displayName}{me && <span className="muted"> (you)</span>}</b>
          <span className="board-sub"><span className="board-user">@{e.username}</span><TitleTag title={e.title} /></span>
        </span>
      </a>
      <span className="board-value"><span><b>{f.value}</b> <small>{f.unit}</small></span><span className="board-extra">{f.extra}</span></span>
    </li>
  );
}
