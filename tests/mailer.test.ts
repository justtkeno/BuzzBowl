import { afterEach, describe, expect, it, vi } from 'vitest';
import { gmailApiMailer, mailerFromEnv } from '../src/server/accounts/mailer';

/** A stand-in for Google: records requests and answers the token and send endpoints. */
function fakeGoogle(opts: { tokenFails?: boolean; sendStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('oauth2.googleapis.com/token')) {
      return opts.tokenFails
        ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })
        : new Response(JSON.stringify({ access_token: `tok${calls.length}`, expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(opts.sendStatus && opts.sendStatus >= 400 ? { error: { message: 'nope' } } : { id: 'm1' }), { status: opts.sendStatus ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const creds = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh', from: 'Trivio <playtriviosupport@gmail.com>' };

describe('Gmail API mailer', () => {
  it('trades the refresh token for an access token and sends a proper message', async () => {
    const g = fakeGoogle();
    const mailer = gmailApiMailer({ ...creds, fetch: g.fetch });
    await mailer.send({ to: 'player@example.com', subject: 'Reset your Trivio password', text: 'Open this link: https://x/reset#abc', html: '<p>Open <a href="https://x/reset#abc">this</a></p>' });

    const [tokenCall, sendCall] = g.calls;
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(Object.fromEntries(form)).toEqual({ client_id: 'cid', client_secret: 'secret', refresh_token: 'refresh', grant_type: 'refresh_token' });
    expect(sendCall.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect((sendCall.init.headers as Record<string, string>).Authorization).toBe('Bearer tok1');
    const raw = Buffer.from(JSON.parse(String(sendCall.init.body)).raw, 'base64url').toString();
    expect(raw).toMatch(/^From: Trivio <playtriviosupport@gmail\.com>/m);
    expect(raw).toMatch(/^To: player@example\.com/m);
    expect(raw).toMatch(/^Subject: Reset your Trivio password/m);
    expect(raw).toContain('https://x/reset#abc');
    expect(raw).toContain('multipart/alternative'); // text and html versions
  });

  it('reuses the access token until it expires', async () => {
    const g = fakeGoogle();
    const mailer = gmailApiMailer({ ...creds, fetch: g.fetch });
    await mailer.send({ to: 'a@example.com', subject: 's', text: 't' });
    await mailer.send({ to: 'b@example.com', subject: 's', text: 't' });
    expect(g.calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });

  it('explains a revoked token or a failed send', async () => {
    await expect(gmailApiMailer({ ...creds, fetch: fakeGoogle({ tokenFails: true }).fetch }).send({ to: 'a@example.com', subject: 's', text: 't' }))
      .rejects.toThrow(/Gmail sign-in failed: invalid_grant/);
    await expect(gmailApiMailer({ ...creds, fetch: fakeGoogle({ sendStatus: 403 }).fetch }).send({ to: 'a@example.com', subject: 's', text: 't' }))
      .rejects.toThrow(/Gmail send failed: 403 \(nope\)/);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is picked over SMTP when its settings are present', async () => {
    expect(mailerFromEnv({ NODE_ENV: 'production' })).toBeNull();
    expect(mailerFromEnv({ NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@smtp.example.com:465' })).not.toBeNull();
    const g = fakeGoogle();
    vi.stubGlobal('fetch', g.fetch);
    const both = mailerFromEnv({ NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@127.0.0.1:1', GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c', MAIL_FROM: 'Trivio <x@gmail.com>' })!;
    await both.send({ to: 'a@example.com', subject: 's', text: 't' }); // would fail over SMTP (nothing on port 1)
    expect(g.calls.map((c) => new URL(c.url).hostname)).toEqual(['oauth2.googleapis.com', 'gmail.googleapis.com']);
  });
});
