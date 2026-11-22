// Sends account email (password resets). Any SMTP provider works: set SMTP_URL and MAIL_FROM.
//   Gmail:  SMTP_URL=smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465  MAIL_FROM="Trivio <you@gmail.com>"
//   Brevo:  SMTP_URL=smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587           MAIL_FROM="Trivio <verified@sender>"
// Without SMTP_URL, a local server prints the email to the console instead, and production can't send any.

import nodemailer from 'nodemailer';

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export function mailerFromEnv(env = process.env): Mailer | null {
  if (env.SMTP_URL) {
    const transport = nodemailer.createTransport(env.SMTP_URL);
    const from = env.MAIL_FROM || 'Trivio <no-reply@localhost>';
    return { send: async (m) => { await transport.sendMail({ from, ...m }); } };
  }
  if (env.NODE_ENV === 'production') {
    console.warn('SMTP_URL is not set, so password-reset emails are off.');
    return null;
  }
  return { send: async (m) => { console.log(`\n--- email to ${m.to}: ${m.subject}\n${m.text}\n---\n`); } };
}
