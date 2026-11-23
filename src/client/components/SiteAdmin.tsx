import { useEffect, useState } from 'react';
import type { Mode, Phase, PublicState } from '../../shared/types';
import { call } from '../socket';
import { REPORT_REASONS, type ReportGroup } from '../../shared/reports';
import { FEEDBACK_KINDS, type FeedbackItem } from '../../shared/feedback';
import { Icon } from './Icon';
import { AdminAbuse } from './AdminAbuse';
import { AdminStats } from './AdminStats';
import { AdminLock, RoomAdmin, RoomTroll } from './AdminPanel';
import { AdminPlayers } from './AdminPlayers';

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

interface ServerInfo {
  uptime: number; node: string; memoryMb: number; commit: string | null; accounts: string; mail: string; publicUrl: string | null; adminLocked: boolean;
  rooms: number; connections: number; users: { total: number; withEmail: number; confirmed: number; newSince: number } | null;
}

export type AdminTab = 'room' | 'stats' | 'rooms' | 'players' | 'troll' | 'abuse' | 'reports' | 'feedback' | 'server';
const MAIL_LABEL: Record<string, string> = { gmail: 'Gmail API', smtp: 'SMTP', console: 'Printed to the server console (local only)', off: 'Off: nothing can be sent', custom: 'Custom' };
const uptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`);

/**
 * The admin panel, from the shield by an admin's name (home, profiles) or a room's Admin button.
 * Tabs: This room (only inside a room), Stats, Rooms, Players, Troll, Abuse (your own perks and XP boosts), Reports, Feedback, Server.
 */
export function SiteAdminPanel({ onClose, room, start }: { onClose: () => void; room?: { s: PublicState; onPlayers?: () => void }; start?: AdminTab }) {
  const [tab, setTab] = useState<AdminTab>(start ?? (room ? 'room' : 'stats'));
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shout, setShout] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<{ total: number; groups: ReportGroup[] } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [server, setServer] = useState<ServerInfo | null>(null);

  const loadReports = () => call<{ total: number; groups: ReportGroup[] }>('site:reports').then(setReports, (e) => setErr(e.message));
  const loadFeedback = () => call<{ items: FeedbackItem[] }>('site:feedback').then((r) => setFeedback(r.items), (e) => setErr(e.message));
  const loadServer = () => call<{ server: ServerInfo }>('site:server').then((r) => setServer(r.server), (e) => setErr(e.message));
  const load = () => Promise.all([call<Overview & { ok: true }>('site:overview').then(setO, (e) => setErr(e.message)), loadReports(), loadFeedback()]);
  useEffect(() => {
    void load();
    void loadServer();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey); };
  }, []);
  useEffect(() => { setNote(null); setErr(null); if (tab === 'server' || tab === 'stats') void loadServer(); }, [tab]);

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
  const shakeAll = () => {
    if (!confirm('Shake every screen on Trivio? (Skips anyone in the middle of a daily challenge or survival run.)')) return;
    void run(async () => { const r = await call<{ sent: number }>('site:shake', null); return `Shook ${r.sent} screen${r.sent === 1 ? '' : 's'}.`; });
  };
  const close = (code: string) => {
    if (!confirm(`Close room ${code}? Everyone in it goes back to the home screen.`)) return;
    void run(async () => { await call('site:closeRoom', code); await load(); return `Closed ${code}.`; });
  };
  const messageRoom = (code: string) => {
    const text = prompt(`Big message on every screen in room ${code}:`);
    if (text?.trim()) void run(async () => { await call('site:roomAnnounce', { code, text }); return `Sent to room ${code}.`; });
  };
  const closeReports = (g: ReportGroup, status: 'resolved' | 'dismissed') => void run(async () => {
    const r = await call<{ closed: number }>('site:resolveReport', { source: g.source, questionId: g.questionId, status });
    await loadReports();
    return `${status === 'resolved' ? 'Resolved' : 'Dismissed'} ${r.closed} report${r.closed === 1 ? '' : 's'}.`;
  });
  const markFeedback = (f: FeedbackItem, done: boolean) => void run(async () => {
    await call('site:feedbackDone', f.id, done);
    await loadFeedback();
  });
  const testEmail = () => void run(async () => { await call('site:testEmail'); return 'Sent. Check the inbox of the email on your account (and spam).'; });

  const live = o?.rooms.filter((r) => r.players.some((p) => p.online)) ?? [];
  const idle = o?.rooms.filter((r) => !r.players.some((p) => p.online)) ?? [];
  const openFeedback = feedback ? feedback.filter((f) => !f.done).length : null;
  const tabs: [AdminTab, string][] = [
    ...(room ? [['room', 'This room'] as [AdminTab, string]] : []),
    ['stats', 'Stats'], ['rooms', `Rooms${o ? ` (${live.length})` : ''}`], ['players', 'Players'], ['troll', 'Troll'], ['abuse', 'Abuse'],
    ['reports', `Reports${reports?.total ? ` (${reports.total})` : ''}`], ['feedback', `Feedback${openFeedback ? ` (${openFeedback})` : ''}`], ['server', 'Server'],
  ];

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal admin-panel site-admin" role="dialog" aria-label="Admin">
        <div className="row between">
          <h2><Icon name="shield" /> Admin</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <p className="muted small">
          {o ? <>{o.connections} open screen{o.connections === 1 ? '' : 's'} · {o.accounts} signed in · {live.length} active room{live.length === 1 ? '' : 's'}</> : 'Loading…'}
          {' · '}Only you see this panel.
        </p>
        <div className="settings-tabs admin-tabs" role="tablist" aria-label="Admin sections">
          {tabs.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
        {(note || err) && <p className={`small admin-flash ${err ? 'error' : ''}`}>{err ?? note}</p>}

        <div className="admin-body" role="tabpanel">
          {tab === 'room' && room && <RoomAdmin s={room.s} onPlayers={room.onPlayers} />}

          {tab === 'stats' && (
            <>
              {server?.users && (
                <div className="admin-facts">
                  <div><b>{server.users.total}</b><span>accounts</span></div>
                  <div><b>{server.users.newSince}</b><span>new this week</span></div>
                  <div><b>{server.users.withEmail}</b><span>with an email</span></div>
                  <div><b>{server.users.confirmed}</b><span>emails confirmed</span></div>
                </div>
              )}
              <AdminStats openReports={reports?.total ?? null} openFeedback={openFeedback} />
            </>
          )}

          {tab === 'troll' && (
            <>
              {room ? <RoomTroll s={room.s} /> : <p className="muted small">Open this panel inside a room for peeking, freezing, slowing, whispering and force-buzzing there.</p>}
              <h3>Everyone on Trivio</h3>
              <form className="row gap" onSubmit={announce}>
                <input className="grow" value={shout} maxLength={140} placeholder="Big message on every screen…" aria-label="Site-wide announcement" onChange={(e) => setShout(e.target.value)} />
                <button className="btn primary" disabled={busy || !shout.trim()}>Send</button>
              </form>
              <div className="row gap">
                <button className="btn small" disabled={busy} onClick={shakeAll}>Shake every screen</button>
              </div>
              <p className="muted small">Shows on the home page, profiles, rooms and big screens. Skips anyone in the middle of a daily challenge or survival run. To whisper to or shake one person anywhere, use the Players tab.</p>
            </>
          )}

          {tab === 'players' && <AdminPlayers run={run} busy={busy} />}

          {tab === 'abuse' && <AdminAbuse run={run} busy={busy} />}

          {tab === 'reports' && (
            <>
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
            </>
          )}

          {tab === 'feedback' && (
            <>
              {!!feedback?.some((f) => f.done) && <div className="row end"><button className="btn small ghost" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide done' : 'Show done'}</button></div>}
              {feedback && !feedback.some((f) => showDone || !f.done) && <p className="muted small">No new feedback.</p>}
              <ul className="site-feedback">
                {feedback?.filter((f) => showDone || !f.done).map((f) => (
                  <li key={f.id} className={f.done ? 'done' : ''}>
                    <div className="muted small">
                      <b>{FEEDBACK_KINDS.find((k) => k.id === f.kind)?.label ?? f.kind}</b>
                      {' · '}{f.username ? <a href={`/u/${f.username}`} target="_blank" rel="noreferrer">@{f.username}</a> : `${f.from} (guest)`}
                      {' · '}{f.where}{f.device ? ` · ${f.device}` : ''} · {ago(f.createdAt).replace('active now', 'just now')}
                    </div>
                    <p className="small">{f.message}</p>
                    <button className={`btn small ${f.done ? 'ghost' : 'ok'}`} disabled={busy} onClick={() => markFeedback(f, !f.done)}>{f.done ? 'Not done' : 'Done'}</button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {tab === 'rooms' && (
            <>
              <div className="row end"><button className="btn small ghost" onClick={() => void load()}>Refresh</button></div>
              {o && !o.rooms.length && <p className="muted small">No rooms right now.</p>}
              <ul className="site-rooms">
                {[...live, ...idle].map((r) => {
                  const on = r.players.filter((p) => p.online);
                  const solo = !!r.daily || !!r.survival;
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
                        {!solo && <a className="btn small" href={`/r/${r.code}`}>Join</a>}
                        {!solo && on.length > 0 && <button className="btn small" disabled={busy} onClick={() => messageRoom(r.code)}>Message</button>}
                        <button className="btn small bad" disabled={busy} onClick={() => close(r.code)} aria-label={`Close room ${r.code}`} title={`Close room ${r.code}`}>Close</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {tab === 'server' && (
            <>
              {!server ? <p className="muted small">Loading…</p> : (
                <dl className="admin-server">
                  <dt>Version</dt><dd>{server.commit ? <a href={`https://github.com/justtkeno/BuzzBowl/commit/${server.commit}`} target="_blank" rel="noreferrer" className="mono">{server.commit}</a> : 'local'}</dd>
                  <dt>Up for</dt><dd>{uptime(server.uptime)}</dd>
                  <dt>Accounts stored in</dt><dd>{server.accounts === 'postgres' ? 'Postgres (Neon)' : server.accounts === 'file' ? 'a JSON file (local)' : 'unavailable'}</dd>
                  <dt>Account email</dt><dd>{MAIL_LABEL[server.mail] ?? server.mail}</dd>
                  <dt>Links point to</dt><dd>{server.publicUrl ?? 'this server'}</dd>
                  <dt>Open screens</dt><dd>{server.connections}</dd>
                  <dt>Rooms in memory</dt><dd>{server.rooms}</dd>
                  <dt>Memory</dt><dd>{server.memoryMb} MB</dd>
                  <dt>Node</dt><dd>{server.node}</dd>
                </dl>
              )}
              <h3>Email</h3>
              <div className="row gap">
                <button className="btn small" disabled={busy} onClick={testEmail}>Send me a test email</button>
                <button className="btn small ghost" disabled={busy} onClick={() => void loadServer()}>Refresh</button>
              </div>
              <p className="muted small">Goes to the email on your account. If it fails, the reason shows here.</p>
              <h3>Admin lock</h3>
              <AdminLock />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
