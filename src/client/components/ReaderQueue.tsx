import { useState } from 'react';
import type { PublicState, UpcomingTossup } from '../../shared/types';
import { DIFFICULTIES } from '../../shared/types';
import { act } from './util';

/** Reader only: the next tossups in line, with the answer, so the reader can skip any before reading it. */
export function ReaderQueue({ s }: { s: PublicState }) {
  const list = s.upcoming ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const slots = 3;
  return (
    <section className="card reader-queue" aria-label="Upcoming tossups">
      <div className="row between">
        <h3>Up next</h3>
        <span className="muted small">Only you can see this. Skip any question you don’t want to read.</span>
      </div>
      <ol className="rq-list">
        {list.map((q, i) => (
          <QueueItem key={q.id} q={q} n={i + 1} open={open === q.id} onToggle={() => setOpen(open === q.id ? null : q.id)} />
        ))}
        {Array.from({ length: Math.max(0, slots - list.length) }, (_, i) => (
          <li key={`empty-${i}`} className="rq-item rq-empty muted small">{s.upcomingLoading ? 'Finding a question…' : 'No more questions match these settings.'}</li>
        ))}
      </ol>
    </section>
  );
}

function QueueItem({ q, n, open, onToggle }: { q: UpcomingTossup; n: number; open: boolean; onToggle: () => void }) {
  const meta = [q.subcategory && q.subcategory !== q.category ? `${q.category} · ${q.subcategory}` : q.category, q.difficulty ? DIFFICULTIES[q.difficulty] : null, q.setName ? `${q.setName}${q.year ? ` (${q.year})` : ''}` : null]
    .filter(Boolean).join(' · ');
  return (
    <li className={`rq-item ${open ? 'open' : ''}`}>
      <div className="rq-head">
        <span className="rq-n">{n}</span>
        <button className="rq-main" onClick={onToggle} aria-expanded={open}>
          <span className="rq-meta">{meta}</span>
          <span className="rq-answer"><span className="label">ANSWER</span> <span dangerouslySetInnerHTML={{ __html: q.answerHtml.split('[')[0] }} /></span>
        </button>
        <button className="btn ghost small" onClick={() => act('reader:skipUpcoming', q.id)} title="Replace this question with a new one">Skip</button>
      </div>
      <p className={`rq-text ${open ? '' : 'clamp'}`} onClick={onToggle}>{q.text}</p>
      {open && <div className="rq-full-answer small"><span className="label">FULL ANSWER LINE</span> <span dangerouslySetInnerHTML={{ __html: q.answerHtml }} /></div>}
    </li>
  );
}
