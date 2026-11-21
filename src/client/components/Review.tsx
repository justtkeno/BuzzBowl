import { BuzzMap } from './Stage';
import { useState } from 'react';
import type { PublicState } from '../../shared/types';
import { resultLabel } from './util';
import { ReportQuestion } from './Report';
import { CategoryChip } from './CategoryChip';

export function Review({ s, onClose }: { s: PublicState; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(s.review[0]?.num ?? null);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Question review">
        <div className="row between"><h2>Review questions</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button></div>
        {s.review.length === 0 && <p className="muted">Finished tossups show up here with full text, answer lines and where everyone buzzed.</p>}
        {s.review.map((q) => (
          <div key={q.num} className={`review-item ${open === q.num ? 'open' : ''}`}>
            <button className="review-head" onClick={() => setOpen(open === q.num ? null : q.num)}>
              <span className="tag">TU {q.num}</span>
              <span className="grow"><CategoryChip category={q.category} sub={q.subcategory} /></span>
              <span dangerouslySetInnerHTML={{ __html: q.answerHtml.split('[')[0] }} />
            </button>
            {open === q.num && (
              <div className="review-body">
                <p className="qtext">
                  {q.words.map((w, i) => (
                    <span key={i}>
                      {q.buzzes.filter((b) => b.wordIndex === i).map((b, j) => <span key={j} className={`marker m-${b.result}`}>{b.playerName} {resultLabel[b.result]}</span>)}
                      {q.powerIndex === i && <span className="pmark">(*)</span>}
                      <span className={q.powerIndex !== null && i < q.powerIndex ? 'power' : ''}>{w}</span>{' '}
                    </span>
                  ))}
                  {q.buzzes.filter((b) => b.wordIndex >= q.words.length).map((b, j) => <span key={`e${j}`} className={`marker m-${b.result}`}>{b.playerName} {resultLabel[b.result]}</span>)}
                </p>
                <div className="answer"><span className="label">ANSWER</span> <span dangerouslySetInnerHTML={{ __html: q.answerHtml }} /></div>
                {q.buzzes.length > 0 && <BuzzMap buzzes={q.buzzes} totalWords={q.words.length} powerIndex={q.powerIndex} order={s.players.map((p) => p.id)} />}
                {q.buzzes.length > 0 && (
                  <ul className="buzz-list">
                    {q.buzzes.map((b, i) => <li key={i}>{b.playerName} at word {b.wordIndex} of {q.words.length}: “{b.given || '—'}” → {resultLabel[b.result]}</li>)}
                  </ul>
                )}
                <div className="review-foot">
                  {q.setName && <span className="muted small">{q.setName}</span>}
                  <ReportQuestion s={s} num={q.num} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
