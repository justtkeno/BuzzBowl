import type { PublicState } from '../shared/types';
import { isTouch, toast } from './components/util';

// A tidy image of a finished game (podium + your line) to send or save. Drawn on a canvas, nothing uploaded.

const W = 1080;
const H = 1350;
const C = {
  bg: '#f6f5f2', card: '#ffffff', text: '#1d1c1a', muted: '#6b6760', border: '#dedad2',
  accent: '#d9480f', accentSoft: '#fde8dc', power: '#7048e8', ok: '#2b8a3e', bad: '#c92a2a', step: '#efede8',
};
const FONT = `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

interface Side { name: string; points: number; you: boolean }

function sidesOf(s: PublicState): Side[] {
  const sides = s.settings.mode === 'teams'
    ? s.teams.map((t) => ({ name: t.name, points: t.points, you: t.playerIds.includes(s.you ?? '') }))
    : s.players.filter((p) => p.id !== s.readerId && (p.stats.heard || p.stats.buzzes)).map((p) => ({ name: p.name, points: p.stats.points, you: p.id === s.you }));
  return sides.sort((a, b) => b.points - a.points);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawRecap(s: PublicState): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  roundRect(g, 60, 60, W - 120, H - 120, 40); g.fillStyle = C.card; g.fill();
  g.strokeStyle = C.border; g.lineWidth = 3; g.stroke();

  // Header
  g.textBaseline = 'alphabetic';
  roundRect(g, 120, 120, 84, 84, 20); g.fillStyle = C.accent; g.fill();
  g.fillStyle = '#fff'; g.font = `700 60px ${FONT}`; g.textAlign = 'center'; g.fillText('*', 162, 188);
  g.textAlign = 'left'; g.fillStyle = C.text; g.font = `700 64px ${FONT}`; g.fillText('Trivio', 228, 184);
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  g.fillStyle = C.muted; g.font = `400 34px ${FONT}`;
  const heard = Math.max(s.tossupsRead, s.review.length);
  g.fillText(`${s.settings.mode === 'teams' ? 'Teams' : 'Free-for-all'} · ${heard} tossup${heard === 1 ? '' : 's'} · ${date}`, 120, 270);

  // Podium
  const sides = sidesOf(s);
  const ranked = sides.map((x) => ({ ...x, rank: sides.findIndex((y) => y.points === x.points) + 1 })).filter((x) => x.rank <= 3).slice(0, 3);
  const order = ranked.length >= 3 ? [ranked[1], ranked[0], ranked[2]] : ranked.length === 2 ? [ranked[1], ranked[0]] : ranked;
  const heights: Record<number, number> = { 1: 230, 2: 165, 3: 120 };
  const colW = 250, gap = 30;
  const startX = (W - (order.length * colW + (order.length - 1) * gap)) / 2;
  const base = 800;
  order.forEach((x, i) => {
    const cx = startX + i * (colW + gap);
    const h = heights[x.rank];
    roundRect(g, cx, base - h, colW, h, 22);
    g.fillStyle = x.rank === 1 ? C.accentSoft : C.step; g.fill();
    g.textAlign = 'center';
    g.fillStyle = x.rank === 1 ? C.accent : C.muted; g.font = `700 64px ${FONT}`; g.fillText(String(x.rank), cx + colW / 2, base - h / 2 + 22);
    g.fillStyle = x.you ? C.accent : C.text; g.font = `600 38px ${FONT}`;
    g.fillText(fit(g, x.name, colW - 10), cx + colW / 2, base - h - 70);
    g.fillStyle = C.muted; g.font = `400 34px ${FONT}`; g.fillText(`${x.points} pts`, cx + colW / 2, base - h - 24);
  });
  if (!order.length) { g.textAlign = 'center'; g.fillStyle = C.muted; g.font = `400 36px ${FONT}`; g.fillText('Solo practice', W / 2, 640); }

  // Your line
  const me = s.players.find((p) => p.id === s.you);
  g.textAlign = 'left';
  if (me && (me.stats.heard || me.stats.buzzes)) {
    const rank = s.settings.mode === 'teams'
      ? sides.findIndex((x) => x.you) + 1
      : sides.findIndex((x) => x.points === me.stats.points) + 1;
    roundRect(g, 120, 870, W - 240, 300, 28); g.fillStyle = C.step; g.fill();
    g.fillStyle = C.muted; g.font = `600 30px ${FONT}`; g.fillText(fit(g, me.name.toUpperCase(), W - 320), 160, 925);
    g.fillStyle = C.text; g.font = `700 96px ${FONT}`; g.fillText(String(me.stats.points), 160, 1030);
    const ptsW = g.measureText(String(me.stats.points)).width;
    g.fillStyle = C.muted; g.font = `400 40px ${FONT}`;
    g.fillText(`pts${sides.length > 1 && rank > 0 ? ` · ${rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `${rank}th`} of ${sides.length}` : ''}`, 180 + ptsW, 1030);
    const stats: [string, string, string][] = [
      [String(me.stats.powers), 'powers', C.power], [String(me.stats.tens), 'tens', C.ok], [String(me.stats.negs), 'negs', C.bad],
      [me.stats.avgCorrectDepth != null ? `${Math.round(me.stats.avgCorrectDepth * 100)}%` : '–', 'buzz depth', C.text],
    ];
    stats.forEach(([v, label, color], i) => {
      const x = 160 + i * 205;
      g.fillStyle = color; g.font = `700 50px ${FONT}`; g.fillText(v, x, 1115);
      g.fillStyle = C.muted; g.font = `400 28px ${FONT}`; g.fillText(label, x, 1150);
    });
  }

  g.textAlign = 'center'; g.fillStyle = C.muted; g.font = `400 30px ${FONT}`;
  g.fillText(location.host, W / 2, H - 100);
  return canvas;
}

/** Share the recap image (phones), or download it. */
export async function shareRecap(s: PublicState) {
  const canvas = drawRecap(s);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return toast('Could not make the image.');
  const file = new File([blob], 'trivio-game.png', { type: 'image/png' });
  if (isTouch() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: 'My Trivio game' }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'trivio-game.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Recap image saved.');
}
