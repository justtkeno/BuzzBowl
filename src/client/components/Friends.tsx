import { useState } from 'react';
import { USERNAME_RE, type Friend, type FriendRequest } from '../../shared/accounts';
import { removeFriend, sendFriendRequest, useFriends } from '../friends';
import { CreatorBadge } from './Account';

const OFFLINE_SHOWN = 3;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusText(f: Friend) {
  if (f.status === 'room' && f.room) {
    const people = plural(f.room.players, 'player');
    if (f.room.phase === 'lobby') return `Lobby · ${people}`;
    if (f.room.phase === 'over') return `Results · ${people}`;
    return `${f.room.mode === 'teams' ? 'Teams game' : 'In a game'} · ${people}`;
  }
  if (f.status === 'daily') return 'Daily challenge';
  return f.status === 'online' ? 'Online' : 'Offline';
}

function Avatar({ name, status }: { name: string; status?: Friend['status'] }) {
  return (
    <span className="avatar friend-avatar" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
      {status && status !== 'offline' && <span className={`friend-dot ${status}`} />}
    </span>
  );
}

function Name({ who }: { who: { username: string; displayName: string; admin: boolean } }) {
  return <a className="friend-name" href={`/u/${who.username}`}>{who.displayName}{who.admin && <CreatorBadge />}</a>;
}

/** Home page: your friends, who's playing where, and requests. Logged-in players only. */
export function FriendsCard({ busy, connected, onJoin }: { busy: boolean; connected: boolean; onJoin: (code: string) => void }) {
  const { me, list, change } = useFriends(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!me) return null;

  const act = async (fn: () => ReturnType<typeof sendFriendRequest>) => {
    setWorking(true); setErr(null);
    try { await change(fn); return true; } catch (e: any) { setErr(e.message); return false; } finally { setWorking(false); }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = name.trim().replace(/^@/, '');
    if (!USERNAME_RE.test(u)) return setErr('Usernames are 3–20 letters, numbers or underscores.');
    if (await act(() => sendFriendRequest(u))) { setName(''); setAdding(false); }
  };

  const friends = list?.friends ?? [];
  const here = friends.filter((f) => f.status !== 'offline');
  const away = friends.filter((f) => f.status === 'offline');
  const shownAway = showAll ? away : away.slice(0, OFFLINE_SHOWN);
  const inRooms = friends.filter((f) => f.status === 'room' || f.status === 'daily').length;
  const online = here.length - inRooms;
  const summary = !list ? 'Loading…'
    : !friends.length ? (list.incoming.length ? plural(list.incoming.length, 'friend request') : 'Add friends by username to join their games')
    : inRooms || online ? [inRooms && `${inRooms} playing`, online && `${online} online`].filter(Boolean).join(' · ')
    : 'Nobody online right now';

  return (
    <section className="friends-card" aria-label="Friends">
      <div className="row between">
        <div>
          <div className="daily-title">Friends{list?.incoming.length ? <span className="friends-badge">{list.incoming.length}</span> : null}</div>
          <div className="muted small">{summary}</div>
        </div>
        <button className="btn" onClick={() => { setAdding(!adding); setErr(null); }} aria-expanded={adding}>{adding ? 'Cancel' : 'Add'}</button>
      </div>

      {adding && (
        <form className="row gap" onSubmit={add}>
          <input className="grow" autoFocus value={name} maxLength={21} placeholder="Their username" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value)} aria-label="Friend's username" />
          <button className="btn primary" disabled={working || !name.trim()}>Send</button>
        </form>
      )}
      {err && <p className="error small">{err}</p>}

      {!!list?.incoming.length && (
        <ul className="friend-list">
          {list.incoming.map((r) => (
            <RequestRow key={r.username} r={r} note="">
              <button className="btn ghost small" disabled={working} onClick={() => void act(() => removeFriend(r.username))}>Decline</button>
              <button className="btn primary small" disabled={working} onClick={() => void act(() => sendFriendRequest(r.username))}>Accept</button>
            </RequestRow>
          ))}
        </ul>
      )}

      {friends.length > 0 && (
        <ul className="friend-list">
          {[...here, ...shownAway].map((f) => (
            <li key={f.username} className={`friend ${f.status}`}>
              <Avatar name={f.displayName} status={f.status} />
              <div className="grow friend-text">
                <Name who={f} />
                <div className="muted small">{statusText(f)}</div>
              </div>
              {f.room && (
                <div className="row gap friend-actions">
                  <a className="btn ghost small" href={`/watch/${f.room.code}`} aria-label={`Watch ${f.displayName}’s room`}>Watch</a>
                  <button className="btn primary small" disabled={busy || !connected} onClick={() => onJoin(f.room!.code)} aria-label={`Join ${f.displayName}’s room`}>Join</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {away.length > OFFLINE_SHOWN && (
        <button className="btn ghost small friends-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show ${away.length - OFFLINE_SHOWN} more offline`}
        </button>
      )}

      {!!list?.outgoing.length && (
        <ul className="friend-list sent">
          {list.outgoing.map((r) => (
            <RequestRow key={r.username} r={r} note="sent">
              <button className="btn ghost small" disabled={working} onClick={() => void act(() => removeFriend(r.username))}>Cancel</button>
            </RequestRow>
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestRow({ r, note, children }: { r: FriendRequest; note: string; children: React.ReactNode }) {
  return (
    <li className="friend">
      <Avatar name={r.displayName} />
      <div className="grow friend-text">
        <Name who={r} />
        <div className="muted small">@{r.username}{note && ` · ${note}`}</div>
      </div>
      <div className="row gap friend-actions">{children}</div>
    </li>
  );
}

/** Profile page: add, accept, or remove this player as a friend. */
export function FriendButton({ username }: { username: string }) {
  const { me, list, change } = useFriends(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me || !list || me.username.toLowerCase() === username.toLowerCase()) return null;

  const key = username.toLowerCase();
  const match = (x: { username: string }) => x.username.toLowerCase() === key;
  const friend = list.friends.find(match);
  const incoming = list.incoming.some(match);
  const outgoing = list.outgoing.some(match);

  const act = async (fn: () => ReturnType<typeof sendFriendRequest>) => {
    setWorking(true); setErr(null);
    try { await change(fn); } catch (e: any) { setErr(e.message); } finally { setWorking(false); }
  };

  return (
    <>
      {friend?.room && <a className="btn primary small" href={`/r/${friend.room.code}`} title={statusText(friend)}>Join their game</a>}
      {friend ? (
        <button className="btn small" disabled={working} title="Remove friend" onClick={() => confirm(`Remove ${friend.displayName} from your friends?`) && void act(() => removeFriend(username))}>Friends ✓</button>
      ) : incoming ? (
        <button className="btn primary small" disabled={working} onClick={() => void act(() => sendFriendRequest(username))}>Accept friend request</button>
      ) : outgoing ? (
        <button className="btn small" disabled={working} title="Cancel request" onClick={() => void act(() => removeFriend(username))}>Request sent · Cancel</button>
      ) : (
        <button className="btn primary small" disabled={working} onClick={() => void act(() => sendFriendRequest(username))}>Add friend</button>
      )}
      {err && <span className="error small">{err}</span>}
    </>
  );
}
