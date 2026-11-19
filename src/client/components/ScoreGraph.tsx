import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicState } from '../../shared/types';
import { colorFor } from './util';

const MAX_SERIES = 7;

/** Running score after each tossup: one line per team (or player in free-for-all), with a hover crosshair. */
export function ScoreGraph({ s }: { s: PublicState }) {
  const h = s.history;
  const teams = s.settings.mode === 'teams';
  const sides = useMemo(() => {
    const all = teams
      ? s.teams.map((t) => ({ id: t.id, name: t.name }))
      : s.players.filter((p) => p.id !== s.readerId).map((p) => ({ id: p.id, name: p.name }));
    const final = h[h.length - 1]?.totals ?? {};
    // Color follows the entity (its join order), not its rank.
    const order = all.map((x) => x.id);
    return all
      .filter((x) => x.id in final)
      .sort((a, b) => (final[b.id] ?? 0) - (final[a.id] ?? 0))
      .slice(0, MAX_SERIES)
      .map((x) => ({ ...x, color: colorFor(x.id, order) }));
  }, [h, s.teams, s.players]);
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Draw at the real pixel width so text stays 11px on phones instead of shrinking with the chart.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [h.length >= 3]);

  if (h.length < 3 || !sides.length) return null;
  const H = W < 480 ? 200 : 240, L = 30, R = W < 480 ? 84 : 96, T = 12, B = 26;
  const vals = h.flatMap((p) => sides.map((x) => p.totals[x.id] ?? 0));
  const lo = Math.min(0, ...vals), hi = Math.max(10, ...vals);
  const x = (i: number) => L + (i / (h.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = niceStep((hi - lo) / 4);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);

  // Direct labels at the line ends, nudged apart so they don't collide.
  const ends = sides.map((sd) => ({ ...sd, v: h[h.length - 1].totals[sd.id] ?? 0, ly: y(h[h.length - 1].totals[sd.id] ?? 0) }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < ends.length; i++) if (ends[i].ly - ends[i - 1].ly < 14) ends[i].ly = ends[i - 1].ly + 14;

  const onMove = (e: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(h.length - 1, Math.round(((px - L) / (W - L - R)) * (h.length - 1)))));
  };
  const hp = hover !== null ? h[hover] : null;

  return (
    <figure className="scoregraph">
      <figcaption>Score over the game</figcaption>
      <div className="sg-legend">
        {sides.map((sd) => <span key={sd.id}><i style={{ background: sd.color }} />{sd.name}</span>)}
      </div>
      <div className="sg-wrap" ref={wrap}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score by tossup for ${sides.map((sd) => sd.name).join(', ')}`}
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? 'sg-zero' : 'sg-grid'} />
              <text x={L - 6} y={y(v) + 4} className="sg-axis" textAnchor="end">{v}</text>
            </g>
          ))}
          <text x={L} y={H - 6} className="sg-axis">start</text>
          <text x={W - R} y={H - 6} className="sg-axis" textAnchor="end">tossup {h[h.length - 1].num}</text>
          {sides.map((sd) => (
            <polyline key={sd.id} fill="none" stroke={sd.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={h.map((p, i) => `${x(i)},${y(p.totals[sd.id] ?? 0)}`).join(' ')} />
          ))}
          {ends.map((sd) => (
            <g key={sd.id}>
              <circle cx={x(h.length - 1)} cy={y(sd.v)} r={4} fill={sd.color} className="sg-ring" />
              <text x={W - R + 8} y={sd.ly + 4} className="sg-label">{truncate(sd.name, W < 480 ? 7 : 10)} {sd.v}</text>
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="sg-cross" />
              {sides.map((sd) => <circle key={sd.id} cx={x(hover)} cy={y(h[hover].totals[sd.id] ?? 0)} r={4} fill={sd.color} className="sg-ring" />)}
            </g>
          )}
        </svg>
        {hp && hover !== null && (
          <div className="sg-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <b>{hp.num ? `After tossup ${hp.num}` : 'Start'}</b>
            {[...sides].sort((a, b) => (hp.totals[b.id] ?? 0) - (hp.totals[a.id] ?? 0)).map((sd) => (
              <div key={sd.id}><i style={{ background: sd.color }} />{sd.name}<span>{hp.totals[sd.id] ?? 0}</span></div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
const truncate = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
