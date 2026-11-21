import { afterEach, describe, expect, it, vi } from 'vitest';

// isAdmin reads its settings when the module loads, so each case loads a fresh copy.
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../src/server/accounts/accounts');
}

afterEach(() => { delete process.env.ADMIN_ACCOUNT_IDS; delete process.env.ADMIN_USERNAMES; });

describe('who is an admin', () => {
  it('goes by username when not locked', async () => {
    const m = await load({ ADMIN_ACCOUNT_IDS: undefined, ADMIN_USERNAMES: undefined });
    expect(m.adminLocked).toBe(false);
    expect(m.isAdmin({ id: 'a1', username: 'hao' })).toBe(true);
    expect(m.isAdmin({ id: 'zz', username: 'Hao' })).toBe(true);
    expect(m.isAdmin({ id: 'b2', username: 'someone' })).toBe(false);
  });

  it('only the listed account ids once locked, whatever the username', async () => {
    const m = await load({ ADMIN_ACCOUNT_IDS: 'acc-real, acc-two' });
    expect(m.adminLocked).toBe(true);
    expect(m.isAdmin({ id: 'acc-real', username: 'Hao' })).toBe(true);
    expect(m.isAdmin({ id: 'acc-two', username: 'helper' })).toBe(true);
    // Someone who registers "Hao" after a wipe gets a new id, so no powers.
    expect(m.isAdmin({ id: 'acc-new', username: 'Hao' })).toBe(false);
  });
});
