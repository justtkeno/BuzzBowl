import { useState } from 'react';
import { MAX_LEVEL, xpAtLevel } from '../../shared/levels';
import { adminSetXp } from '../account';

type Run = (fn: () => Promise<string | void>) => Promise<void>;

/**
 * Admin level tools for one account (yours too): add or take away XP, jump to a level, max it out,
 * or go back to the XP their saved games are worth. Calls `onLevel` with the new level and XP.
 */
export function AdminXp({ username, mine, run, busy, onChange }: {
  username: string; mine?: boolean; run: Run; busy: boolean; onChange?: (xp: number, level: number) => void;
}) {
  const who = mine ? 'You’re' : `@${username} is`;
  const done = (r: { levelInfo: { xp: number; level: number } }) => {
    onChange?.(r.levelInfo.xp, r.levelInfo.level);
    return `${who} now level ${r.levelInfo.level} (${r.levelInfo.xp.toLocaleString()} XP).`;
  };
  const amount = (verb: string) => {
    const raw = prompt(`How much XP to ${verb}${mine ? '' : ` @${username}`}?\n(A game is usually 60–110 XP; level ${MAX_LEVEL} takes ${xpAtLevel(MAX_LEVEL).toLocaleString()} XP in total.)`);
    const n = Math.trunc(Number(String(raw ?? '').replace(/[,\s]/g, '')));
    return raw && Number.isFinite(n) && n > 0 ? n : null;
  };
  const add = (sign: 1 | -1) => {
    const n = amount(sign > 0 ? 'give' : 'take away from');
    if (n) void run(async () => done(await adminSetXp(username, { add: sign * n })));
  };
  const setLevel = () => {
    const raw = prompt(`Set ${mine ? 'your' : `@${username}’s`} level (1–${MAX_LEVEL}):`);
    const level = Math.trunc(Number(raw));
    if (raw && level >= 1 && level <= MAX_LEVEL) void run(async () => done(await adminSetXp(username, { level })));
  };
  const max = () => void run(async () => done(await adminSetXp(username, { level: MAX_LEVEL })));
  const earned = () => {
    if (!confirm(`Put ${mine ? 'your' : `@${username}’s`} XP back to what ${mine ? 'your' : 'their'} saved games are worth?`)) return;
    void run(async () => done(await adminSetXp(username, { earned: true })));
  };
  return (
    <>
      <button type="button" className="btn small" disabled={busy} onClick={() => add(1)}>+ XP</button>
      <button type="button" className="btn small" disabled={busy} onClick={() => add(-1)}>− XP</button>
      <button type="button" className="btn small" disabled={busy} onClick={setLevel}>Set level</button>
      <button type="button" className="btn small" disabled={busy} onClick={max}>Max level</button>
      <button type="button" className="btn small ghost" disabled={busy} onClick={earned}>Back to earned XP</button>
    </>
  );
}

/** "My level": type a level and set it, for the admin's own account. Plus the same quick buttons. */
export function MyLevel({ username, level, run, busy }: { username: string; level?: number; run: Run; busy: boolean }) {
  const [want, setWant] = useState(String(level ?? 1));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Math.trunc(Number(want));
    if (!(n >= 1 && n <= MAX_LEVEL)) return;
    void run(async () => {
      const r = await adminSetXp(username, { level: n });
      return `You’re now level ${r.levelInfo.level} (${r.levelInfo.xp.toLocaleString()} XP).`;
    });
  };
  return (
    <>
      <form className="row gap my-level" onSubmit={submit}>
        <label className="muted small" htmlFor="my-level">Level</label>
        <input id="my-level" type="number" inputMode="numeric" min={1} max={MAX_LEVEL} value={want} onChange={(e) => setWant(e.target.value)} />
        <button className="btn small primary" disabled={busy || !(Number(want) >= 1 && Number(want) <= MAX_LEVEL)}>Set my level</button>
      </form>
      <div className="row gap"><AdminXp username={username} mine run={run} busy={busy} /></div>
    </>
  );
}
