import { useEffect, useState } from 'react';
import type { ChatMessage, PublicState } from '../../shared/types';
import { cycleTheme } from '../App';
import { prefs } from '../socket';
import { Chat } from './Chat';
import { InviteScreen, shareInvite } from './Invite';
import { Lobby } from './Lobby';
import { Review } from './Review';
import { Rulings } from './Rulings';
import { Scoreboard } from './Scoreboard';
import { SettingsPanel } from './SettingsPanel';
import { Stage } from './Stage';
import { Summary } from './Summary';
import { act, roles } from './util';

interface Props {
  state: PublicState; chat: ChatMessage[]; connected: boolean;
  fresh: boolean; onRename: (name: string) => Promise<void>; onLeave: () => void;
}

export function RoomView({ state: s, chat, connected, fresh, onRename, onLeave }: Props) {
  const r = roles(s);
  const [showSettings, setShowSettings] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [toastMsg, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState(prefs.theme());
  const [tab, setTab] = useState<'board' | 'chat' | 'rulings'>('board');

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = (e: Event) => { setToast((e as CustomEvent).detail); clearTimeout(t); t = setTimeout(() => setToast(null), 3500); };
    window.addEventListener('qb-toast', on);
    return () => window.removeEventListener('qb-toast', on);
  }, []);

  const phaseLabel: Record<string, string> = {
    lobby: 'Lobby', loading: 'Loading…', reading: s.tossup?.paused ? 'Paused' : 'Reading', buzz: 'Buzz!', tossupEnd: 'Between questions', bonus: 'Bonus', gameOver: 'Game over',
  };
  const openProtests = s.protests.length;

  return (
    <div className="room">
      <header className="topbar">
        <div className="brand small"><span className="logo">QB</span><span className="hide-sm">BuzzBowl</span></div>
        <button className="chip" onClick={() => shareInvite(s.code)} title="Copy invite link">Room <b>{s.code}</b> ⧉</button>
        <button className={`btn primary small ${s.phase === 'lobby' ? 'hide-sm' : ''}`} onClick={() => setShowInvite(true)} title="Show a big QR code people can scan">Invite</button>
        <span className={`phase phase-${s.phase}`}>{phaseLabel[s.phase]}</span>
        {r.isReader && <span className="badge reader">You are reading</span>}
        {!connected && <span className="badge warn">Reconnecting…</span>}
        <div className="grow" />
        <button className="btn ghost" onClick={() => setShowReview(true)} title="Review past questions">Review{s.review.length ? ` (${s.review.length})` : ''}</button>
        {r.isController && <button className="btn ghost" onClick={() => setShowSettings(true)}>Settings</button>}
        <button className="btn ghost" title="Switch theme (auto / dark / light)" onClick={() => setTheme(cycleTheme())}>{theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}</button>
        <button className="btn ghost" onClick={onLeave}>Leave</button>
      </header>

      {s.message && <div className="banner">{s.message}</div>}

      <main className="layout">
        <section className="stage-col">
          {s.phase === 'lobby' && <Lobby s={s} fresh={fresh} onRename={onRename} onSettings={() => setShowSettings(true)} onBigInvite={() => setShowInvite(true)} />}
          {s.phase === 'gameOver' && <Summary s={s} />}
          {s.phase !== 'lobby' && s.phase !== 'gameOver' && <Stage s={s} />}
          {r.isController && s.phase !== 'lobby' && s.phase !== 'gameOver' && (
            <div className="row gap end subtle-controls">
              <button className="btn ghost small" onClick={() => { if (confirm('End the game and show the summary?')) act('game:end'); }}>End game</button>
            </div>
          )}
        </section>

        <aside className="side-col">
          <div className="tabs">
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Scores</button>
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat</button>
            <button className={tab === 'rulings' ? 'on' : ''} onClick={() => setTab('rulings')}>
              Rulings{openProtests ? <span className="dot">{openProtests}</span> : null}
            </button>
          </div>
          <div className="tab-body">
            {tab === 'board' && <Scoreboard s={s} />}
            {tab === 'chat' && <Chat s={s} messages={chat} />}
            {tab === 'rulings' && <Rulings s={s} />}
          </div>
        </aside>
      </main>

      {showSettings && <SettingsPanel s={s} onClose={() => setShowSettings(false)} />}
      {showReview && <Review s={s} onClose={() => setShowReview(false)} />}
      {showInvite && <InviteScreen code={s.code} onClose={() => setShowInvite(false)} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </div>
  );
}
