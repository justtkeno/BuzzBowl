import { pingQuality } from '../../shared/types';
import { usePing } from '../ping';

const WORD = { good: 'good', ok: 'a little slow', bad: 'slow' } as const;

/** Three small bars, filled by connection quality. */
function Bars({ quality }: { quality: 'good' | 'ok' | 'bad' | null }) {
  const n = quality === 'good' ? 3 : quality === 'ok' ? 2 : quality === 'bad' ? 1 : 0;
  return (
    <svg className="ping-bars" viewBox="0 0 12 10" aria-hidden="true">
      {[0, 1, 2].map((i) => <rect key={i} x={i * 4.3} y={6 - i * 3} width="3" height={4 + i * 3} rx="0.8" className={i < n ? 'on' : ''} />)}
    </svg>
  );
}

/** Your ping in the room's top bar: bars and "48 ms", or "Offline". */
export function PingChip() {
  const p = usePing();
  if (!p.online) return <span className="ping-chip bad" role="status" title="Not connected to the server"><Bars quality="bad" /> Offline</span>;
  if (p.ms == null) return null;
  return (
    <span className={`ping-chip ${p.quality}`} title={`Your connection to the server: ${p.ms} ms (${WORD[p.quality!]})`} aria-label={`Ping ${p.ms} milliseconds, ${WORD[p.quality!]}`}>
      <Bars quality={p.quality} /> {p.ms}<span className="hide-xs"> ms</span>
    </span>
  );
}

/** A player's ping next to their name in Scores (measured by the server). */
export function PlayerPing({ ms }: { ms?: number }) {
  if (ms == null) return null;
  const q = pingQuality(ms);
  return <span className={`player-ping ${q}`} title={`Ping ${ms} ms (${WORD[q]})`} aria-label={`Ping ${ms} milliseconds`}><Bars quality={q} /></span>;
}
