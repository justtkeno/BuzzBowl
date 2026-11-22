import { useSyncExternalStore } from 'react';
import type { Me, ProfileView } from '../shared/accounts';
import type { Visibility } from '../shared/profile';
import { prefs, socket } from './socket';

// The logged-in account, shared by every component. Guests have me = null.

let me: Me | null = null;
let loaded = false;
const listeners = new Set<() => void>();
let snap: { me: Me | null; loaded: boolean } = { me, loaded };

function set(next: Me | null) {
  me = next;
  loaded = true;
  snap = { me, loaded };
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
    const { user } = await api<{ user: Me | null }>('/me');
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

export async function updateMe(patch: { displayName?: string; bio?: string; visibility?: Visibility; pinned?: string[]; color?: string; frame?: string; email?: string; password?: string }) {
  const { user } = await api<{ user: Me }>('/me', { method: 'PATCH', body: patch });
  set(user);
  return user;
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

void loadAccount();
