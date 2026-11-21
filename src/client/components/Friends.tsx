import { useEffect, useRef, useState } from 'react';
import { USERNAME_RE, type Friend, type FriendRequest, type FriendsList } from '../../shared/accounts';
import { removeFriend, sendFriendRequest, useFriends } from '../friends';
import { call, socket } from '../socket';
import { AccountDialog, CreatorBadge } from './Account';

/** How often the list refreshes while the panel is open, and (for the tab's counts) while it's closed. */
const OPEN_POLL_MS = 15_000;
const CLOSED_POLL_MS = 60_000;

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

function Name({ who, newTab }: { who: { username: string; displayName: string; admin: boolean }; newTab?: boolean }) {
  return (
    <a className="friend-name" href={`/u/${who.username}`} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {who.displayName}{who.admin && <CreatorBadge />}
    </a>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="7.5" cy="6.5" r="3" fill="currentColor" />
      <path d="M1.5 16.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5z" fill="currentColor" />
      <circle cx="14" cy="7" r="2.4" fill="currentColor" opacity=".6" />
      <path d="M14.5 11c2.5.2 4.2 2.1 4.2 5.5h-3.6c0-2.2-.6-4-1.9-5.2.4-.2.8-.3 1.3-.3z" fill="currentColor" opacity=".6" />
    </svg>
  );
}

interface TabProps {
  /** Join a friend's room. Defaults to opening its invite link. */
  onJoin?: (code: string) => void;
  /** The room you're in now, so a friend in it shows "In your room" instead of Join. */
  currentCode?: string;
  /** Keep the tab off screen (for example while a question is being read). */
  hidden?: boolean;
  /** Join buttons disabled (not connected, or busy). */
  disabled?: boolean;
  /** Show Invite buttons (you're in a room friends can join). */
  canInvite?: boolean;
}

/** A small tab on the right edge that slides out a friends panel. Works for guests too (it offers to log in). */
export function FriendsTab({ onJoin, currentCode, hidden, disabled, canInvite }: TabProps) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState<null | 'login' | 'signup'>(null);
  const f = useFriends(open ? OPEN_POLL_MS : CLOSED_POLL_MS);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    // Fresh statuses the moment it opens.
    void f.refresh();
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => { if (hidden) setOpen(false); }, [hidden]);

  const list = f.list;
  const playing = list?.friends.filter((x) => x.status === 'room' || x.status === 'daily').length ?? 0;
  const online = list?.friends.filter((x) => x.status === 'online').length ?? 0;
  const requests = list?.incoming.length ?? 0;
  const label = !f.me ? 'Friends' : `Friends: ${playing + online} online${requests ? `, ${plural(requests, 'friend request')}` : ''}`;
  const join = (code: string) => {
    setOpen(false);
    if (onJoin) onJoin(code); else location.href = `/r/${code}`;
  };

  return (
    <>
      {!hidden && !open && (
        <button className="friends-tab" onClick={() => setOpen(true)} aria-label={label} aria-expanded={false} title={label}>
          <PeopleIcon />
          {f.me && playing + online > 0 && <span className="friends-tab-count">{playing + online}</span>}
          {requests > 0 && <span className="friends-tab-alert" />}
        </button>
      )}
      {open && (
        <>
          <div className="friends-back" onClick={() => setOpen(false)} />
          <aside className="friends-drawer" ref={panel} tabIndex={-1} aria-label="Friends">
            <header className="friends-drawer-head">
              <h2>Friends</h2>
              <button className="btn ghost small" onClick={() => setOpen(false)} aria-label="Close friends">✕</button>
            </header>
            {f.me ? (
              <FriendsPanel list={list} change={f.change} onJoin={join} currentCode={currentCode} disabled={disabled} newTab={!!currentCode} canInvite={canInvite} />
            ) : (
              <div className="friends-guest">
                <p className="muted">Log in to add friends by username, see when they’re online, and jump into their games.</p>
                <div className="row gap">
                  <button className="btn primary" onClick={() => { setOpen(false); setLogin('signup'); }}>Sign up</button>
                  <button className="btn" onClick={() => { setOpen(false); setLogin('login'); }}>Log in</button>
                </div>
              </div>
            )}
          </aside>
        </>
      )}
      {login && <AccountDialog initial={login} onClose={() => setLogin(null)} />}
    </>
  );
}

interface PanelProps {
  list: FriendsList | null;
  change: (fn: () => Promise<FriendsList>) => Promise<void>;
  onJoin: (code: string) => void;
  currentCode?: string;
  disabled?: boolean;
  newTab?: boolean;
  canInvite?: boolean;
}

const INVITE_COOLDOWN_MS = 20_000;

function FriendsPanel({ list, change, onJoin, currentCode, disabled, newTab, canInvite }: PanelProps) {
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const invite = async (x: Friend) => {
    setErr(null); setNote(null);
    try {
      await call('friend:invite', x.username);
      setInvited((s) => new Set(s).add(x.username));
      setTimeout(() => setInvited((s) => { const n = new Set(s); n.delete(x.username); return n; }), INVITE_COOLDOWN_MS);
    } catch (e: any) { setErr(e.message); }
  };
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const act = async (fn: () => Promise<FriendsList>) => {
    setWorking(true); setErr(null); setNote(null);
    try { await change(fn); return true; } catch (e: any) { setErr(e.message); return false; } finally { setWorking(false); }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = name.trim().replace(/^@/, '');
    if (!USERNAME_RE.test(u)) return setErr('Usernames are 3–20 letters, numbers or underscores.');
    if (await act(() => sendFriendRequest(u))) { setName(''); setNote(`Request sent to @${u}.`); }
  };

  const friends = list?.friends ?? [];
  const playing = friends.filter((x) => x.status === 'room' || x.status === 'daily');
  const online = friends.filter((x) => x.status === 'online');
  const offline = friends.filter((x) => x.status === 'offline');

  const row = (x: Friend) => (
    <li key={x.username} className={`friend ${x.status}`}>
      <Avatar name={x.displayName} status={x.status} />
      <div className="grow friend-text">
        <Name who={x} newTab={newTab} />
        <div className="muted small">{x.room && x.room.code === currentCode ? 'In your room' : statusText(x)}</div>
      </div>
      {(() => {
        const elsewhere = !!x.room && x.room.code !== currentCode;
        const invitable = canInvite && (x.status === 'online' || elsewhere);
        if (!elsewhere && !invitable) return null;
        return (
          <div className="row gap friend-actions">
            {invitable ? (
              <button className="btn ghost small" disabled={disabled || invited.has(x.username)} onClick={() => void invite(x)} aria-label={`Invite ${x.displayName} to your room`}>
                {invited.has(x.username) ? 'Invited' : 'Invite'}
              </button>
            ) : (
              <a className="btn ghost small" href={`/watch/${x.room!.code}`} rel="noreferrer" aria-label={`Watch ${x.displayName}’s room`}>Watch</a>
            )}
            {elsewhere && <button className="btn primary small" disabled={disabled} onClick={() => onJoin(x.room!.code)} aria-label={`Join ${x.displayName}’s room`}>Join</button>}
          </div>
        );
      })()}
    </li>
  );
  const section = (title: string, items: React.ReactNode[]) => items.length > 0 && (
    <section className="friends-section">
      <h3>{title} <span className="muted">{items.length}</span></h3>
      <ul className="friend-list">{items}</ul>
    </section>
  );

  return (
    <div className="friends-body">
      <form className="row gap" onSubmit={add}>
        <input className="grow" value={name} maxLength={21} placeholder="Add by username" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value)} aria-label="Friend's username" />
        <button className="btn primary" disabled={working || !name.trim()}>Add</button>
      </form>
      {err && <p className="error small">{err}</p>}
      {note && <p className="muted small">{note}</p>}

      {!list && <p className="muted small">Loading…</p>}
      {list && !friends.length && !list.incoming.length && !list.outgoing.length && (
        <p className="muted small">No friends yet. Add someone by their username. Once they accept, you’ll see when they’re online and can join their games.</p>
      )}

      {section('Requests', (list?.incoming ?? []).map((r) => (
        <RequestRow key={r.username} r={r} newTab={newTab}>
          <button className="btn ghost small" disabled={working} onClick={() => void act(() => removeFriend(r.username))}>Decline</button>
          <button className="btn primary small" disabled={working} onClick={() => void act(() => sendFriendRequest(r.username))}>Accept</button>
        </RequestRow>
      )))}
      {section('Playing', playing.map(row))}
      {section('Online', online.map(row))}
      {section('Offline', offline.map(row))}
      {section('Sent', (list?.outgoing ?? []).map((r) => (
        <RequestRow key={r.username} r={r} newTab={newTab}>
          <button className="btn ghost small" disabled={working} onClick={() => void act(() => removeFriend(r.username))}>Cancel</button>
        </RequestRow>
      )))}
    </div>
  );
}

function RequestRow({ r, newTab, children }: { r: FriendRequest; newTab?: boolean; children: React.ReactNode }) {
  return (
    <li className="friend">
      <Avatar name={r.displayName} />
      <div className="grow friend-text">
        <Name who={r} newTab={newTab} />
        <div className="muted small">@{r.username}</div>
      </div>
      <div className="row gap friend-actions">{children}</div>
    </li>
  );
}

/** Profile page: add, accept, or remove this player as a friend. */
export function FriendButton({ username }: { username: string }) {
  const { me, list, change } = useFriends(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me || !list || me.username.toLowerCase() === username.toLowerCase()) return null;

  const key = username.toLowerCase();
  const match = (x: { username: string }) => x.username.toLowerCase() === key;
  const friend = list.friends.find(match);
  const incoming = list.incoming.some(match);
  const outgoing = list.outgoing.some(match);

  const act = async (fn: () => Promise<FriendsList>) => {
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

interface Invite { code: string; from: { username: string; displayName: string }; at: number }
const INVITE_SHOWN_MS = 30_000;

/** "Alex invited you to play" with a Join button, when a friend invites you. Quiet during the daily challenge. */
export function InviteBanner({ currentCode, onJoin, quiet }: { currentCode?: string; onJoin?: (code: string) => void; quiet?: boolean }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const here = useRef({ currentCode, quiet });
  here.current = { currentCode, quiet };

  useEffect(() => {
    const on = (i: Invite) => {
      if (here.current.quiet || i.code === here.current.currentCode) return;
      setInvite(i);
    };
    socket.on('invite', on);
    return () => { socket.off('invite', on); };
  }, []);
  useEffect(() => {
    if (!invite) return;
    const t = setTimeout(() => setInvite(null), INVITE_SHOWN_MS);
    return () => clearTimeout(t);
  }, [invite]);
  // Already got there some other way.
  useEffect(() => { if (invite && invite.code === currentCode) setInvite(null); }, [currentCode]);

  if (!invite) return null;
  const join = () => {
    setInvite(null);
    if (onJoin) onJoin(invite.code); else location.href = `/r/${invite.code}`;
  };
  return (
    <div className="invite-banner" role="status">
      <Avatar name={invite.from.displayName} status="room" />
      <span className="grow"><b>{invite.from.displayName}</b> invited you to play</span>
      <button className="btn primary small" onClick={join}>Join</button>
      <button className="btn ghost small" onClick={() => setInvite(null)} aria-label="Dismiss invite">✕</button>
    </div>
  );
}
