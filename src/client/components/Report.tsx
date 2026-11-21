import { useEffect, useRef, useState } from 'react';
import type { PublicState } from '../../shared/types';
import { REPORT_NOTE_MAX, REPORT_REASON_CHIPS, REPORT_REASONS, type ReportReason } from '../../shared/reports';
import { call } from '../socket';

/**
 * A quiet "Report" link for a finished tossup, opening a small form in place. Only the tossup number goes to the
 * server; it looks the question up itself.
 */
export function ReportQuestion({ s, num }: { s: PublicState; num: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (open) form.current?.scrollIntoView({ block: 'nearest' }); }, [open]);

  if (!s.you) return null;
  if (thanks) return <span className="report-done muted small">Thanks, reported</span>;
  if (s.reported?.includes(num)) return <span className="report-done muted small">Reported</span>;
  if (!open) return <button type="button" className="link report-link" onClick={() => setOpen(true)}>Report</button>;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason) return;
    setBusy(true); setErr(null);
    try { await call('question:report', num, reason, note); setThanks(true); }
    catch (x: any) { setErr(x.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="report-form" ref={form} onSubmit={send} onClick={(e) => e.stopPropagation()}>
      <div className="small">What’s wrong with tossup {num}?</div>
      <div className="chips" role="radiogroup" aria-label="Reason">
        {(Object.keys(REPORT_REASONS) as ReportReason[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={reason === k} title={REPORT_REASONS[k]} className={`chip ${reason === k ? 'on' : ''}`} onClick={() => setReason(k)}>
            {REPORT_REASON_CHIPS[k]}
          </button>
        ))}
      </div>
      <input value={note} maxLength={REPORT_NOTE_MAX} placeholder="Note (optional)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
      <div className="row gap">
        <button className="btn small primary" disabled={busy || !reason}>Send report</button>
        <button type="button" className="btn small ghost" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
        {err && <span className="error small">{err}</span>}
      </div>
    </form>
  );
}
