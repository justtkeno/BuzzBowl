// Sends account email (password resets, confirming an address). Three ways, first match wins:
//
// 1. Gmail API over HTTPS (works on Render's free plan, which blocks SMTP ports):
//      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (scope gmail.send), MAIL_FROM="Trivio <you@gmail.com>"
//    README.md has the one-time Google Cloud setup.
// 2. SMTP, on hosts that allow it:
//      SMTP_URL=smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465  MAIL_FROM="Trivio <you@gmail.com>"
// 3. Neither: a local server prints the email to the console, and production can't send any.

import nodemailer from 'nodemailer';

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export function mailerFromEnv(env = process.env): Mailer | null {
  const from = env.MAIL_FROM || 'Trivio <no-reply@localhost>';
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN) {
    return gmailApiMailer({ clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, refreshToken: env.GMAIL_REFRESH_TOKEN, from });
  }
  if (env.SMTP_URL) {
    const transport = nodemailer.createTransport(env.SMTP_URL);
    return { send: async (m) => { await transport.sendMail({ from, ...m }); } };
  }
  if (env.NODE_ENV === 'production') {
    console.warn('No GMAIL_* or SMTP_URL settings, so account emails (password resets) are off.');
    return null;
  }
  return { send: async (m) => { console.log(`\n--- email to ${m.to}: ${m.subject}\n${m.text}\n---\n`); } };
}

/** Sends through the Gmail API with an OAuth refresh token. Only HTTPS, so hosts that block SMTP don't matter. */
export function gmailApiMailer(o: { clientId: string; clientSecret: string; refreshToken: string; from: string; fetch?: typeof fetch }): Mailer {
  const http = o.fetch ?? fetch;
  // Builds the raw RFC 822 message (headers, encodings, text + html parts) without sending it.
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let token: { value: string; until: number } | null = null;

  const accessToken = async () => {
    if (token && Date.now() < token.until) return token.value;
    const res = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token' }),
    });
    const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(`Gmail sign-in failed: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`);
    // Renew a minute early.
    token = { value: data.access_token, until: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  };

  return {
    async send(m) {
      const { message } = await composer.sendMail({ from: o.from, ...m });
      const raw = (message as Buffer).toString('base64url');
      const res = await http('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) {
        if (res.status === 401) token = null; // try a fresh token next time
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(`Gmail send failed: ${res.status}${err.error?.message ? ` (${err.error.message})` : ''}`);
      }
    },
  };
}
