import { useEffect, useState } from 'react';
import type { Mode, Phase } from '../../shared/types';
import { adminUnlockBadges, useAccount } from '../account';
import { call } from '../socket';
import { REPORT_REASONS, type ReportGroup } from '../../shared/reports';
import { Icon } from './Icon';

interface RoomRow {
  code: string; phase: Phase; mode: Mode; paused: boolean; lastActive: number;
  daily: { number: number; done: boolean } | null; survival: { lives: number; done: boolean } | null; tossup: number; bots: number; host: string | null;
  players: { name: string; username: string | null; online: boolean }[];
}
interface Overview { connections: number; accounts: number; rooms: RoomRow[] }

const PHASE: Record<Phase, string> = { lobby: 'Lobby', loading: 'Loading', reading: 'Reading', buzz: 'Buzz', tossupEnd: 'Between tossups', bonus: 'Bonus', gameOver: 'Game over' };
const REFRESH_MS = 5000;
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'active now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Site-wide admin tools, from the home page or a profile: announce to everyone, see and close rooms, badges. */
export function SiteAdminPanel({ onClose }: { onClose: () => void }) {
  const { me } = useAccount();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shout, setShout] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<{ total: number; groups: ReportGroup[] } | null>(null);

  const loadReports = () => call<{ total: number; groups: ReportGroup[] }>('site:reports').then(setReports, (e) => setErr(e.message));
  const load = () => Promise.all([call<Overview & { ok: true }>('site:overview').then(setO, (e) => setErr(e.message)), loadReports()]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey); };
  }, []);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setErr(null); setNote(null);
    try { const n = await fn(); if (n) setNote(n); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const announce = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await call<{ sent: number }>('site:announce', shout);
      setShout('');
      return `Sent to ${r.sent} screen${r.sent === 1 ? '' : 's'}.`;
    });
  };
  const close = (code: string) => {
    if (!confirm(`Close room ${code}? Everyone in it goes back to the home screen.`)) return;
    void run(async () => { await call('site:closeRoom', code); await load(); return `Closed ${code}.`; });
  };
  const closeReports = (g: ReportGroup, status: 'resolved' | 'dismissed') => void run(async () => {
    const r = await call<{ closed: number }>('site:resolveReport', { source: g.source, questionId: g.questionId, status });
    await loadReports();
    return `${status === 'resolved' ? 'Resolved' : 'Dismissed'} ${r.closed} report${r.closed === 1 ? '' : 's'}.`;
  });
  const badges = (unlock: boolean) => me && run(async () => {
    await adminUnlockBadges(me.username, unlock);
    return unlock ? 'Every badge is unlocked on your profile.' : 'Your badges are back to the ones you earned.';
  });

  const live = o?.rooms.filter((r) => r.players.some((p) => p.online)) ?? [];
  const idle = o?.rooms.filter((r) => !r.players.some((p) => p.online)) ?? [];

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal admin-panel site-admin" role="dialog" aria-label="Site admin">
        <div className="row between">
          <h2><Icon name="shield" /> Site admin</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <p className="muted small">
          {o ? <>{o.connections} open screen{o.connections === 1 ? '' : 's'} · {o.accounts} signed in · {live.length} active room{live.length === 1 ? '' : 's'}</> : 'Loading…'}
        </p>

        <h3>Announce to everyone on Trivio</h3>
        <form className="row gap" onSubmit={announce}>
          <input className="grow" value={shout} maxLength={140} placeholder="Big message on every screen…" aria-label="Site-wide announcement" onChange={(e) => setShout(e.target.value)} />
          <button className="btn primary" disabled={busy || !shout.trim()}>Send</button>
        </form>
        <p className="muted small">Shows on the home page, profiles, rooms and big screens. Skips anyone in the middle of the daily challenge.</p>

        <h3>Badges</h3>
        <div className="row gap">
          <button className="btn small" disabled={busy} onClick={() => badges(true)}>Unlock all my badges</button>
          <button className="btn small ghost" disabled={busy} onClick={() => badges(false)}>Back to earned only</button>
          {me && <a className="btn small ghost" href={`/u/${me.username}`}>View my profile</a>}
        </div>
        <p className="muted small">To unlock badges for someone else, open their profile.</p>

        <h3>Question reports{reports ? ` (${reports.total})` : ''}</h3>
        {reports && !reports.groups.length && <p className="muted small">No open reports.</p>}
        <ul className="site-reports">
          {reports?.groups.map((g) => (
            <li key={`${g.source}:${g.questionId}`}>
              <div className="muted small">
                {g.reports.length > 1 && <b className="report-count">{g.reports.length}×</b>} {g.category}{g.subcategory !== g.category ? ` · ${g.subcategory}` : ''} · {g.source}{g.setName ? ` · ${g.setName}` : ''}
              </div>
              <p className={`small site-report-q ${shown.has(g.questionId) ? '' : 'clamp'}`} title="Show the whole question"
                onClick={() => setShown((x) => new Set(x).add(g.questionId))}>{g.question}</p>
              <div className="small"><span className="muted">Answer:</span> <span dangerouslySetInnerHTML={{ __html: g.answerHtml }} /></div>
              <ul className="site-report-list small">
                {g.reports.map((r) => (
                  <li key={r.id}>
                    <b>{REPORT_REASONS[r.reason] ?? r.reason}</b>{r.note && <> · “{r.note}”</>}
                    <span className="muted"> · {r.reporterUsername ? <a href={`/u/${r.reporterUsername}`} target="_blank" rel="noreferrer">@{r.reporterUsername}</a> : `${r.reporter} (guest)`} · {r.roomCode} · {ago(r.createdAt).replace('active now', 'just now')}</span>
                  </li>
                ))}
              </ul>
              <div className="row gap">
                <button className="btn small ok" disabled={busy} onClick={() => closeReports(g, 'resolved')}>Resolve</button>
                <button className="btn small ghost" disabled={busy} onClick={() => closeReports(g, 'dismissed')}>Dismiss</button>
              </div>
            </li>
          ))}
        </ul>

        {note && <p className="small">{note}</p>}
        {err && <p className="error small">{err}</p>}

        <div className="row between">
          <h3>Rooms</h3>
          <button className="btn small ghost" onClick={() => void load()}>Refresh</button>
        </div>
        {o && !o.rooms.length && <p className="muted small">No rooms right now.</p>}
        <ul className="site-rooms">
          {[...live, ...idle].map((r) => {
            const on = r.players.filter((p) => p.online);
            return (
              <li key={r.code} className={on.length ? '' : 'idle'}>
                <div className="grow site-room-text">
                  <div>
                    <b className="mono">{r.code}</b>{' '}
                    <span className="muted small">
                      {r.daily ? `Daily #${r.daily.number}${r.daily.done ? ' · done' : ''}` : r.survival ? `Survival${r.survival.done ? ' · done' : ` · ${r.survival.lives} lives`}` : r.mode === 'teams' ? 'Teams' : 'Free-for-all'}
                      {' · '}{r.paused ? 'Paused' : PHASE[r.phase]}{r.tossup ? ` · tossup ${r.tossup}` : ''}
                      {!on.length && ` · empty, ${ago(r.lastActive)}`}
                    </span>
                  </div>
                  <div className="small site-room-people">
                    {r.players.length ? r.players.map((p, i) => (
                      <span key={i} className={p.online ? '' : 'muted'}>
                        {p.username ? <a href={`/u/${p.username}`} target="_blank" rel="noreferrer">{p.name}</a> : p.name}{p.name === r.host ? ' (host)' : ''}
                      </span>
                    )) : <span className="muted">nobody</span>}
                    {r.bots > 0 && <span className="muted">+{r.bots} bot{r.bots === 1 ? '' : 's'}</span>}
                  </div>
                </div>
                <div className="row gap site-room-actions">
                  <a className="btn small ghost" href={`/watch/${r.code}`} target="_blank" rel="noreferrer">Watch</a>
                  {!r.daily && !r.survival && <a className="btn small" href={`/r/${r.code}`}>Join</a>}
                  <button className="btn small bad" disabled={busy} onClick={() => close(r.code)}>Close</button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
