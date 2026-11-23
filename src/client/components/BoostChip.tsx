import { useEffect, useState } from 'react';
import { fmtMultiplier } from '../../shared/levels';
import { useXpBoost } from '../account';

const left = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
};

/** A small "2× XP · 41 min left" chip while an XP boost is on this player. Nothing otherwise. */
export function BoostChip({ className = '' }: { className?: string }) {
  const b = useXpBoost();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!b) return;
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [b]);
  const now = Date.now();
  if (!b || b.endsAt <= now) return null;
  return (
    <span className={`boost-chip ${className}`} title={b.personal ? 'An XP boost just for you' : 'An XP boost for everyone'}>
      <b>{fmtMultiplier(b.multiplier)} XP</b>{b.personal ? ' for you' : ''} · {left(b.endsAt - now)} left
    </span>
  );
}
