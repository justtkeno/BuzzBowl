import type { PublicState, Ruling } from '../../shared/types';
import { act, roles } from './util';
import { Info } from './Info';

/** Every answer and how it was marked. Anyone can protest one; the host or reader decides. */
export function Rulings({ s }: { s: PublicState }) {
  const r = roles(s);
  const rulings = [...s.rulings].reverse();
  const openFor = (id: string) => s.protests.find((p) => p.rulingId === id);
  const judge = s.readerId ? 'reader' : 'host';
  const where = (ru: Ruling) => (ru.type === 'tossup' ? `Tossup ${ru.num}` : `Bonus ${ru.num}, part ${(ru.partIndex ?? 0) + 1}`);
  const who = (ru: Ruling) => (ru.playerId === s.you ? 'You' : ru.playerName);

  const protest = (ru: Ruling) => {
    const note = prompt(`Ask the ${judge} to mark “${ru.given || '(no answer)'}” ${ru.correct ? 'wrong' : 'correct'}. Why? (optional)`, '');
    if (note !== null) act('protest', ru.id, note);
  };

  return (
    <div className="rulings">
      {r.isController && s.protests.length > 0 && (
        <div className="protests">
          <h4>Protests for you to decide</h4>
          {s.protests.map((p) => {
            const ru = s.rulings.find((x) => x.id === p.rulingId);
            const to = ru?.correct ? 'wrong' : 'correct';
            return (
              <div key={p.id} className="protest">
                <div>
                  <b>{p.byName}</b> thinks {ru ? <>“{ru.given || '—'}” by {ru.playerName} ({where(ru).toLowerCase()}) should be marked <b>{to}</b>.</> : 'a ruling should change.'}
                </div>
                {p.note && <div className="muted small">Their reason: “{p.note}”</div>}
                <div className="row gap">
                  <button className="btn small ok" onClick={() => act('protest:resolve', p.id, true)}>Agree: mark it {to}</button>
                  <button className="btn small" onClick={() => act('protest:resolve', p.id, false)}>Keep the ruling</button>
                </div>
                <div className="muted small">Scores update right away, and everyone sees your decision in chat.</div>
              </div>
            );
          })}
        </div>
      )}
      {rulings.length === 0 && (
        <p className="muted small">
          Every answer shows up here with how it was marked. If one looks wrong, tap Protest and the {judge} decides.<Info term="protest" />
        </p>
      )}
      {rulings.map((ru) => {
        const pending = openFor(ru.id);
        return (
          <div key={ru.id} className={`ruling ${ru.correct ? 'ok' : 'bad'}`}>
            <div className="row between">
              <span><span className="muted small">{where(ru)}</span> <b>{who(ru)}</b></span>
              <span className="pts">{ru.points > 0 ? `+${ru.points}` : ru.points}</span>
            </div>
            <div>
              “{ru.given || '—'}” <span className="muted small">· marked {ru.correct ? 'correct' : 'wrong'}</span>
              {ru.overridden && <span className="badge">changed by the {judge}</span>}
            </div>
            <div className="row gap">
              {!pending && !r.fixed && <button className="link" onClick={() => protest(ru)} title={`Ask the ${judge} to change this`}>Protest</button>}
              {pending && <span className="muted small">Protest sent. Waiting for the {judge} to decide.</span>}
              {r.isController && !r.fixed && <button className="link" onClick={() => act('ruling:override', ru.id)}>Mark {ru.correct ? 'wrong' : 'correct'}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
