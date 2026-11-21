import { Logo } from './Logo';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicState } from '../../shared/types';
import { cycleTheme } from '../App';
import { prefs } from '../socket';
import { play, setSoundOn, soundOn } from '../sounds';
import { AdminPanel } from './AdminPanel';
import { Chat } from './Chat';
import { DailyResults } from './Daily';
import { ReaderQueue } from './ReaderQueue';
import { AchievementPop, BuzzFlash, FlashAnnouncer, ScreenFlash, useAchievements, useBuzzFlash, useFeedback } from './Feedback';
import { InviteScreen, shareInvite } from './Invite';
import { Lobby } from './Lobby';
import { Review } from './Review';
import { Rulings } from './Rulings';
import { AnimatedScore, Scoreboard } from './Scoreboard';
import { SettingsPanel } from './SettingsPanel';
import { Stage } from './Stage';
import { Summary } from './Summary';
import { act, roles, toast } from './util';
import { useReadAloud } from '../speech';

interface Props {
  state: PublicState; chat: ChatMessage[]; connected: boolean;
  fresh: boolean; onRename: (name: string) => Promise<void>; onLeave: () => void;
}

type Tab = 'board' | 'chat' | 'rulings';
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function RoomView({ state: s, chat, connected, fresh, onRename, onLeave }: Props) {
  const r = roles(s);
  useReadAloud(s);
  const [showSettings, setShowSettings] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [toastMsg, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState(prefs.theme());
  const [tab, setTab] = useState<Tab>('board');
  const [sound, setSound] = useState(soundOn());
  const flash = useFeedback(s);
  const buzzFlash = useBuzzFlash(s);
  const achievement = useAchievements(s);
  const toggleSound = () => { setSoundOn(!sound); setSound(!sound); if (!sound) play('correct'); };
  const midGame = s.phase !== 'lobby' && s.phase !== 'gameOver';
  // Site admins can take the host seat in any room.
  const isAdmin = !!s.players.find((p) => p.id === s.you)?.admin;

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = (e: Event) => { setToast((e as CustomEvent).detail); clearTimeout(t); t = setTimeout(() => setToast(null), 3500); };
    window.addEventListener('qb-toast', on);
    return () => window.removeEventListener('qb-toast', on);
  }, []);

  // "Back online" after a dropped connection.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) toast('Back online');
    wasConnected.current = connected;
  }, [connected]);

  // Remember the host's settings for the next room they create.
  useEffect(() => { if (r.isHost) prefs.setSettings(s.settings); }, [s.settings, r.isHost]);

  // Unread chat: messages that arrived while the chat wasn't on screen.
  const isPhone = useIsPhone();
  const chatVisible = tab === 'chat' && (!isPhone || drawer);
  const seen = useRef(chat.length);
  if (chatVisible) seen.current = chat.length;
  const unread = chat.slice(seen.current).filter((m) => !m.system).length;

  const openDrawer = (t: Tab) => { setTab(t); setDrawer(true); };
  useEffect(() => {
    if (!drawer && !menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDrawer(false); setMenu(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, menu]);

  const phaseLabel: Record<string, string> = {
    lobby: 'Lobby', loading: 'Loading…', reading: s.tossup?.paused ? 'Paused' : 'Reading', buzz: 'Buzz!', tossupEnd: 'Up next', bonus: 'Bonus', gameOver: 'Game over',
  };
  const openProtests = s.protests.length;
  const openBigScreen = () => window.open(`/watch/${s.code}`, '_blank', 'noopener');

  return (
    <div className={`room ${s.phase === 'reading' ? 'is-reading' : ''}`}>
      {!connected && <div className="conn-banner" role="status"><span className="spinner" /> Connection lost — reconnecting…</div>}
      <header className="topbar">
        <div className="brand small"><Logo /><span className="hide-sm">Trivio</span></div>
        {s.daily ? (
          <span className="chip daily-chip">Daily <b>#{s.daily.number}</b>{s.tossup && s.phase !== 'gameOver' ? ` · ${s.tossup.num}/${s.daily.total}` : ''}</span>
        ) : (
          <>
            <button className="chip" onClick={() => shareInvite(s.code)} title="Copy invite link">Room <b>{s.code}</b> ⧉</button>
            <button className="btn primary small hide-sm" onClick={() => setShowInvite(true)} title="Show a big QR code people can scan">Invite</button>
          </>
        )}
        <span className={`phase phase-${s.phase}`}>{s.paused ? 'Paused' : phaseLabel[s.phase]}</span>
        {r.isReader && <span className="badge reader hide-sm">You are reading</span>}
        <div className="grow" />
        {r.isController && midGame && !s.daily && (
          <button className={`btn ${s.paused ? 'primary' : 'ghost'} pause-btn`} onClick={() => act('game:hold', !s.paused)} title={s.paused ? 'Resume the game' : 'Pause the whole game'}>
            {s.paused ? '▶ Resume' : '❚❚'}<span className="hide-sm">{s.paused ? '' : ' Pause'}</span>
          </button>
        )}
        {isAdmin && <button className="btn ghost hide-sm" onClick={() => setShowAdmin(true)} title="Admin: change the host or reader at any time">🛡 Admin</button>}
        <button className="btn ghost hide-sm" onClick={() => setShowReview(true)} title="Review past questions">Review{s.review.length ? ` (${s.review.length})` : ''}</button>
        {r.isController && !s.daily && <button className="btn ghost hide-sm" onClick={() => setShowSettings(true)}>Settings</button>}
        <button className="btn ghost hide-sm" onClick={toggleSound} title={sound ? 'Turn sound effects off' : 'Turn sound effects on'} aria-label={sound ? 'Sound on' : 'Sound off'} aria-pressed={sound}>{sound ? '🔊' : '🔇'}</button>
        <button className="btn ghost hide-sm" title="Switch theme (auto / dark / light)" onClick={() => setTheme(cycleTheme())}>{theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}</button>
        <button className="btn ghost hide-sm" onClick={onLeave}>Leave</button>
        <div className="menu-wrap show-sm">
          <button className="btn ghost menu-btn" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
          {menu && (
            <>
              <div className="menu-back" onClick={() => setMenu(false)} />
              <div className="menu" role="menu" onClick={() => setMenu(false)}>
                {!s.daily && <button role="menuitem" onClick={() => setShowInvite(true)}>📷 Invite (QR code)</button>}
                <button role="menuitem" onClick={() => setShowReview(true)}>📜 Review questions{s.review.length ? ` (${s.review.length})` : ''}</button>
                {r.isController && !s.daily && <button role="menuitem" onClick={() => setShowSettings(true)}>⚙️ Settings</button>}
                <button role="menuitem" onClick={openBigScreen}>📺 Big-screen view</button>
                <button role="menuitem" onClick={toggleSound}>{sound ? '🔇 Sound off' : '🔊 Sound on'}</button>
                <button role="menuitem" onClick={() => setTheme(cycleTheme())}>🌓 Theme: {theme}</button>
                {isAdmin && <button role="menuitem" onClick={() => setShowAdmin(true)}>🛡 Admin</button>}
                {r.isController && midGame && <button role="menuitem" onClick={() => { if (confirm('End the game and show the summary?')) act('game:end'); }}>🏁 End game</button>}
                <button role="menuitem" onClick={onLeave}>🚪 Leave room</button>
              </div>
            </>
          )}
        </div>
      </header>

      <MobileStrip s={s} unread={unread} protests={openProtests} onOpen={openDrawer} />

      {s.message && <div className="banner">{s.message}</div>}

      <main className="layout">
        <section className="stage-col">
          {s.phase === 'lobby' && <Lobby s={s} fresh={fresh} onRename={onRename} onSettings={() => setShowSettings(true)} onBigInvite={() => setShowInvite(true)} onBigScreen={openBigScreen} />}
          {s.phase === 'gameOver' && s.daily && <DailyResults />}
          {s.phase === 'gameOver' && <Summary s={s} />}
          {midGame && <Stage s={s} />}
          {r.isReader && midGame && (
            <div className="row gap end reader-end">
              <button className="btn ghost small hide-sm" onClick={openBigScreen}>Big-screen view</button>
              <button className="btn" onClick={() => { if (confirm('End the match now and show the final scores?')) act('game:end'); }}>🏁 End match</button>
            </div>
          )}
          {r.isReader && (s.phase === 'lobby' || midGame) && <ReaderQueue s={s} onChangeQuestions={s.daily ? undefined : () => setShowQuestions(true)} />}
          {r.isController && !r.isReader && midGame && (
            <div className="row gap end subtle-controls hide-sm">
              <button className="btn ghost small" onClick={openBigScreen}>Big-screen view</button>
              <button className="btn ghost small" onClick={() => { if (confirm('End the game and show the summary?')) act('game:end'); }}>End game</button>
            </div>
          )}
        </section>

        {drawer && <div className="drawer-back" onClick={() => setDrawer(false)} />}
        <aside className={`side-col ${drawer ? 'drawer-open' : ''}`} aria-label="Scores, chat and rulings">
          <div className="drawer-handle show-sm"><button className="btn ghost small" onClick={() => setDrawer(false)} aria-label="Close">Close ✕</button></div>
          <div className="tabs">
            <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Scores</button>
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat{unread ? <span className="dot">{unread}</span> : null}</button>
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

      {s.paused && (
        <div className="paused-overlay" role="status">
          <div>
            ❚❚ Game paused
            <small>{r.isController ? 'Timers are frozen until you resume.' : 'Waiting for the host to resume.'}</small>
            {r.isController && <button className="btn primary big" onClick={() => act('game:hold', false)}>▶ Resume</button>}
          </div>
        </div>
      )}
      {showSettings && <SettingsPanel s={s} onClose={() => setShowSettings(false)} />}
      {showQuestions && <SettingsPanel s={s} only="questions" onClose={() => setShowQuestions(false)} />}
      {showReview && <Review s={s} onClose={() => setShowReview(false)} />}
      {showAdmin && isAdmin && <AdminPanel s={s} onClose={() => setShowAdmin(false)} />}
      {showInvite && <InviteScreen code={s.code} onClose={() => setShowInvite(false)} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      <BuzzFlash flash={buzzFlash} />
      <ScreenFlash flash={flash} />
      <AchievementPop a={achievement} />
      <FlashAnnouncer flash={flash} />
    </div>
  );
}

function useIsPhone() {
  const q = '(max-width: 860px)';
  const [m, setM] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Phones: your score and rank at a glance, plus buttons that open the scores / chat drawer. */
function MobileStrip({ s, unread, protests, onOpen }: { s: PublicState; unread: number; protests: number; onOpen: (t: Tab) => void }) {
  const r = roles(s);
  const teams = s.settings.mode === 'teams';
  const sides = teams
    ? [...s.teams].sort((a, b) => b.points - a.points).map((t) => ({ id: t.id, name: t.name, pts: t.points }))
    : s.players.filter((p) => p.id !== s.readerId).sort((a, b) => b.stats.points - a.stats.points).map((p) => ({ id: p.id, name: p.name, pts: p.stats.points }));
  const mineId = teams ? r.myTeam : r.me;
  const rank = sides.findIndex((x) => x.id === mineId);
  const mine = sides[rank];
  const leader = sides[0];
  const me = s.players.find((p) => p.id === r.me);
  return (
    <div className="mobile-strip show-sm">
      <button className="ms-score" onClick={() => onOpen('board')}>
        {mine ? (
          <>
            <AnimatedScore value={mine.pts} className="ms-pts" />
            <span className="ms-sub">{ordinal(rank + 1)} of {sides.length}{me && me.streak >= 2 ? ` · ${me.streak} in a row` : ''}</span>
          </>
        ) : <span className="ms-sub">{r.isReader ? '🎙 Reading' : 'Spectating'}</span>}
        {leader && leader.id !== mineId && <span className="ms-lead">Leader: {leader.name} {leader.pts}</span>}
      </button>
      <button className="btn ms-btn" onClick={() => onOpen('board')}>Scores</button>
      <button className="btn ms-btn" onClick={() => onOpen('chat')}>Chat{unread ? <span className="dot">{unread}</span> : null}</button>
      {protests > 0 && <button className="btn ms-btn" onClick={() => onOpen('rulings')}>Rulings<span className="dot">{protests}</span></button>}
    </div>
  );
}
