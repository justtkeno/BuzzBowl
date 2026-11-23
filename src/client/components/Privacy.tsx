import { useEffect } from 'react';
import { useTheme } from '../App';
import { Logo } from './Logo';
import { PhoneTabs } from './PhoneTabs';

const CONTACT = 'playtriviosupport@gmail.com';

/** /privacy: what Trivio keeps and why. Linked from the home screen and from Google's sign-in setup for account emails. */
export function Privacy() {
  useTheme();
  useEffect(() => { document.title = 'Privacy · Trivio'; }, []);
  return (
    <div className="profile-page with-tabbar">
      <header className="profile-top">
        <a className="brand small" href="/"><Logo /> Trivio</a>
      </header>
      <main className="profile privacy">
        <section className="card">
          <h1>Privacy</h1>
          <p className="muted small">Last updated November 22, 2026</p>
          <p>Trivio is a free quiz bowl practice site. You can play as a guest without giving any personal information. This page says what the site keeps and why.</p>

          <h2>If you play as a guest</h2>
          <ul>
            <li>The name you type is shown to the other players in your room.</li>
            <li>Your browser keeps your name, settings (sound, theme, text size) and a random device key in its own storage, so they’re remembered next time. You can clear them by clearing the site’s data in your browser.</li>
            <li>Daily challenge and Survival results are saved under that random key with the name you played as, so they can appear on the leaderboards.</li>
          </ul>

          <h2>If you make an account</h2>
          <ul>
            <li>Your username, display name, bio, the games you finish (scores and per-subject stats), your friends list and your profile choices. Your profile shows these to others unless you limit who can see it.</li>
            <li>Your password, stored only as a scrambled hash; nobody can read it.</li>
            <li>A session cookie that keeps you logged in. It is the only cookie the site sets.</li>
            <li>Your email address, only if you add one. It is never shown to anyone and is used only to send you password-reset and email-confirmation links. You can change or remove it in Account settings.</li>
          </ul>

          <h2>Other things the server keeps</h2>
          <ul>
            <li>Feedback and question reports you send, with your name or username and the kind of device you sent them from.</li>
            <li>Counts for the site owner: how many devices opened the site each day (as scrambled keys, not names) and which game modes were played.</li>
            <li>Your IP address is used only briefly, to limit repeated login attempts. It isn’t stored.</li>
          </ul>

          <h2>Who else handles data</h2>
          <ul>
            <li>The site runs on Render, and accounts are stored in a Neon Postgres database.</li>
            <li>Account emails are sent from {CONTACT} through Gmail.</li>
            <li>Questions come from QBReader; the server fetches them, so QBReader doesn’t see who you are.</li>
          </ul>
          <p>Nothing is sold, and there are no ads or third-party trackers.</p>

          <h2>Deleting your data</h2>
          <p>To delete your account and everything saved with it, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address on your account, or tell us your username. The same address answers any other privacy question.</p>

          <p><a className="btn" href="/">Back to Trivio</a></p>
        </section>
      </main>
      <PhoneTabs active={null} />
    </div>
  );
}
