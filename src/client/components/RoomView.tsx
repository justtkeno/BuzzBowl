import { Logo } from './Logo';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicState } from '../../shared/types';
import { SettingsMenu } from './AppSettings';
import { prefs } from '../socket';

import { SiteAdminPanel } from './SiteAdmin';
import { Announcement } from './Announcement';
import { PlayersPanel } from './PlayersPanel';
import { Chat } from './Chat';
import { DailyResults } from './Daily';
import { SurvivalChip, SurvivalResults } from './Survival';
import { FriendsTab } from './Friends';
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
import { SendFeedback } from './SendFeedback';
import { PingChip } from './Ping';
import { Icon } from './Icon';
import { Tutorial } from './Tutorial';

interface Props {
  state: PublicState; chat: ChatMessage[]; connected: boolean;
  fresh: boolean; onRename: (name: string) => Promise<void>; onLeave: () => void;
  /** Move to a friend's room. */
  onJoinRoom: (code: string) => void;
  /** Start a new survival run (Play again). */
  onSurvival?: () => Promise<void>;
}

type Tab = 'board' | 'chat' | 'rulings';
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export function RoomView({ state: s, chat, connected, fresh, onRename, onLeave, onJoinRoom, onSurvival }: Props) {
  const r = roles(s);
  const topbar = useTopbarHeight();
  const [showSettings, setShowSettings] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [toastMsg, setToast] = useState<string | null>(null);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [tab, setTab] = useState<Tab>('board');
  const flash = useFeedback(s);
  const buzzFlash = useBuzzFlash(s);
  const achievement = useAchievements(s);
  const midGame = s.phase !== 'lobby' && s.phase !== 'gameOver';
  // Phones shouldn't dim or lock while a question is being read.
  useWakeLock(midGame && !s.paused);
  // Mid-match, leaving asks first (and so does closing the tab).
  const leave = () => (midGame ? setLeaving(true) : onLeave());
  useEffect(() => {
    if (!midGame) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [midGame]);
  // Site admins can take the host seat in any room.
  const isAdmin = !!s.players.find((p) => p.id === s.you)?.admin;
  const canModerate = (r.isController || isAdmin) && !r.fixed;

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
  const endPrompt = s.survival ? 'End this run now? It counts as finished, with the tossups you’ve played.' : 'End the game and show the summary?';

  return (
    <div className={`room ${s.phase === 'reading' ? 'is-reading' : ''}`}>
      {!connected && <div className="conn-banner" role="status"><span className="spinner" /> Connection lost — reconnecting…</div>}
      <header className="topbar" ref={topbar}>
        <div className="brand small"><Logo /><span className="hide-sm">Trivio</span></div>
        {s.daily ? (
          <span className="chip daily-chip">Daily <b>#{s.daily.number}</b>{s.tossup && s.phase !== 'gameOver' ? ` · ${s.tossup.num}/${s.daily.total}` : ''}</span>
        ) : s.survival ? <SurvivalChip s={s} /> : (
          <>
            <button className="chip" onClick={() => shareInvite(s.code)} title="Copy the invite link">Room <b>{s.code}</b> ⧉</button>
          </>
        )}
        <span className={`phase phase-${s.phase}`}>{s.paused ? 'Paused' : phaseLabel[s.phase]}</span>
        <div className="grow" />
        <PingChip />
        {r.isController && midGame && !r.fixed && (
          <button className={`btn ${s.paused ? 'primary' : 'ghost'} pause-btn`} onClick={() => act('game:hold', !s.paused)} title={s.paused ? 'Resume the game' : 'Pause the whole game'}>
            {s.paused ? <><Icon name="play" /> Resume</> : <Icon name="pause" />}<span className="hide-sm">{s.paused ? '' : ' Pause'}</span>
          </button>
        )}
        <div className="menu-wrap">
          <button className="btn ghost menu-btn" aria-label="Menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯<span className="hide-sm"> Menu</span></button>
          {menu && (
            <>
              <div className="menu-back" onClick={() => setMenu(false)} />
              <div className="menu" role="menu" onClick={() => setMenu(false)}>
                <div className="menu-label">This room</div>
                {!r.fixed && <button role="menuitem" onClick={() => setShowInvite(true)}><Icon name="qr" /> Invite people</button>}
                <button role="menuitem" onClick={() => setShowReview(true)}><Icon name="list" /> Review questions{s.review.length ? ` (${s.review.length})` : ''}</button>
                {!r.fixed && <button role="menuitem" onClick={openBigScreen}><Icon name="screen" /> Big-screen view</button>}
                {(r.isController && !r.fixed) || canModerate || isAdmin ? <div className="menu-label">{r.isReader ? 'Reader' : r.isHost ? 'Host' : 'Admin'}</div> : null}
                {r.isController && !r.fixed && <button role="menuitem" onClick={() => setShowSettings(true)}><Icon name="sliders" /> Room settings <span className="menu-hint">rules for this room</span></button>}
                {canModerate && <button role="menuitem" onClick={() => setShowPlayers(true)}><Icon name="users" /> Players <span className="menu-hint">kick, ban, mute</span></button>}
                {r.isController && midGame && <button role="menuitem" onClick={() => { if (confirm(endPrompt)) act('game:end'); }}><Icon name="flag" /> {s.survival ? 'End run' : 'End game'}</button>}
                {isAdmin && <button role="menuitem" onClick={() => setShowAdmin(true)}><Icon name="shield" /> Admin</button>}
                <div className="menu-label">You</div>
                <button role="menuitem" onClick={() => setShowAppSettings(true)}><Icon name="gear" /> Settings <span className="menu-hint">account, sound, display</span></button>
                <button role="menuitem" onClick={() => setShowTour(true)}><Icon name="help" /> How to play</button>
                <a role="menuitem" href="/help" target="_blank" rel="noreferrer"><Icon name="help" /> Help and glossary</a>
                <button role="menuitem" onClick={() => setShowFeedback(true)}><Icon name="chat" /> Send feedback</button>
                <div className="menu-sep" />
                <button role="menuitem" onClick={leave}><Icon name="leave" /> Leave room</button>
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
          {s.phase === 'gameOver' && s.survival && <SurvivalResults s={s} onPlayAgain={onSurvival} />}
          {s.phase === 'gameOver' && <Summary s={s} />}
          {midGame && <Stage s={s} />}
          {r.isReader && midGame && (
            <div className="row gap end reader-end">
              <button className="btn ghost small hide-sm" onClick={openBigScreen}>Big-screen view</button>
              <button className="btn" onClick={() => { if (confirm('End the match now and show the final scores?')) act('game:end'); }}><Icon name="flag" /> End match</button>
            </div>
          )}
          {r.isReader && (s.phase === 'lobby' || midGame) && <ReaderQueue s={s} onChangeQuestions={r.fixed ? undefined : () => setShowQuestions(true)} />}
          {r.isController && !r.isReader && midGame && (
            <div className="row gap end subtle-controls hide-sm">
              {!r.fixed && <button className="btn ghost small" onClick={openBigScreen}>Big-screen view</button>}
              <button className="btn ghost small" onClick={() => { if (confirm(endPrompt)) act('game:end'); }}>{s.survival ? 'End run' : 'End game'}</button>
            </div>
          )}
        </section>

        {drawer && <div className="drawer-back" onClick={() => setDrawer(false)} />}
        <aside className={`side-col ${drawer ? 'drawer-open' : ''}`} aria-label="Scores, chat and rulings">
          <div className="drawer-handle show-sm"><button className="btn ghost small" onClick={() => setDrawer(false)} aria-label="Close">Close <Icon name="close" /></button></div>
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
            <Icon name="pause" /> Game paused
            <small>{r.isController ? 'Timers are frozen until you resume.' : 'Waiting for the host to resume.'}</small>
            {r.isController && <button className="btn primary big" onClick={() => act('game:hold', false)}>▶ Resume</button>}
          </div>
        </div>
      )}
      {showTour && <Tutorial onClose={() => setShowTour(false)} />}
      {showAppSettings && <SettingsMenu onClose={() => setShowAppSettings(false)} />}
      {showSettings && <SettingsPanel s={s} onClose={() => setShowSettings(false)} />}
      {showQuestions && <SettingsPanel s={s} only="questions" onClose={() => setShowQuestions(false)} />}
      {showReview && <Review s={s} onClose={() => setShowReview(false)} />}
      {showFeedback && <SendFeedback where={`room ${s.code}`} onClose={() => setShowFeedback(false)} />}
      {showAdmin && isAdmin && <SiteAdminPanel room={{ s, onPlayers: () => { setShowAdmin(false); setShowPlayers(true); } }} onClose={() => setShowAdmin(false)} />}
      {showPlayers && canModerate && <PlayersPanel s={s} onClose={() => setShowPlayers(false)} />}
      {/* Off screen while questions are being read, so it never gets in the way of buzzing. */}
      <FriendsTab hidden={midGame || drawer} currentCode={s.code} onJoin={onJoinRoom} disabled={!connected} canInvite={!r.fixed} />
      <Announcement />
      {leaving && <LeaveConfirm s={s} isHost={r.isHost} onStay={() => setLeaving(false)} onLeave={() => { setLeaving(false); onLeave(); }} />}
      {showInvite && <InviteScreen code={s.code} onClose={() => setShowInvite(false)} />}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      <BuzzFlash flash={buzzFlash} />
      <ScreenFlash flash={flash} />
      <AchievementPop a={achievement} />
      <FlashAnnouncer flash={flash} />
    </div>
  );
}

/** Keep the screen on while `on` (browsers that support it). Re-taken when the tab comes back, since hiding it drops the lock. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!on || !wl) return;
    let lock: { release(): Promise<void> } | null = null;
    let done = false;
    const take = () => {
      if (done || document.visibilityState !== 'visible') return;
      wl.request('screen').then((l) => { if (done) void l.release().catch(() => {}); else lock = l; }, () => { /* not allowed (low battery, etc.) */ });
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}

/** "Are you sure?" before walking out of a match that's still going. */
function LeaveConfirm({ s, isHost, onStay, onLeave }: { s: PublicState; isHost: boolean; onStay: () => void; onLeave: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onStay();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStay]);
  const others = s.players.filter((p) => p.online && !p.bot && p.id !== s.you).length;
  const body = s.survival
    ? 'Your run keeps going while you’re away, so any tossup that goes by costs a life. To finish it now, use End run instead.'
    : s.daily
      ? 'The daily challenge keeps going while you’re away. You can come back from the home page to finish it, but tossups you miss still count.'
      : `You’ll drop out of this match${others ? ` with ${others} other player${others === 1 ? '' : 's'}` : ''}. You can rejoin with the room code while it’s still going.${isHost && others ? ' Someone else will take over as host.' : ''}`;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onStay()}>
      <div className="modal leave-confirm" role="alertdialog" aria-labelledby="leave-title" aria-describedby="leave-body">
        <h2 id="leave-title">{s.survival ? 'Leave your run?' : s.daily ? 'Leave the daily challenge?' : 'Leave the game?'}</h2>
        <p id="leave-body" className="muted">{body}</p>
        <div className="row gap end">
          <button className="btn" autoFocus onClick={onStay}>Stay</button>
          <button className="btn bad" onClick={onLeave}>Leave</button>
        </div>
      </div>
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
        ) : <span className="ms-sub">{r.isReader ? <><Icon name="mic" /> Reading</> : 'Spectating'}</span>}
        {leader && leader.id !== mineId && <span className="ms-lead">Leader: {leader.name} {leader.pts}</span>}
      </button>
      <button className="btn ms-btn" onClick={() => onOpen('board')}>Scores</button>
      <button className="btn ms-btn" onClick={() => onOpen('chat')}>Chat{unread ? <span className="dot">{unread}</span> : null}</button>
      {protests > 0 && <button className="btn ms-btn" onClick={() => onOpen('rulings')}>Rulings<span className="dot">{protests}</span></button>}
    </div>
  );
}

/**
 * Keeps --topbar-h equal to the top bar's real height, so the phone score strip sticks right under it.
 * The bar is taller in a home-screen app (it leaves room for the status bar) and when its buttons wrap.
 */
function useTopbarHeight() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const set = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el, { box: 'border-box' }); // padding for the status bar counts too
    return () => ro.disconnect();
  }, []);
  return ref;
}

