import { useEffect, useRef, useState } from 'react';
import { FEEDBACK_KINDS, FEEDBACK_MAX, type FeedbackKind } from '../../shared/feedback';
import { call } from '../socket';
import { Icon } from './Icon';

/** "iPhone · Safari · app": enough to chase a bug, nothing identifying. */
function deviceInfo() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const app = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  return [os, browser, app ? 'app' : null, `${innerWidth}×${innerHeight}`].filter(Boolean).join(' · ');
}

/** A small "Send feedback" form. Messages go to the site admins' 🛡 panel. */
export function SendFeedback({ where, name, onClose }: { where: string; name?: string; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await call('feedback:send', { kind, message, where, name, device: deviceInfo() }); setSent(true); }
    catch (x: any) { setErr(x.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal feedback-modal" role="dialog" aria-label="Send feedback">
        <div className="row between">
          <h2>Send feedback</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        {sent ? (
          <>
            <p>Thanks! Your message reached the people who make Trivio.</p>
            <div className="row gap"><button className="btn primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <form onSubmit={send}>
            <p className="muted small">An idea, a bug, a question that felt off? Tell us here.</p>
            <div className="chips" role="radiogroup" aria-label="Kind">
              {FEEDBACK_KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`chip ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>{k.label}</button>
              ))}
            </div>
            <textarea ref={box} rows={5} value={message} maxLength={FEEDBACK_MAX} aria-label="Your message"
              placeholder={kind === 'bug' ? 'What happened, and what were you doing?' : kind === 'idea' ? 'What would make Trivio better?' : 'What’s on your mind?'}
              onChange={(e) => setMessage(e.target.value)} />
            <div className="row between feedback-foot">
              <span className="muted small">{message.length > FEEDBACK_MAX - 150 ? `${FEEDBACK_MAX - message.length} left` : ''}</span>
              <button className="btn primary" disabled={busy || message.trim().length < 3}>{busy ? 'Sending…' : 'Send'}</button>
            </div>
            {err && <p className="error small">{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
