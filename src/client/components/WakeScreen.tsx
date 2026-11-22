import { useEffect, useState } from 'react';
import { socket } from '../socket';
import { Logo } from './Logo';

/** Show it only if the first connection takes this long (a normal load connects well before). */
const SHOW_AFTER_MS = 2500;
/** A free server typically wakes within this long; the bar fills over it and then waits at the end. */
const TYPICAL_MS = 50_000;

/**
 * The free server sleeps when nobody's playing and takes up to a minute to wake.
 * Until the very first connection, show a calm "waking up" screen instead of a stuck page.
 */
export function WakeScreen() {
  const [waiting, setWaiting] = useState(!socket.connected);
  const [shown, setShown] = useState(false);
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!waiting) return;
    const onConnect = () => setWaiting(false);
    socket.on('connect', onConnect);
    const show = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => { socket.off('connect', onConnect); clearTimeout(show); clearInterval(tick); };
  }, [waiting]);

  if (!waiting || !shown) return null;
  const elapsed = now - start;
  // Eases toward 95% so it never looks finished before it is.
  const frac = Math.min(0.95, 1 - Math.exp(-elapsed / (TYPICAL_MS / 2.5)));
  const secs = Math.round(elapsed / 1000);
  return (
    <div className="wake" role="status" aria-live="polite">
      <div className="wake-card">
        <div className="brand"><Logo /> Trivio</div>
        <h2>Waking up the server…</h2>
        <p className="muted">Trivio’s free server naps when nobody’s playing. It usually takes 30 to 60 seconds to wake up, then everything loads on its own.</p>
        <div className="wake-bar"><div style={{ width: `${frac * 100}%` }} /></div>
        <p className="muted small">{secs}s{elapsed > 90_000 ? ' · taking longer than usual. Check your connection, or try again in a minute.' : ''}</p>
      </div>
    </div>
  );
}
