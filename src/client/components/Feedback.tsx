import { useEffect, useRef, useState } from 'react';
import type { PublicState, Ruling } from '../../shared/types';
import { play, type Cue } from '../sounds';

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
    timer.current = setTimeout(() => setFlash(null), 1600);
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
      if (r.type === 'bonus') {
        if (r.correct) show('correct', `${who}+${r.points}`, sub ?? 'Bonus part correct');
        else show('wrong', `${who}Missed`, flipped ? sub : 'Bonus part');
      } else if (r.correct) {
        show(r.kind === 'power' ? 'power' : 'correct', `${who}${r.kind === 'power' ? 'POWER! ' : ''}+${r.points}`, sub);
      } else if (r.kind === 'neg') {
        show('neg', `${who}Neg ${r.points}`.replace('-', '−'), sub ?? (r.given ? `“${r.given}”` : 'Out of time'));
      } else {
        show('wrong', `${who}No points`, sub ?? (r.given ? `“${r.given}”` : 'Out of time'));
      }
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
