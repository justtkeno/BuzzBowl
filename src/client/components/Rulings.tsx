import type { PublicState, Ruling } from '../../shared/types';
import { act, roles } from './util';

export function Rulings({ s }: { s: PublicState }) {
  const r = roles(s);
  const rulings = [...s.rulings].reverse();
  const openFor = (id: string) => s.protests.find((p) => p.rulingId === id);

  const protest = (ru: Ruling) => {
    const note = prompt(`Protest the ruling on “${ru.given || '(no answer)'}”. Why should it be reversed?`, '');
    if (note !== null) act('protest', ru.id, note);
  };

  return (
    <div className="rulings">
      {r.isController && s.protests.length > 0 && (
        <div className="protests">
          <h4>Open protests</h4>
          {s.protests.map((p) => {
            const ru = s.rulings.find((x) => x.id === p.rulingId);
            return (
              <div key={p.id} className="protest">
                <div><b>{p.byName}</b> protests {ru ? <>“{ru.given || '—'}” by {ru.playerName} ({ru.correct ? 'ruled correct' : 'ruled wrong'})</> : 'a ruling'}</div>
                {p.note && <div className="muted small">“{p.note}”</div>}
                <div className="row gap">
                  <button className="btn small ok" onClick={() => act('protest:resolve', p.id, true)}>Uphold (reverse)</button>
                  <button className="btn small" onClick={() => act('protest:resolve', p.id, false)}>Deny</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {rulings.length === 0 && <p className="muted small">Rulings appear here. Anyone can protest one; the {s.readerId ? 'reader' : 'host'} decides.</p>}
      {rulings.map((ru) => (
        <div key={ru.id} className={`ruling ${ru.correct ? 'ok' : 'bad'}`}>
          <div className="row between">
            <span><span className="muted small">{ru.type === 'tossup' ? `TU ${ru.num}` : `B ${ru.num}.${(ru.partIndex ?? 0) + 1}`}</span> <b>{ru.playerName}</b></span>
            <span className="pts">{ru.points > 0 ? `+${ru.points}` : ru.points}</span>
          </div>
          <div>“{ru.given || '—'}” {ru.overridden && <span className="badge">overridden</span>}</div>
          <div className="row gap">
            {!openFor(ru.id) && <button className="link" onClick={() => protest(ru)}>Protest</button>}
            {openFor(ru.id) && <span className="muted small">protest pending</span>}
            {r.isController && <button className="link" onClick={() => act('ruling:override', ru.id)}>Mark {ru.correct ? 'wrong' : 'correct'}</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
