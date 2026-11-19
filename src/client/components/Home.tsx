import { useState } from 'react';
import { randomName } from '../names';
import { prefs } from '../socket';

interface Props {
  initialCode: string | null;
  error: string | null;
  connected: boolean;
  onJoin: (code: string, name: string) => Promise<void>;
  onCreate: (name: string, solo: boolean) => Promise<void>;
}

export function Home({ initialCode, error, connected, onJoin, onCreate }: Props) {
  const [name, setName] = useState(() => prefs.name() || randomName());
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (!name.trim()) return setErr('Pick a display name first.');
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="home">
      <div className="home-card">
        <div className="brand"><span className="logo">QB</span> BuzzBowl</div>
        <p className="muted">Pyramidal tossups, real buzzer races, powers, negs and bonuses. Play in real time with friends or drill alone.</p>

        <label className="field">
          <span>Display name</span>
          <div className="row gap">
            <input className="grow" autoFocus value={name} maxLength={24} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" title="Pick a random name" aria-label="Pick a random name" onClick={() => setName(randomName())}>🎲</button>
          </div>
        </label>

        {initialCode ? (
          <button className="btn primary big" disabled={busy || !connected} onClick={() => run(() => onJoin(initialCode, name.trim()))}>
            Join room {initialCode}
          </button>
        ) : (
          <>
            <div className="row gap">
              <button className="btn primary big grow" disabled={busy || !connected} onClick={() => run(() => onCreate(name.trim(), false))}>Create room</button>
              <button className="btn big grow" disabled={busy || !connected} onClick={() => run(() => onCreate(name.trim(), true))}>Solo practice</button>
            </div>
            <div className="divider"><span>or join with a code</span></div>
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); run(() => onJoin(code.trim().toUpperCase(), name.trim())); }}>
              <input className="grow code-input" value={code} maxLength={8} placeholder="ABCD" onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <button className="btn" disabled={busy || !connected || code.trim().length < 4}>Join</button>
            </form>
          </>
        )}
        {!connected && <p className="warn">Connecting to server…</p>}
        {(err || error) && <p className="error">{err || error}</p>}
        <p className="muted small">Questions come from <a href="https://www.qbreader.org" target="_blank" rel="noreferrer">QBReader</a>, a built-in sample packet, or a packet you upload.</p>
      </div>
    </div>
  );
}
