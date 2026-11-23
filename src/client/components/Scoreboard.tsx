import { Info } from './Info';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PublicPlayer, PublicState } from '../../shared/types';
import { BOT_SKILLS } from '../../shared/types';
import { act, colorFor, fmtPct, roles } from './util';
import { TitleTag, Verified } from './Account';
import { Icon } from './Icon';

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A number that counts to its new value and floats a "+15" / "−5" label when it changes. */
export function AnimatedScore({ value, className = '' }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const [delta, setDelta] = useState<{ id: number; d: number } | null>(null);
  const from = useRef(value);
  const n = useRef(0);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    from.current = value;
    setDelta({ id: ++n.current, d: value - start });
    const clear = setTimeout(() => setDelta(null), 1400);
    if (reduceMotion()) { setShown(value); return () => clearTimeout(clear); }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 600);
      setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); clearTimeout(clear); };
  }, [value]);
  return (
    <span className={`ascore ${className}`}>
      {shown}
      {delta && <span key={delta.id} className={`delta ${delta.d > 0 ? 'up' : 'down'}`}>{delta.d > 0 ? `+${delta.d}` : `−${-delta.d}`}</span>}
    </span>
  );
}

/** Slide list items to their new places when the order changes (FLIP). */
function useFlip(keys: string[]) {
  const container = useRef<HTMLElement | null>(null);
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const next = new Map<string, number>();
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((node) => {
      const key = node.dataset.flip!;
      const top = node.getBoundingClientRect().top;
      next.set(key, top);
      const old = prev.current.get(key);
      if (old !== undefined && old !== top && !reduceMotion()) {
        node.animate([{ transform: `translateY(${old - top}px)` }, { transform: 'translateY(0)' }], { duration: 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    prev.current = next;
  }, [keys.join(',')]);
  return container;
}

export function Scoreboard({ s }: { s: PublicState }) {
  const r = roles(s);
  const players = s.players.filter((p) => p.id !== s.readerId);
  const reader = s.players.find((p) => p.id === s.readerId);
  const order = s.players.map((p) => p.id);
  const teams = [...s.teams].sort((a, b) => b.points - a.points);
  const ffa = [...players].sort((a, b) => b.stats.points - a.stats.points);
  const flipRef = useFlip(s.settings.mode === 'teams' ? teams.map((t) => t.id) : ffa.map((p) => p.id));

  const row = (p: PublicPlayer, captain?: boolean) => (
    <tr key={p.id} data-flip={p.id} className={`${p.online ? '' : 'offline'} ${p.id === r.me ? 'me' : ''}`}>
      <td className="name">
        {p.pic
          ? <img className="pdot pic" src={p.pic} alt="" decoding="async" style={{ borderColor: colorFor(p.id, order) }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          : <span className="pdot" style={{ background: colorFor(p.id, order) }} />}
        {p.name}
        <Verified username={p.username} admin={p.admin} level={p.level} /><TitleTag title={p.title} />
        {p.streak >= 2 && <span className="streak" title={`${p.streak} tossups in a row`}>×{p.streak}</span>}
        {p.bot && <span className="badge" title={`Computer player · ${BOT_SKILLS[p.bot].blurb}`}>bot · {BOT_SKILLS[p.bot].label.toLowerCase()}</span>}
        {p.id === s.hostId && <span className="badge">host</span>}
        {captain && <span className="badge">capt</span>}
      </td>
      <td className="num" title="powers / tens / negs">{p.stats.powers}/{p.stats.tens}/{p.stats.negs}</td>
      <td className="num pts"><AnimatedScore value={p.stats.points} /></td>
      {r.isController && !r.fixed && (
        <td className="adj">
          <button className="mini" title="−5" aria-label={`Take 5 points from ${p.name}`} onClick={() => act('score:adjust', p.id, -5)}>−</button>
          <button className="mini" title="+5" aria-label={`Give ${p.name} 5 points`} onClick={() => act('score:adjust', p.id, 5)}>+</button>
        </td>
      )}
    </tr>
  );

  return (
    <div className="scoreboard" ref={flipRef as React.RefObject<HTMLDivElement>}>
      {reader && <div className="reader-line"><Icon name="mic" /> Reader: <b>{reader.name}</b>{!reader.online && ' (offline)'}</div>}
      {!reader && s.heldReader && <div className="reader-line muted"><Icon name="mic" /> Reader <b>{s.heldReader.name}</b> is reconnecting. The app reads until they’re back.</div>}
      {s.settings.mode === 'teams' ? (
        teams.map((t) => (
          <div key={t.id} data-flip={t.id} className={`team-block ${r.myTeam === t.id ? 'mine' : ''}`}>
            <div className="team-head">
              <b>{t.name}</b>
              <span className="muted small">{t.bonusesHeard ? `${(t.bonusPoints / t.bonusesHeard).toFixed(1)} PPB` : ''}</span>
              <AnimatedScore value={t.points} className="team-pts" />
            </div>
            <table><tbody>
              {t.playerIds.map((id) => players.find((p) => p.id === id)).filter(Boolean).map((p) => row(p!, t.captainId === p!.id))}
            </tbody></table>
          </div>
        ))
      ) : (
        <table className="ffa">
          <thead><tr><th>Player</th><th className="num">P/10/N<Info term="pn" /></th><th className="num">Pts</th>{r.isController && !r.fixed && <th />}</tr></thead>
          <tbody>{ffa.map((p) => row(p))}</tbody>
        </table>
      )}
      {s.settings.mode === 'teams' && players.some((p) => !p.teamId) && (
        <p className="muted small">Spectating: {players.filter((p) => !p.teamId).map((p) => p.name).join(', ')}</p>
      )}
      <p className="muted small">{s.tossupsRead} tossup{s.tossupsRead === 1 ? '' : 's'} heard</p>
      <CategoryBars s={s} />
    </div>
  );
}

/** This player's results by category so far: how many they heard and how many they converted. */
function CategoryBars({ s }: { s: PublicState }) {
  const me = s.players.find((p) => p.id === s.you);
  const cats = me ? Object.entries(me.stats.categories).filter(([, c]) => c.heard > 0).sort((a, b) => b[1].heard - a[1].heard) : [];
  if (!me || !cats.length) return null;
  const maxHeard = Math.max(...cats.map(([, c]) => c.heard));
  return (
    <div className="catbars">
      <h4>Your categories</h4>
      {cats.map(([name, c]) => {
        const got = c.powers + c.tens;
        return (
          <div key={name} className="catbar" title={`${name}: ${got} of ${c.heard} converted, ${c.points} points`}>
            <span className="cb-name">{name}</span>
            <span className="cb-track" style={{ width: `${(c.heard / maxHeard) * 100}%` }}>
              <span className="cb-power" style={{ width: `${(c.powers / c.heard) * 100}%` }} />
              <span className="cb-ten" style={{ width: `${(c.tens / c.heard) * 100}%` }} />
              {c.negs > 0 && <span className="cb-neg" style={{ width: `${(c.negs / c.heard) * 100}%` }} />}
            </span>
            <span className="cb-val">{got}/{c.heard}</span>
          </div>
        );
      })}
      <p className="muted small cb-legend"><i className="lg power" />power <i className="lg ten" />ten <i className="lg neg" />neg · {fmtPct(me.stats.heard ? (me.stats.powers + me.stats.tens) / me.stats.heard : null)} converted</p>
    </div>
  );
}
