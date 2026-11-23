import { useSyncExternalStore } from 'react';
import type { Preset } from '../shared/presets';
import type { Me, ProfileView } from '../shared/accounts';
import type { TitleOption, Visibility } from '../shared/profile';
import type { BoostView, LevelInfo } from '../shared/levels';
import { prefs, socket } from './socket';

// The logged-in account, shared by every component. Guests have me = null.

let me: Me | null = null;
let loaded = false;
/** The server can send email (reset and confirmation links). Off until it says so. */
let emailOn = false;
const listeners = new Set<() => void>();
let snap: { me: Me | null; loaded: boolean; emailOn: boolean } = { me, loaded, emailOn };

function set(next: Me | null) {
  me = next;
  loaded = true;
  snap = { me, loaded, emailOn };
  listeners.forEach((l) => l());
}

export function useAccount() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => snap,
  );
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Could not reach the server.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status}).`);
  return data as T;
}

/** Reconnect so the socket handshake carries the new session cookie (rejoins the room if in one). */
function reconnect() {
  socket.disconnect();
  socket.connect();
}

/** Logging in pulls the account's saved settings and name onto this device. */
function adopt(u: Me) {
  if (u.settings) prefs.setSettings(u.settings, false);
  if (!prefs.name()) prefs.setName(u.displayName);
  set(u);
}

export async function loadAccount() {
  try {
    const { user, email } = await api<{ user: Me | null; email?: boolean }>('/me');
    emailOn = !!email;
    if (user) adopt(user); else set(null);
  } catch {
    set(null);
  }
}

export async function signup(username: string, password: string, displayName: string, email: string) {
  const { user } = await api<{ user: Me }>('/signup', { method: 'POST', body: { username, password, displayName, email, settings: prefs.settings() ?? null } });
  prefs.setName(user.displayName);
  adopt(user);
  reconnect();
}

export async function login(username: string, password: string) {
  const { user } = await api<{ user: Me }>('/login', { method: 'POST', body: { username, password } });
  prefs.setName(user.displayName);
  adopt(user);
  reconnect();
}

/** Emails a reset link to the account's address, if it has one. The answer is the same either way. */
export async function forgotPassword(login: string) {
  await api('/password/forgot', { method: 'POST', body: { login } });
}

/** Sets a new password with the token from the emailed link, and logs in. */
export async function resetPassword(token: string, password: string) {
  const { user } = await api<{ user: Me }>('/password/reset', { method: 'POST', body: { token, password } });
  prefs.setName(user.displayName);
  adopt(user);
  reconnect();
}

/** Saves this account's own game presets (at most PRESET_SLOTS). */
export async function savePresets(presets: Preset[]) {
  const { user } = await api<{ user: Me }>('/me', { method: 'PATCH', body: { presets } });
  set(user);
  return user.presets;
}

/** New username (once a week). Reconnects so rooms and friends see the new name. */
export async function changeUsername(username: string) {
  const { user } = await api<{ user: Me }>('/me/username', { method: 'POST', body: { username } });
  set(user);
  reconnect();
  return user;
}

/** New password. Other devices are logged out; this one stays in. */
export async function changePassword(current: string, password: string) {
  const { user } = await api<{ user: Me }>('/password/change', { method: 'POST', body: { current, password } });
  set(user);
  reconnect();
}

/** Emails the (optional) confirmation link again. */
export async function sendConfirmEmail() {
  await api('/email/confirm/send', { method: 'POST' });
}

/** Opens a confirmation link. Works logged out too; refreshes the account if it's this device's. */
export async function confirmEmail(token: string) {
  const { username } = await api<{ ok: true; username: string }>('/email/confirm', { method: 'POST', body: { token } });
  if (me && me.username === username) set({ ...me, emailVerified: true });
  return username;
}

export async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {});
  set(null);
  reconnect();
}

export async function updateMe(patch: { displayName?: string; bio?: string; visibility?: Visibility; pinned?: string[]; color?: string; frame?: string; title?: string | null; email?: string; password?: string }) {
  const { user } = await api<{ user: Me }>('/me', { method: 'PATCH', body: patch });
  set(user);
  // A changed title shows in rooms after the socket reconnects (it carries the account into rooms).
  if ('title' in patch) reconnect();
  return user;
}

/** The titles this account can equip (given by an admin, or earned with badges) and the one it wears. */
export async function fetchTitles() {
  return api<{ options: TitleOption[]; equipped: string | null }>('/me/titles');
}

/** Admin: set exactly which special and custom titles an account has. */
export async function adminSetTitles(username: string, titles: string[]) {
  return api<{ ok: true; titles: string[] }>(`/admin/users/${encodeURIComponent(username)}/titles`, { method: 'POST', body: { titles } });
}

/** Admin: set exactly which badges are given to an account (on top of the ones they earn). */
export async function adminSetBadges(username: string, badges: string[]) {
  return api<{ ok: true; grantedBadges: string[] }>(`/admin/users/${encodeURIComponent(username)}/badges`, { method: 'POST', body: { badges } });
}

/** Admin: change an account's XP (yours too). `add` can be negative; `level` sets the start of that level; `earned` goes back to what their games are worth. */
export async function adminSetXp(username: string, change: { add: number } | { level: number } | { earned: true }) {
  return api<{ ok: true; levelInfo: LevelInfo }>(`/admin/users/${encodeURIComponent(username)}/xp`, { method: 'POST', body: change });
}

/** Admin: reset someone's display name (to their username) and/or clear their bio. */
export async function adminResetProfile(username: string, what: { name: boolean; bio: boolean }) {
  const body: { displayName?: false; bio?: false } = {};
  if (!what.name) body.displayName = false;
  if (!what.bio) body.bio = false;
  return api<{ ok: true; displayName?: string; bio?: string }>(`/admin/users/${encodeURIComponent(username)}/reset`, { method: 'POST', body });
}

/** Admin: unlock every badge for an account (yours too), or put it back to what they earned. */
export async function adminUnlockBadges(username: string, unlock: boolean) {
  return api<{ ok: true; unlocked: boolean }>(`/admin/users/${encodeURIComponent(username)}/badges`, { method: 'POST', body: { unlock } });
}

/** Upload a profile picture (a square JPEG made by `squareJpeg`). */
export async function uploadAvatar(jpeg: Blob) {
  let res: Response;
  try {
    res = await fetch('/api/me/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, credentials: 'same-origin' });
  } catch {
    throw new Error('Could not reach the server.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 413 ? 'That picture is too big.' : data.error ?? `Something went wrong (${res.status}).`);
  set(data.user);
  return data.user as Me;
}

export async function removeAvatar() {
  const { user } = await api<{ user: Me }>('/me/avatar', { method: 'DELETE' });
  set(user);
  return user;
}

/** Admin: take down someone's profile picture. */
export async function adminRemoveAvatar(username: string) {
  return api<{ ok: true }>(`/admin/users/${encodeURIComponent(username)}/avatar`, { method: 'DELETE' });
}

/** Admin: delete someone's account, sessions and saved games. */
export async function adminDeleteAccount(username: string) {
  return api<{ ok: true }>(`/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
}

export async function fetchProfile(username: string) {
  const { profile } = await api<{ profile: ProfileView }>(`/users/${encodeURIComponent(username)}`);
  return profile;
}

// Room settings a logged-in host picks follow them to other devices.
let settingsTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('qb-settings', (e) => {
  if (!me) return;
  const settings = (e as CustomEvent).detail;
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    if (!me) return;
    api('/me', { method: 'PATCH', body: { settings } }).catch(() => {});
    me = { ...me, settings };
  }, 1500);
});

// ---------- XP from the last finished game ----------

export interface XpNews { gained: number; before: LevelInfo; after: LevelInfo; unlocked: string[]; boost?: number; at: number }
let xpNews: XpNews | null = null;
const xpListeners = new Set<() => void>();

socket.on('account:xp', (x: Omit<XpNews, 'at'>) => {
  xpNews = { ...x, at: Date.now() };
  if (me) set({ ...me, level: x.after.level });
  xpListeners.forEach((l) => l());
});

// ---------- XP boost running now (an admin started it) ----------

let boost: BoostView | null = null;
const boostListeners = new Set<() => void>();
socket.on('xp:boost', (b: BoostView | null) => { boost = b; boostListeners.forEach((l) => l()); });

/** The XP boost on this player right now, or null. */
export function useXpBoost() {
  return useSyncExternalStore((l) => { boostListeners.add(l); return () => boostListeners.delete(l); }, () => boost);
}

// An admin changed this account's XP.
socket.on('account:level', (level: number) => { if (me) set({ ...me, level }); });

/** The XP the last game gave this account (null until a game ends while logged in). */
export function useXpNews() {
  return useSyncExternalStore((l) => { xpListeners.add(l); return () => xpListeners.delete(l); }, () => xpNews);
}

void loadAccount();
