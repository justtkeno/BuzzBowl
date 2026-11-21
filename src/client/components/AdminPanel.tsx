import { useEffect, useState } from 'react';
import type { PublicState } from '../../shared/types';
import { useAccount } from '../account';
import { act, toast, useNow } from './util';

/**
 * Site-admin controls for the current room. Shown only to an admin who is logged in.
 * Works at any point in a match, unlike the normal lobby-only seat changes.
 */
export function AdminPanel({ s, onClose, onPlayers }: { s: PublicState; onClose: () => void; onPlayers?: () => void }) {
  const now = useNow(!!s.heldReader, 1000);
  const { me } = useAccount();
  const [showId, setShowId] = useState(false);
  const [shout, setShout] = useState('');
  const [everyone, setEveryone] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const people = s.players.filter((p) => !p.bot);
  const reader = s.players.find((p) => p.id === s.readerId);
  const held = s.heldReader;
  const heldLeft = held ? Math.max(0, Math.ceil((held.until - now) / 1000)) : 0;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal admin-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Admin controls">
        <div className="row between">
          <h2>🛡 Admin</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">Only you see this panel. Seat changes and renames show a note in chat. Peeking and freezing are secret.</p>

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

        <h3>Troll tools</h3>
        <div className="troll">
          <label className="check">
            <input type="checkbox" checked={!!s.admin?.peek} onChange={(e) => act('admin:peek', e.target.checked)} />
            <span><b>Peek at answers</b> <span className="muted small">The answer shows under the question while it’s read. Nobody else can tell.</span></span>
          </label>
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (shout.trim()) { act(everyone ? 'site:announce' : 'admin:announce', shout); setShout(''); } }}>
            <input className="grow" value={shout} maxLength={140} placeholder={everyone ? 'Big message on every screen on Trivio…' : 'Big message on everyone’s screen…'} aria-label="Announcement" onChange={(e) => setShout(e.target.value)} />
            <button className="btn" disabled={!shout.trim()}>Announce</button>
          </form>
          <label className="check">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            <span>Send to <b>everyone on Trivio</b>, not just this room <span className="muted small">(skips anyone mid-daily-challenge)</span></span>
          </label>
        </div>

        <div className="row between">
          <h3>People in this room</h3>
          {onPlayers && !s.daily && !s.survival && <button className="btn small ghost" onClick={onPlayers}>Kick, ban, mute →</button>}
        </div>
        <table className="admin-people">
          <tbody>
            {people.map((p) => (
              <tr key={p.id} className={p.online ? '' : 'offline'}>
                <td>
                  {p.name}
                  {p.id === s.you && <span className="badge">you</span>}
                  {p.id === s.hostId && <span className="badge">host</span>}
                  {p.id === s.readerId && <span className="badge reader">reader</span>}
                  {!p.online && <span className="badge">offline</span>}
                  {frozenMode(s, p.id) !== 'off' && <span className="badge">🧊 frozen</span>}
                </td>
                <td className="admin-actions">
                  {p.id !== s.hostId && <button className="btn small" onClick={() => act('admin:host', p.id)} disabled={!p.online}>Make host</button>}
                  {p.id !== s.readerId && <button className="btn small" onClick={() => act('admin:reader', p.id)} disabled={!p.online}>Make reader</button>}
                  {p.id !== s.you && (
                    <>
                      <button className="btn small" onClick={() => { const n = prompt(`New name for ${p.name}:`, p.name); if (n?.trim()) act('admin:rename', p.id, n); }}>Rename</button>
                      <select aria-label={`${p.name}'s buzzer`} value={frozenMode(s, p.id)} onChange={(e) => act('admin:freeze', p.id, e.target.value)}>
                        <option value="off">Buzzer on</option>
                        <option value="tossup">🧊 Freeze 1 tossup</option>
                        <option value="always">🧊 Freeze until I stop</option>
                      </select>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">If a host or reader loses connection, their seat is held for 3 minutes and comes back when they reconnect.</p>

        {me && (
          <div className={`admin-lock ${me.adminLocked ? 'locked' : 'unlocked'}`}>
            {me.adminLocked ? (
              <p>🔒 <b>Admin is locked to your account.</b> Only the account IDs set on this server have these powers.</p>
            ) : (
              <>
                <p>⚠️ <b>Admin isn’t locked yet.</b> This server gives admin to whoever holds the username <b>@{me.username}</b>. If its accounts are ever wiped, the next person to sign up with that name would get these powers.</p>
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
        )}
      </div>
    </div>
  );
}

function frozenMode(s: PublicState, id: string): 'off' | 'tossup' | 'always' {
  const f = s.admin?.frozen.find((x) => x.id === id);
  return !f ? 'off' : f.always ? 'always' : 'tossup';
}
