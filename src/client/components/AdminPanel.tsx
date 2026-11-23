import { useState } from 'react';
import type { PublicState } from '../../shared/types';
import { useAccount } from '../account';
import { act, toast, useNow } from './util';
import { Icon } from './Icon';

// The parts of the admin panel that act on the room you're in. They live in tabs of SiteAdminPanel.

/** "This room" tab: who holds the host and reader seats, and moving them, at any point in a match. */
export function RoomAdmin({ s, onPlayers }: { s: PublicState; onPlayers?: () => void }) {
  const now = useNow(!!s.heldReader, 1000);
  const people = s.players.filter((p) => !p.bot);
  const reader = s.players.find((p) => p.id === s.readerId);
  const held = s.heldReader;
  const heldLeft = held ? Math.max(0, Math.ceil((held.until - now) / 1000)) : 0;

  return (
    <>
      <p className="muted small">Room <b className="mono">{s.code}</b>. Seat changes and renames show a note in chat.</p>
      <div className="admin-seats">
        <div>
          <span className="muted small">Host</span>
          <b>{s.players.find((p) => p.id === s.hostId)?.name ?? '—'}</b>
          {s.hostId !== s.you && <button className="btn small" onClick={() => act('admin:host', s.you)}>Make me host</button>}
        </div>
        <div>
          <span className="muted small">Reader</span>
          <b>{reader ? reader.name : held ? `${held.name} (reconnecting, ${Math.floor(heldLeft / 60)}:${String(heldLeft % 60).padStart(2, '0')} left)` : 'None (the app reads)'}</b>
          <div className="row gap">
            {s.readerId !== s.you && <button className="btn small primary" onClick={() => act('admin:reader', s.you)}>Make me reader</button>}
            {reader && <button className="btn small ghost" onClick={() => act('admin:reader', null)}>Free the seat</button>}
          </div>
        </div>
      </div>

      <div className="row between">
        <h3>People in this room</h3>
        {onPlayers && !s.daily && !s.survival && <button className="btn small ghost" onClick={onPlayers}>Kick, ban, mute →</button>}
      </div>
      <ul className="admin-list">
        {people.map((p) => (
          <li key={p.id} className={p.online ? '' : 'offline'}>
            <div className="admin-list-name">
              {p.name}
              {p.username && <span className="muted small"> @{p.username}</span>}
              {p.id === s.you && <span className="badge">you</span>}
              {p.id === s.hostId && <span className="badge">host</span>}
              {p.id === s.readerId && <span className="badge reader">reader</span>}
              {!p.online && <span className="badge">offline</span>}
            </div>
            <div className="row gap admin-list-actions">
              {p.id !== s.hostId && <button className="btn small" onClick={() => act('admin:host', p.id)} disabled={!p.online}>Make host</button>}
              {p.id !== s.readerId && <button className="btn small" onClick={() => act('admin:reader', p.id)} disabled={!p.online}>Make reader</button>}
              {p.id !== s.you && <button className="btn small" onClick={() => { const n = prompt(`New name for ${p.name}:`, p.name); if (n?.trim()) act('admin:rename', p.id, n); }}>Rename</button>}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">If a host or reader loses connection, their seat is held for 3 minutes and comes back when they reconnect.</p>
    </>
  );
}

type Buzzer = 'on' | 'slow' | 'tossup' | 'always';

/** The room half of the Troll tab: peek, messages, shakes, and messing with someone's buzzer. All secret. */
export function RoomTroll({ s }: { s: PublicState }) {
  const [shout, setShout] = useState('');
  const fixed = !!s.daily || !!s.survival;
  const people = s.players.filter((p) => !p.bot && p.id !== s.you);
  const live = !!s.tossup && s.phase === 'reading';

  const setBuzzer = (id: string, v: Buzzer) => {
    act('admin:freeze', id, v === 'tossup' || v === 'always' ? v : 'off');
    act('admin:slow', id, v === 'slow');
  };
  const whisper = (id: string, name: string) => {
    const t = prompt(`Whisper to ${name} (only they see it):`);
    if (t?.trim()) act('admin:whisper', id, t);
  };

  return (
    <>
      <h3>In this room</h3>
      <label className="check">
        <input type="checkbox" checked={!!s.admin?.peek} onChange={(e) => act('admin:peek', e.target.checked)} />
        <span><b>Peek at answers</b> <span className="muted small">The answer shows under the question while it’s read. Nobody else can tell.</span></span>
      </label>
      {fixed ? (
        <p className="muted small">The other tricks are off in the daily challenge and survival, which have to stay fair.</p>
      ) : (
        <>
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (shout.trim()) { act('admin:announce', shout); setShout(''); } }}>
            <input className="grow" value={shout} maxLength={140} placeholder="Big message on everyone’s screen in this room…" aria-label="Message this room" onChange={(e) => setShout(e.target.value)} />
            <button className="btn" disabled={!shout.trim()}>Send</button>
          </form>
          <div className="row gap">
            <button className="btn small" onClick={() => act('admin:shake', null)}>Shake everyone’s screen</button>
          </div>

          <h3>Mess with someone</h3>
          {!people.length && <p className="muted small">Nobody else is here.</p>}
          <ul className="admin-list">
            {people.map((p) => (
              <li key={p.id} className={p.online ? '' : 'offline'}>
                <div className="admin-list-name">
                  {p.name}
                  {buzzerOf(s, p.id) !== 'on' && <span className="badge">{buzzerOf(s, p.id) === 'slow' ? '🐢 slowed' : '🧊 frozen'}</span>}
                  {!p.online && <span className="badge">offline</span>}
                </div>
                <div className="row gap admin-list-actions">
                  <select aria-label={`${p.name}'s buzzer`} value={buzzerOf(s, p.id)} onChange={(e) => setBuzzer(p.id, e.target.value as Buzzer)}>
                    <option value="on">Buzzer normal</option>
                    <option value="slow">🐢 Slow (loses close buzzes)</option>
                    <option value="tossup">🧊 Freeze 1 tossup</option>
                    <option value="always">🧊 Freeze until I stop</option>
                  </select>
                  <button className="btn small" disabled={!p.online} onClick={() => whisper(p.id, p.name)}>Whisper</button>
                  <button className="btn small" disabled={!p.online} onClick={() => act('admin:shake', p.id)}>Shake</button>
                  <button className="btn small" disabled={!p.online || !live} title={live ? 'Buzz them in now: they have to answer' : 'Works while a question is being read'}
                    onClick={() => act('admin:forceBuzz', p.id)}>Force buzz</button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted small">Slowed buzzes count two words late. Frozen buzzes do nothing. Nobody is told about either.</p>
        </>
      )}
    </>
  );
}

function buzzerOf(s: PublicState, id: string): Buzzer {
  const f = s.admin?.frozen.find((x) => x.id === id);
  if (f) return f.always ? 'always' : 'tossup';
  return s.admin?.slowed?.includes(id) ? 'slow' : 'on';
}

/** Whether admin is pinned to this account (ADMIN_ACCOUNT_IDS), and how to pin it if not. */
export function AdminLock() {
  const { me } = useAccount();
  const [showId, setShowId] = useState(false);
  if (!me) return null;
  return (
    <div className={`admin-lock ${me.adminLocked ? 'locked' : 'unlocked'}`}>
      {me.adminLocked ? (
        <p><Icon name="lock" /> <b>Admin is locked to your account.</b> Only the account IDs set on this server have these powers.</p>
      ) : (
        <>
          <p><Icon name="shield" /> <b>Admin isn’t locked yet.</b> This server gives admin to whoever holds the username <b>@{me.username}</b>. If its accounts are ever wiped, the next person to sign up with that name would get these powers.</p>
          <p className="small">To lock it to this exact account, set this on the server (for example in Render’s Environment settings), then restart it:</p>
          {showId ? (
            <div className="row gap">
              <code className="admin-id">ADMIN_ACCOUNT_IDS={me.id}</code>
              <button className="btn small" onClick={() => navigator.clipboard?.writeText(`ADMIN_ACCOUNT_IDS=${me.id}`).then(() => toast('Copied'), () => toast('Copy failed'))}>Copy</button>
            </div>
          ) : (
            <button className="btn small" onClick={() => setShowId(true)}>Show my account ID</button>
          )}
        </>
      )}
    </div>
  );
}
