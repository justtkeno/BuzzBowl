import { useEffect, useState } from 'react';
import type { StatsDay, StatsView } from '../../shared/stats';
import { call } from '../socket';

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Owner stats in the site admin panel: headline numbers, two 14-day bar charts, popular modes. */
export function AdminStats({ openReports, openFeedback }: { openReports: number | null; openFeedback: number | null }) {
  const [v, setV] = useState<StatsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call<{ stats: StatsView }>('site:stats').then((r) => setV(r.stats), (e) => setErr(e.message)); }, []);

  if (err) return <p className="error small">{err}</p>;
  if (!v) return <p className="muted small">Loading stats…</p>;
  const maxMode = Math.max(1, ...v.modes.map((m) => m.games));
  return (
    <div className="admin-stats">
      <div className="stat-tiles">
        <Tile value={v.today.visitors} label="visitors today" sub={`${v.today.games} game${v.today.games === 1 ? '' : 's'}`} />
        <Tile value={v.last7.visitors} label="visitors, 7 days" sub={`${v.last7.games} games`} />
        <Tile value={v.last30.visitors} label="visitors, 30 days" sub={`${v.last30.games} games`} />
        <Tile value={v.last30.avgPlayers} label="players per game" sub="last 30 days" />
      </div>

      <DayBars title="Visitors per day" days={v.days} pick={(d) => d.visitors} unit="visitor" />
      <DayBars title="Games per day" days={v.days} pick={(d) => d.games} unit="game" />

      <h4>Popular modes <small className="muted">(last 30 days)</small></h4>
      {v.modes.length ? (
        <ul className="mode-bars">
          {v.modes.map((m) => (
            <li key={m.label}>
              <span className="mb-label">{m.label}</span>
              <span className="mb-track"><span className="mb-fill" style={{ width: `${(m.games / maxMode) * 100}%` }} /></span>
              <b>{m.games}</b>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No games in the last 30 days yet.</p>}

      <p className="muted small stats-foot">
        {v.last30.finished} finished, {v.last30.abandoned} left early · {v.last30.withBots} with bots
        {openReports != null ? ` · ${openReports} open question report${openReports === 1 ? '' : 's'} below` : ''}
        {openFeedback != null ? ` · ${openFeedback} new feedback` : ''}
        {v.allTime.since ? ` · ${v.allTime.games} games since ${fmtDay(v.allTime.since)}` : ''}.
        {' '}Visitors are devices that opened Trivio that day, counted anonymously.
      </p>
    </div>
  );
}

function Tile({ value, label, sub }: { value: number; label: string; sub: string }) {
  return (
    <div className="stat-tile">
      <b>{value}</b>
      <span>{label}</span>
      <small>{sub}</small>
    </div>
  );
}

/** One measure over the last 14 days: thin bars in one color, a hover tip per day, today labeled. */
function DayBars({ title, days, pick, unit }: { title: string; days: StatsDay[]; pick: (d: StatsDay) => number; unit: string }) {
  const max = Math.max(1, ...days.map(pick));
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? days.length - 1;
  const n = pick(days[shown]);
  return (
    <figure className="day-bars">
      <figcaption>
        <span>{title}</span>
        <span className="muted small" aria-live="polite">{fmtDay(days[shown].day)}{hover === null ? ' (today)' : ''}: <b>{n}</b> {unit}{n === 1 ? '' : 's'}</span>
      </figcaption>
      <div className="db-plot" role="img" aria-label={`${title}: ${days.map((d) => `${fmtDay(d.day)} ${pick(d)}`).join(', ')}`} onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <span key={d.day} className={`db-col ${i === shown ? 'on' : ''}`} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} title={`${fmtDay(d.day)}: ${pick(d)}`}>
            <span className="db-bar" style={{ height: `${(pick(d) / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="db-axis"><span>{fmtDay(days[0].day)}</span><span>max {max}</span><span>today</span></div>
    </figure>
  );
}
