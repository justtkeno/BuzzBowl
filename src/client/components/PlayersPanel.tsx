import { useEffect } from 'react';
import type { PublicState } from '../../shared/types';
import { act } from './util';
import { Icon } from './Icon';

/** Host / reader (and the site admin in any room): kick, ban, mute, and give a buzz back. */
export function PlayersPanel({ s, onClose }: { s: PublicState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const iAmAdmin = !!s.players.find((p) => p.id === s.you)?.admin;
  const people = s.players.filter((p) => !p.bot && p.id !== s.you);
  const live = !!s.tossup && (s.phase === 'reading' || s.phase === 'buzz');

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal admin-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Manage players">
        <div className="row between">
          <h2>Players</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <p className="muted small">Everyone sees a note in chat when you mute, kick or ban someone. A ban keeps their seat and account out of this room.</p>

        {people.length === 0 && <p className="muted">Nobody else is here yet.</p>}
        <table className="admin-people">
          <tbody>
            {people.map((p) => {
              const protectedSeat = p.admin && !iAmAdmin;
              const lockedOut = live && !!p.teamId && s.tossup!.lockedTeamIds.includes(p.teamId);
              return (
                <tr key={p.id} className={p.online ? '' : 'offline'}>
                  <td>
                    {p.name}
                    {p.id === s.hostId && <span className="badge">host</span>}
                    {p.id === s.readerId && <span className="badge reader">reader</span>}
                    {p.muted && <span className="badge">muted</span>}
                    {!p.online && <span className="badge">offline</span>}
                  </td>
                  <td className="admin-actions">
                    {protectedSeat ? <span className="muted small">Trivio creator</span> : (
                      <>
                        {lockedOut && <button className="btn small" onClick={() => act('player:rebuzz', p.id)}>Let buzz again</button>}
                        <button className="btn small" onClick={() => act('player:mute', p.id, !p.muted)}>{p.muted ? 'Unmute' : 'Mute'}</button>
                        <button className="btn small" onClick={() => { if (confirm(`Remove ${p.name} from the room?`)) act('player:kick', p.id, false); }}>Kick</button>
                        <button className="btn small danger" onClick={() => { if (confirm(`Ban ${p.name}? They won't be able to rejoin this room.`)) act('player:kick', p.id, true); }}>Ban</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
