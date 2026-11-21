import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicState } from '../shared/types';
import { Home } from './components/Home';
import { Profile } from './components/Profile';
import { RoomView } from './components/RoomView';
import { Spectate } from './components/Spectate';
import { randomName } from './names';
import { dailyKey } from './daily';
import { call, prefs, socket } from './socket';
import { play } from './sounds';

const codeFromPath = () => location.pathname.match(/^\/r\/([A-Za-z]{4,8})/)?.[1]?.toUpperCase() ?? null;
const watchCode = () => location.pathname.match(/^\/watch\/([A-Za-z]{4,8})/)?.[1]?.toUpperCase() ?? null;
const profileName = () => location.pathname.match(/^\/u\/([A-Za-z0-9_]{1,20})\/?$/)?.[1] ?? null;

export function App() {
  const watch = watchCode();
  if (watch) return <Spectate code={watch} />;
  const profile = profileName();
  if (profile) return <Profile username={profile} />;
  return <Player />;
}

function Player() {
  const [state, setState] = useState<PublicState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState<string | null>(null);
  const joined = useRef<{ code: string; name: string } | null>(null);
  const lastBuzzer = useRef<string | null>(null);
  const autoJoined = useRef(false);
  // True when this player was dropped into a room with a random name, so the lobby offers a rename.
  const [fresh, setFresh] = useState(false);

  useTheme();

  const enter = useCallback(async (code: string, name: string) => {
    const res = await call<{ code: string; playerId: string; token: string; chat: ChatMessage[] }>('room:join', { code, name, token: prefs.token(code) });
    afterJoin(res, name);
  }, []);

  function afterJoin(res: { code: string; token: string; chat: ChatMessage[] }, name: string) {
    prefs.setToken(res.code, res.token);
    prefs.setName(name);
    joined.current = { code: res.code, name };
    setChat(res.chat ?? []);
    setError(null);
    if (codeFromPath() !== res.code) history.replaceState(null, '', `/r/${res.code}`);
  }

  const create = useCallback(async (name: string, solo: boolean) => {
    const res = await call<{ code: string; playerId: string; token: string; chat: ChatMessage[] }>('room:create', { name, solo, settings: prefs.settings() });
    afterJoin(res, name);
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
      if (j) enter(j.code, j.name).catch((e) => setError(e.message));
    };
    const onDisconnect = () => setConnected(false);
    // The host, reader or admin removed us from the room.
    const onKicked = ({ banned }: { banned: boolean }) => {
      joined.current = null;
      setFresh(false);
      setState(null);
      history.replaceState(null, '', '/');
      setError(banned ? 'You were banned from that room.' : 'You were removed from the room.');
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
    return <Home initialCode={codeFromPath()} error={error} connected={connected} onJoin={enter} onCreate={create} onDaily={startDaily} dailyOpen={location.pathname === '/daily'} />;
  }
  return <RoomView state={state} chat={chat} connected={connected} fresh={fresh} onRename={rename} onLeave={leave} />;
}

export function useTheme() {
  useEffect(() => {
    const apply = () => {
      const t = prefs.theme();
      if (t === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
    };
    apply();
    window.addEventListener('qb-theme', apply);
    return () => window.removeEventListener('qb-theme', apply);
  }, []);
}

export function cycleTheme() {
  const order = ['auto', 'dark', 'light'] as const;
  const next = order[(order.indexOf(prefs.theme()) + 1) % order.length];
  prefs.setTheme(next);
  window.dispatchEvent(new Event('qb-theme'));
  return next;
}
