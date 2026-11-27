import { Announcement } from './Announcement';
import { Logo } from './Logo';
import { useEffect, useState } from 'react';
import type { PublicState } from '../../shared/types';
import { useTheme } from '../App';
import { useReadAloud } from '../speech';
import { call, socket } from '../socket';
import { InviteQR, inviteUrl } from './Invite';
import { ScoreGraph } from './ScoreGraph';
import { AnimatedScore } from './Scoreboard';
import { BonusCard, QuestionSkeleton, TossupCard } from './Stage';
import { colorFor } from './util';
import { Icon } from './Icon';
import { SettingsMenu } from './AppSettings';

/**
 * Big-screen view for a projector or TV at club practice: large question text and scoreboard,
 * no controls. Open /watch/CODE. It never joins as a player.
 */
export function Spectate({ code }: { code: string }) {
  const [s, setS] = useState<PublicState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [settings, setSettings] = useState(false);
  useTheme();
  useReadAloud(s); // a big screen in a room is a good place to read aloud, if turned on here

  useEffect(() => {
    const watch = () => call<{ state: PublicState }>('room:watch', { code }).then((r) => { setS(r.state); setError(null); }, (e) => setError(e.message));
    const onState = (st: PublicState) => setS(st);
    const onTick = ({ num, i, word }: { num: number; i: number; word: string }) => setS((prev) => {
      if (!prev?.tossup || prev.tossup.num !== num) return prev;
      const revealed = prev.tossup.revealed.slice();
      while (revealed.length < i) revealed.push('');
      revealed[i] = word;
      return { ...prev, tossup: { ...prev.tossup, revealed } };
    });
    const onTyping = ({ kind, text }: { kind: string; text: string }) => setS((prev) => (prev?.buzz && kind === 'tossup' ? { ...prev, buzz: { ...prev.buzz, typing: text } } : prev));
    const onConnect = () => { setConnected(true); watch(); };
    const onDisconnect = () => setConnected(false);
    socket.on('state', onState); socket.on('tick', onTick); socket.on('typing', onTyping);
    socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
    if (socket.connected) watch();
    return () => {
      socket.off('state', onState); socket.off('tick', onTick); socket.off('typing', onTyping);
      socket.off('connect', onConnect); socket.off('disconnect', onDisconnect);
    };
  }, [code]);

  if (!s) {
    return <div className="home"><div className="home-card"><div className="brand"><Logo /> Trivio</div><p>{error ?? 'Connecting…'}</p><a href="/">Back home</a></div></div>;
  }

  const order = s.players.map((p) => p.id);
  const teams = s.settings.mode === 'teams';
  const rows = teams
    ? [...s.teams].sort((a, b) => b.points - a.points).map((t) => ({ id: t.id, name: t.name, pts: t.points, streak: 0, sub: t.playerIds.map((id) => s.players.find((p) => p.id === id)?.name).filter(Boolean).join(', ') }))
    : s.players.filter((p) => p.id !== s.readerId).sort((a, b) => b.stats.points - a.stats.points).map((p) => ({ id: p.id, name: p.name, pts: p.stats.points, streak: p.streak, sub: `${p.stats.powers}/${p.stats.tens}/${p.stats.negs}` }));
  const live = s.phase !== 'lobby' && s.phase !== 'gameOver';

  return (
    <div className="watch">
      <Announcement />
      <header className="watch-top">
        <a className="brand brand-home" href="/"><Logo /> Trivio</a>
        <div className="watch-join">Join at <b>{inviteUrl(s.code).replace(/^https?:\/\//, '').replace(/\/r\/.*/, '')}</b> · code <b className="watch-code">{s.code}</b></div>
        {!connected && <span className="badge warn">Reconnecting…</span>}
        <button className="btn ghost small icon watch-gear" onClick={() => setSettings(true)} title="Settings: text size, theme, sound" aria-label="Settings"><Icon name="gear" /></button>
      </header>
      {settings && <SettingsMenu onClose={() => setSettings(false)} />}

      <main className="watch-main">
        <section className="watch-stage">
          {s.phase === 'lobby' && (
            <div className="watch-lobby">
              <InviteQR code={s.code} size={280} />
              <div>
                <h1>Scan to join</h1>
                <p className="watch-code big">{s.code}</p>
                <p className="muted">{s.players.length} player{s.players.length === 1 ? '' : 's'} in the room. Waiting for the host to start…</p>
              </div>
            </div>
          )}
          {s.phase === 'loading' && <QuestionSkeleton />}
          {live && s.phase !== 'loading' && (s.phase === 'bonus' && s.bonus ? <BonusCard key={`b${s.bonus!.num}`} s={s} /> : s.tossup && <TossupCard key={`t${s.tossup!.num}`} s={s} />)}
          {s.phase === 'gameOver' && (
            <div className="card">
              <h2>Final results</h2>
              <div className="highlights">
                {s.highlights.map((h) => (
                  <div key={h.title} className="hl"><span className="hl-icon">{h.icon}</span><span className="hl-title">{h.title}</span><b className="hl-name">{h.name}</b><span className="hl-detail">{h.detail}</span></div>
                ))}
              </div>
              <ScoreGraph s={s} />
            </div>
          )}
        </section>

        <aside className="watch-board">
          <h2>{teams ? 'Teams' : 'Scores'}</h2>
          <ol>
            {rows.map((row, i) => (
              <li key={row.id} className={i === 0 && row.pts > 0 ? 'lead' : ''}>
                <span className="wb-rank">{i + 1}</span>
                <span className="wb-dot" style={{ background: colorFor(row.id, teams ? s.teams.map((t) => t.id) : order) }} />
                <span className="wb-name">{row.name}{row.streak >= 2 && <span className="streak">×{row.streak}</span>}<small>{row.sub}</small></span>
                <AnimatedScore value={row.pts} className="wb-pts" />
              </li>
            ))}
          </ol>
          <p className="muted">{s.tossupsRead} tossup{s.tossupsRead === 1 ? '' : 's'} heard</p>
        </aside>
      </main>
      {s.paused && <div className="paused-overlay"><div><Icon name="pause" /> Game paused</div></div>}
    </div>
  );
}
