import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicState } from '../shared/types';
import type { PresetSettings } from '../shared/presets';
import { Home } from './components/Home';
import { ConfirmEmail, ResetPassword } from './components/Account';
import { InviteBanner } from './components/Friends';
import { Announcement } from './components/Announcement';
import { WakeScreen } from './components/WakeScreen';
import { Privacy } from './components/Privacy';
import { Leaderboards } from './components/Leaderboards';
import { Help } from './components/Help';
import { Profile } from './components/Profile';
import { RoomView } from './components/RoomView';
import { Spectate } from './components/Spectate';
import { randomName } from './names';
import { dailyKey } from './daily';
import { call, prefs, socket } from './socket';
import { play } from './sounds';
import { toast } from './components/util';

const codeFromPath = () => location.pathname.match(/^\/r\/([A-Za-z]{4,8})/)?.[1]?.toUpperCase() ?? null;
const watchCode = () => location.pathname.match(/^\/watch\/([A-Za-z]{4,8})/)?.[1]?.toUpperCase() ?? null;
const profileName = () => location.pathname.match(/^\/u\/([A-Za-z0-9_]{1,20})\/?$/)?.[1] ?? null;

export function App() {
  return <><Page /><WakeScreen /></>;
}

function Page() {
  const watch = watchCode();
  if (watch) return <Spectate code={watch} />;
  const profile = profileName();
  if (profile) return <Profile username={profile} />;
  if (location.pathname === '/reset') return <ResetPassword />;
  if (location.pathname === '/confirm') return <ConfirmEmail />;
  if (location.pathname === '/privacy') return <Privacy />;
  if (location.pathname === '/help') return <Help />;
  if (location.pathname === '/leaderboards') return <Leaderboards />;
  return <Player />;
}

function Player() {
  const [state, setState] = useState<PublicState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState<string | null>(null);
  // The seat token is also kept here: with site storage blocked, prefs can't hold it, and every reconnect made a new seat.
  const joined = useRef<{ code: string; name: string; token?: string } | null>(null);
  const lastBuzzer = useRef<string | null>(null);
  const autoJoined = useRef(false);
  // True when this player was dropped into a room with a random name, so the lobby offers a rename.
  const [fresh, setFresh] = useState(false);

  useTheme();

  const enter = useCallback(async (code: string, name: string) => {
    const token = prefs.token(code) ?? (joined.current?.code === code ? joined.current.token : undefined);
    const res = await call<{ code: string; playerId: string; token: string; chat: ChatMessage[] }>('room:join', { code, name, token });
    afterJoin(res, name);
  }, []);

  function afterJoin(res: { code: string; token: string; chat: ChatMessage[] }, name: string) {
    prefs.setToken(res.code, res.token);
    prefs.setName(name);
    joined.current = { code: res.code, name, token: res.token };
    setChat(res.chat ?? []);
    setError(null);
    if (codeFromPath() !== res.code) history.replaceState(null, '', `/r/${res.code}`);
  }

  const create = useCallback(async (name: string, solo: boolean, preset?: PresetSettings) => {
    const res = await call<{ code: string; playerId: string; token: string; chat: ChatMessage[] }>('room:create', { name, solo, settings: prefs.settings() });
    afterJoin(res, name);
    // A shared preset's rules go on top of the host's usual settings.
    if (preset) await call('settings:update', preset).catch((e) => setError(e.message));
    if (solo) await call('game:start').catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const onState = (s: PublicState) => {
      setState(s);
      const buzzer = s.buzz?.playerId ?? null;
      if (buzzer && buzzer !== lastBuzzer.current) play(buzzer === s.you ? 'buzzMine' : 'buzzOther');
      lastBuzzer.current = buzzer;
    };
    const onTick = ({ num, i, word }: { num: number; i: number; word: string }) => {
      setState((prev) => {
        if (!prev?.tossup || prev.tossup.num !== num) return prev;
        const revealed = prev.tossup.revealed.slice();
        while (revealed.length < i) revealed.push('');
        revealed[i] = word;
        return { ...prev, tossup: { ...prev.tossup, revealed } };
      });
    };
    const onTyping = ({ kind, text }: { kind: 'tossup' | 'bonus'; text: string }) => {
      setState((prev) => {
        if (!prev) return prev;
        if (kind === 'tossup' && prev.buzz) return { ...prev, buzz: { ...prev.buzz, typing: text } };
        if (kind === 'bonus' && prev.bonus) return { ...prev, bonus: { ...prev.bonus, typing: text } };
        return prev;
      });
    };
    const onChat = (m: ChatMessage) => setChat((c) => [...c.slice(-150), m]);
    const onConnect = () => {
      setConnected(true);
      // Rejoin after a dropped connection with the saved token.
      const j = joined.current;
      // If the room is gone (cleaned up while the phone slept), go home and say so instead of showing a frozen room.
      if (j) enter(j.code, j.name).catch((e) => {
        joined.current = null;
        setState(null);
        history.replaceState(null, '', '/');
        setError(e.message);
      });
    };
    const onDisconnect = () => setConnected(false);
    // The host, reader or admin removed us from the room.
    const onKicked = ({ banned, closed }: { banned: boolean; closed?: boolean }) => {
      joined.current = null;
      setFresh(false);
      setState(null);
      history.replaceState(null, '', '/');
      setError(banned ? 'You were banned from that room.' : closed ? 'An admin closed that room.' : 'You were removed from the room.');
    };
    socket.on('kicked', onKicked);
    socket.on('state', onState);
    socket.on('tick', onTick);
    socket.on('typing', onTyping);
    socket.on('chat', onChat);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('state', onState); socket.off('tick', onTick); socket.off('typing', onTyping);
      socket.off('chat', onChat); socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); socket.off('kicked', onKicked);
    };
  }, [enter]);

  // Opening a /r/CODE invite link joins straight away. First-timers get a random name they can change in the lobby.
  useEffect(() => {
    const code = codeFromPath();
    if (!code || autoJoined.current) return;
    autoJoined.current = true;
    const saved = prefs.name();
    const name = saved || randomName();
    enter(code, name).then(() => setFresh(!saved), (e) => setError(e.message));
  }, [enter]);

  // Daily challenge: a fresh solo room, or back into today's if it was interrupted.
  const startDaily = useCallback(async (name: string) => {
    const res = await call<{ resume?: string; code: string; playerId: string; token: string; chat: ChatMessage[] }>('daily:start', { name, key: dailyKey() });
    if (res.resume) return enter(res.resume, name);
    afterJoin(res, name);
  }, [enter]);

  // Survival: a fresh solo run, or back into the one in progress.
  const startSurvival = useCallback(async (name: string) => {
    const res = await call<{ resume?: string; code: string; playerId: string; token: string; chat: ChatMessage[] }>('survival:start', { name, key: dailyKey() });
    if (res.resume) return enter(res.resume, name);
    afterJoin(res, name);
  }, [enter]);

  const rename = useCallback(async (name: string) => {
    await call('player:rename', name);
    prefs.setName(name);
    if (joined.current) joined.current = { ...joined.current, name };
    setFresh(false);
  }, []);

  const leave = () => {
    joined.current = null;
    setFresh(false);
    setState(null);
    history.replaceState(null, '', '/');
    socket.disconnect();
    socket.connect();
  };

  if (!state) {
    return (
      <>
        <Home initialCode={codeFromPath()} error={error} connected={connected} onJoin={enter} onCreate={create} onDaily={startDaily} onSurvival={startSurvival} dailyOpen={location.pathname === '/daily'} survivalOpen={location.pathname === '/survival'} />
        <InviteBanner onJoin={(code) => { enter(code, prefs.name() || randomName()).catch((e) => setError(e.message)); }} />
        <Announcement />
      </>
    );
  }
  // From the friends panel: hop straight into a friend's room.
  const joinFriend = (code: string) => {
    const name = joined.current?.name || prefs.name() || randomName();
    enter(code, name).then(() => setFresh(false), (e) => toast(e.message));
  };
  return (
    <>
      <RoomView state={state} chat={chat} connected={connected} fresh={fresh} onRename={rename} onLeave={leave} onJoinRoom={joinFriend}
        onSurvival={() => startSurvival(joined.current?.name || prefs.name() || randomName())} />
      <InviteBanner currentCode={state.code} quiet={(!!state.daily && !state.daily.done) || (!!state.survival && !state.survival.done)} onJoin={joinFriend} />
    </>
  );
}

/** The top bar's color (--surface) in each theme. */
const LIGHT_BAR = '#ffffff', DARK_BAR = '#1d1c1a';

/**
 * Themes a player can pick for this device. Auto follows the system. The full themes (midnight, sand, slate) sit on
 * top of light or dark mode: `data-theme` gets the mode, so every dark/light rule still applies, and `data-palette`
 * swaps the surfaces (values in styles.css). Accent colors combine with any of them.
 */
export const THEMES = [
  { id: 'auto', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight', mode: 'dark', bar: '#121a2e' },
  { id: 'sand', label: 'Sand', mode: 'light', bar: '#fbf6ec' },
  { id: 'slate', label: 'Slate', mode: 'light', bar: '#ffffff' },
] as const;
export type Theme = (typeof THEMES)[number]['id'];
const themeOf = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export function useTheme() {
  useEffect(() => {
    const apply = () => {
      const th = themeOf(prefs.theme());
      const t = 'mode' in th ? th.mode : th.id;
      if (t === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      if ('mode' in th) document.documentElement.setAttribute('data-palette', th.id);
      else document.documentElement.removeAttribute('data-palette');
      document.documentElement.setAttribute('data-text', prefs.textSize());
      const a = prefs.accent();
      if (a === 'ink' || !ACCENTS.some(([k]) => k === a)) document.documentElement.removeAttribute('data-accent');
      else document.documentElement.setAttribute('data-accent', a);
      // The phone's status bar matches the top bar, in the theme the player picked.
      const fixed = 'bar' in th ? th.bar : undefined;
      const light = fixed ?? (t === 'dark' ? DARK_BAR : LIGHT_BAR), dark = fixed ?? (t === 'light' ? LIGHT_BAR : DARK_BAR);
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
        m.content = /dark/.test(m.media) ? dark : light;
      });
    };
    apply();
    window.addEventListener('qb-theme', apply);
    return () => window.removeEventListener('qb-theme', apply);
  }, []);
}

export const TEXT_SIZE_LABEL = { s: 'Small', m: 'Medium', l: 'Large' } as const;

/** Pick a question text size for this device (the Display panel). */
export function setTextSizeChoice(t: 's' | 'm' | 'l') {
  prefs.setTextSize(t);
  window.dispatchEvent(new Event('qb-theme'));
}

/** Accent colors a player can pick for this device. The values live in styles.css (`[data-accent=…]`). */
export const ACCENTS = [['ink', 'Ink'], ['ember', 'Ember'], ['ocean', 'Ocean'], ['rose', 'Rose'], ['teal', 'Teal'], ['mono', 'Mono']] as const;
export type Accent = (typeof ACCENTS)[number][0];

export function setAccentChoice(a: Accent) {
  prefs.setAccent(a);
  window.dispatchEvent(new Event('qb-theme'));
}

/** Pick a theme for this device: auto follows the system's light or dark setting. */
export function setThemeChoice(t: Theme) {
  prefs.setTheme(t);
  window.dispatchEvent(new Event('qb-theme'));
}

