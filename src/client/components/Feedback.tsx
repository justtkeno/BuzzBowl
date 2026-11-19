import { useEffect, useRef, useState } from 'react';
import type { PublicState, Ruling } from '../../shared/types';
import { play, type Cue } from '../sounds';
import { colorFor, vibrate } from './util';

type Tone = 'power' | 'correct' | 'neg' | 'wrong' | 'prompt';
interface Flash { id: number; tone: Tone; label: string; sub?: string }

/**
 * Watches the room state for results that belong to this player (or their team) and turns
 * each new one into a screen-edge flash, a score pop and a sound.
 */
export function useFeedback(s: PublicState): Flash | null {
  const [flash, setFlash] = useState<Flash | null>(null);
  const seen = useRef<Map<string, boolean> | null>(null);
  const prompts = useRef({ key: '', n: 0 });
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const me = s.you;
  const myTeam = s.players.find((p) => p.id === me)?.teamId ?? null;
  const teams = s.settings.mode === 'teams';
  const isMine = (r: Ruling) => r.playerId === me || (teams && !!myTeam && r.teamId === myTeam);

  const show = (tone: Tone, label: string, sub?: string) => {
    const cue: Cue = tone;
    play(cue);
    clearTimeout(timer.current);
    setFlash({ id: ++counter.current, tone, label, sub });
    timer.current = setTimeout(() => setFlash(null), 1200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // New rulings, and rulings flipped by an upheld protest.
  useEffect(() => {
    const first = seen.current === null;
    seen.current ??= new Map();
    for (const r of s.rulings) {
      const before = seen.current.get(r.id);
      seen.current.set(r.id, r.correct);
      if (first || before === r.correct || !isMine(r)) continue;
      const flipped = before !== undefined;
      const who = r.playerId === me ? '' : `${r.playerName}: `;
      const fixed = r.correct && r.correctedTo && r.given ? `“${r.given}” accepted as ${r.correctedTo}` : undefined;
      const sub = flipped ? 'Protest upheld — score updated' : fixed;
      const pts = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
      if (r.type === 'bonus') show(r.correct ? 'correct' : 'wrong', `${who}${pts(r.points)}`, sub);
      else if (r.correct) show(r.kind === 'power' ? 'power' : 'correct', `${who}${pts(r.points)}`, sub ?? (r.kind === 'power' ? 'Power' : undefined));
      else show(r.kind === 'neg' ? 'neg' : 'wrong', `${who}${pts(r.points)}`, sub);
    }
  }, [s.rulings]);

  // Prompts on my own tossup answer, or on my team's bonus answer.
  useEffect(() => {
    const b = s.buzz;
    const bn = s.bonus;
    const mine = b && b.playerId === me ? { key: `t${s.tossup?.num}`, n: b.prompts }
      : bn && teams && bn.teamId === myTeam && !bn.done ? { key: `b${bn.num}-${bn.current}`, n: bn.prompts }
        : null;
    if (!mine) return;
    if (mine.key === prompts.current.key && mine.n > prompts.current.n) show('prompt', 'Prompt', 'Be more specific');
    prompts.current = mine;
  }, [s.buzz?.prompts, s.buzz?.playerId, s.bonus?.prompts, s.bonus?.current]);

  return flash;
}

export function ScreenFlash({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  return (
    <div key={flash.id} className={`flash flash-${flash.tone}`} aria-hidden="true">
      <div className="flash-pop">
        <div className="flash-label">{flash.label}</div>
        {flash.sub && <div className="flash-sub">{flash.sub}</div>}
      </div>
    </div>
  );
}

/** Screen-reader text for the same result. */
export function FlashAnnouncer({ flash }: { flash: Flash | null }) {
  return <div className="sr-only" role="status" aria-live="polite">{flash ? `${flash.label}${flash.sub ? `. ${flash.sub}` : ''}` : ''}</div>;
}

interface BuzzFlashT { id: number; color: string; label: string; mine: boolean }

/** A quick screen-edge glow in the buzzing player's color whenever someone wins a buzz. */
export function useBuzzFlash(s: PublicState): BuzzFlashT | null {
  const [flash, setFlash] = useState<BuzzFlashT | null>(null);
  const last = useRef<string | null>(s.buzz ? `${s.tossup?.num}:${s.buzz.playerId}` : null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const key = s.buzz ? `${s.tossup?.num}:${s.buzz.playerId}` : null;
  useEffect(() => {
    if (key && key !== last.current && s.buzz) {
      const mine = s.buzz.playerId === s.you;
      if (mine) vibrate([40, 30, 40]);
      clearTimeout(timer.current);
      setFlash({ id: ++counter.current, color: colorFor(s.buzz.playerId), label: mine ? 'You buzzed' : `${s.buzz.playerName} buzzed`, mine });
      timer.current = setTimeout(() => setFlash(null), 1000);
    }
    last.current = key;
  }, [key]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flash;
}

export function BuzzFlash({ flash }: { flash: BuzzFlashT | null }) {
  if (!flash) return null;
  return (
    <div key={flash.id} className={`buzzflash ${flash.mine ? 'mine' : ''}`} style={{ ['--pc' as string]: flash.color }} aria-hidden="true">
      <div className="buzzflash-label">{flash.label}</div>
    </div>
  );
}

interface Achievement { id: number; icon: string; text: string }

/** Small badge pop-ups for this player's milestones: first power, and tossup streaks. */
export function useAchievements(s: PublicState): Achievement | null {
  const [cur, setCur] = useState<Achievement | null>(null);
  const me = s.players.find((p) => p.id === s.you);
  const prev = useRef<{ powers: number; streak: number } | null>(null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!me) return;
    const before = prev.current;
    prev.current = { powers: me.stats.powers, streak: me.streak };
    if (!before) return;
    let a: Omit<Achievement, 'id'> | null = null;
    if (before.powers === 0 && me.stats.powers === 1) a = { icon: '✦', text: 'First power' };
    else if (me.streak > before.streak && [3, 5, 7, 10, 15].includes(me.streak)) a = { icon: '✦', text: `${me.streak} in a row` };
    if (!a) return;
    const shown = a;
    // Let the correct-answer flash play first.
    const t = setTimeout(() => {
      play('streak');
      clearTimeout(timer.current);
      setCur({ id: ++counter.current, ...shown });
      timer.current = setTimeout(() => setCur(null), 2600);
    }, 900);
    return () => clearTimeout(t);
  }, [me?.stats.powers, me?.streak]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return cur;
}

export function AchievementPop({ a }: { a: Achievement | null }) {
  if (!a) return null;
  return <div key={a.id} className="achievement" role="status"><span className="ach-icon">{a.icon}</span>{a.text}</div>;
}
