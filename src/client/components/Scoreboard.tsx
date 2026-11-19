import type { PublicPlayer, PublicState } from '../../shared/types';
import { act, roles } from './util';

export function Scoreboard({ s }: { s: PublicState }) {
  const r = roles(s);
  const players = s.players.filter((p) => p.id !== s.readerId);
  const reader = s.players.find((p) => p.id === s.readerId);

  const Row = ({ p, captain }: { p: PublicPlayer; captain?: boolean }) => (
    <tr className={`${p.online ? '' : 'offline'} ${p.id === r.me ? 'me' : ''}`}>
      <td className="name">
        {p.name}
        {p.id === s.hostId && <span className="badge">host</span>}
        {captain && <span className="badge">capt</span>}
      </td>
      <td className="num" title="powers / tens / negs">{p.stats.powers}/{p.stats.tens}/{p.stats.negs}</td>
      <td className="num pts">{p.stats.points}</td>
      {r.isController && (
        <td className="adj">
          <button className="mini" title="−5" onClick={() => act('score:adjust', p.id, -5)}>−</button>
          <button className="mini" title="+5" onClick={() => act('score:adjust', p.id, 5)}>+</button>
        </td>
      )}
    </tr>
  );

  return (
    <div className="scoreboard">
      {reader && <div className="reader-line">🎙 Reader: <b>{reader.name}</b>{!reader.online && ' (offline)'}</div>}
      {s.settings.mode === 'teams' ? (
        [...s.teams].sort((a, b) => b.points - a.points).map((t) => (
          <div key={t.id} className={`team-block ${r.myTeam === t.id ? 'mine' : ''}`}>
            <div className="team-head">
              <b>{t.name}</b>
              <span className="muted small">{t.bonusesHeard ? `${(t.bonusPoints / t.bonusesHeard).toFixed(1)} PPB` : ''}</span>
              <span className="team-pts">{t.points}</span>
            </div>
            <table><tbody>
              {t.playerIds.map((id) => players.find((p) => p.id === id)).filter(Boolean).map((p) => <Row key={p!.id} p={p!} captain={t.captainId === p!.id} />)}
            </tbody></table>
          </div>
        ))
      ) : (
        <table className="ffa">
          <thead><tr><th>Player</th><th className="num">P/10/N</th><th className="num">Pts</th>{r.isController && <th />}</tr></thead>
          <tbody>{[...players].sort((a, b) => b.stats.points - a.stats.points).map((p) => <Row key={p.id} p={p} />)}</tbody>
        </table>
      )}
      {s.settings.mode === 'teams' && players.some((p) => !p.teamId) && (
        <p className="muted small">Spectating: {players.filter((p) => !p.teamId).map((p) => p.name).join(', ')}</p>
      )}
      <p className="muted small">{s.tossupsRead} tossup{s.tossupsRead === 1 ? '' : 's'} heard</p>
    </div>
  );
}
