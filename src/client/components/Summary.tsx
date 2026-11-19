import { useState } from 'react';
import type { PublicState } from '../../shared/types';
import { ScoreGraph } from './ScoreGraph';
import { act, fmtPct, roles } from './util';

export function Summary({ s }: { s: PublicState }) {
  const r = roles(s);
  const players = s.players.filter((p) => p.id !== s.readerId && (p.stats.heard || p.stats.buzzes)).sort((a, b) => b.stats.points - a.stats.points);
  const [focus, setFocus] = useState(players.find((p) => p.id === r.me)?.id ?? players[0]?.id);
  const fp = players.find((p) => p.id === focus);

  return (
    <div className="card summary">
      <h2>Game summary</h2>
      <p className="muted">{s.tossupsRead} tossup{s.tossupsRead === 1 ? "" : "s"} heard.</p>

      {s.highlights.length > 0 && (
        <div className="highlights">
          {s.highlights.map((h, i) => (
            <div key={h.title} className="hl" style={{ animationDelay: `${i * 90}ms` }}>
              <span className="hl-icon">{h.icon}</span>
              <span className="hl-title">{h.title}</span>
              <b className="hl-name">{h.name}</b>
              <span className="hl-detail">{h.detail}</span>
            </div>
          ))}
        </div>
      )}

      <ScoreGraph s={s} />

      {s.settings.mode === 'teams' && (
        <table className="stats">
          <thead><tr><th>Team</th><th className="num">Points</th><th className="num">Bonuses</th><th className="num">PPB</th></tr></thead>
          <tbody>
            {[...s.teams].sort((a, b) => b.points - a.points).map((t) => (
              <tr key={t.id}><td>{t.name}</td><td className="num">{t.points}</td><td className="num">{t.bonusesHeard}</td><td className="num">{t.bonusesHeard ? (t.bonusPoints / t.bonusesHeard).toFixed(2) : '—'}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      <table className="stats">
        <thead>
          <tr><th>Player</th><th className="num">Pts</th><th className="num">15</th><th className="num">10</th><th className="num">−5</th><th className="num">Heard</th><th className="num" title="Points per tossup heard">PPTH</th><th className="num" title="Average share of the question read before correct buzzes (lower = earlier)">Buzz depth</th></tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id} className={p.id === focus ? 'sel' : ''} onClick={() => setFocus(p.id)}>
              <td>{p.name}</td>
              <td className="num">{p.stats.points}</td>
              <td className="num">{p.stats.powers}</td>
              <td className="num">{p.stats.tens}</td>
              <td className="num">{p.stats.negs}</td>
              <td className="num">{p.stats.heard}</td>
              <td className="num">{p.stats.heard ? (p.stats.points / p.stats.heard).toFixed(2) : '—'}</td>
              <td className="num">{fmtPct(p.stats.avgCorrectDepth)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {fp && (
        <>
          <h3>Categories — {fp.name}</h3>
          <table className="stats">
            <thead><tr><th>Category</th><th className="num">Heard</th><th className="num">15</th><th className="num">10</th><th className="num">−5</th><th className="num">Pts</th><th className="num">Conversion</th></tr></thead>
            <tbody>
              {Object.entries(fp.stats.categories).sort((a, b) => b[1].heard - a[1].heard).map(([c, st]) => (
                <tr key={c}>
                  <td>{c}</td><td className="num">{st.heard}</td><td className="num">{st.powers}</td><td className="num">{st.tens}</td><td className="num">{st.negs}</td><td className="num">{st.points}</td>
                  <td className="num">{st.heard ? fmtPct((st.powers + st.tens) / st.heard) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Click a player above to see their breakdown.</p>
        </>
      )}

      {r.isController && <button className="btn primary big" onClick={() => act('game:start')}>New game</button>}
    </div>
  );
}
