import { useEffect, useState } from 'react';
import { useTheme } from '../App';
import { GLOSSARY } from '../glossary';
import { AccountBar } from './Account';
import { Logo } from './Logo';
import { PhoneTabs } from './PhoneTabs';
import { SendFeedback } from './SendFeedback';

interface Faq { q: string; a: React.ReactNode }

const SECTIONS: { title: string; items: Faq[] }[] = [
  {
    title: 'Getting started',
    items: [
      { q: 'How do I play with friends?', a: <>On the home screen, open <b>Play with friends</b> and tap <b>Create a room</b>. Share the link or let people scan the QR code: they join right away, no account needed. Pick the rules (a preset is the quickest), then tap <b>Start game</b>.</> },
      { q: 'How do I join someone’s room?', a: <>Open the link they sent, scan their QR code, or type the 4-letter room code under <b>Play with friends → join with a code</b>.</> },
      { q: 'How do I buzz and answer?', a: <>Tap <b>Buzz</b> (or press Space on a keyboard) as soon as you know it, then type your answer and press Enter. Spelling doesn’t have to be perfect.</> },
      { q: 'Do I need an account?', a: <>No. Anyone can play as a guest. An account adds a profile with your stats and badges, friends, your own game presets, and remembers your name and settings on any device.</> },
      { q: 'Can I play alone?', a: <>Yes: <b>Play solo → Practice</b> for questions at your own pace (you can add computer opponents in the room), or <b>Survival</b> to see how long you last. There’s also <b>Today’s challenge</b>, the same 10 tossups for everyone each day.</> },
    ],
  },
  {
    title: 'Scoring and answers',
    items: [
      { q: 'How does scoring work?', a: <>A correct buzz is usually 10 points, or 15 if you buzz before the (*) in the question (a <b>power</b>). A wrong buzz before the question finishes is a <b>neg</b>, usually −5. The host can change all of these.</> },
      { q: 'Why was my answer marked wrong?', a: <>When the question ends, the card under it says what you typed and why it missed: it didn’t match, it needed more detail (a <b>prompt</b>), or it was on the do-not-accept list. It also shows every answer that would have counted.</> },
      { q: 'I think my answer was right. What can I do?', a: <>Open the <b>Rulings</b> tab and tap <b>Protest</b> on that answer. The host (or reader) decides, and if they agree the scores update straight away. Protests aren’t available in the daily challenge or survival, where every answer is checked the same way for everyone.</> },
      { q: 'What happens when two people buzz at nearly the same time?', a: <>Whoever had seen fewer words gets it, even if their buzz arrived a split second later on a slower connection.</> },
    ],
  },
  {
    title: 'Rooms and rules',
    items: [
      { q: 'What are presets?', a: <>Ready-made sets of rules: <b>Casual</b>, <b>Tournament rules</b>, <b>Quick 10</b> and <b>Party</b>. The host picks one in the lobby, or opens <b>Room settings</b> to set every rule. Signed in, you can save up to 5 of your own presets and share any of them with a link.</> },
      { q: 'Can the host change rules during a game?', a: <>Yes: <b>⋯ Menu → Room settings</b>. Longer or shorter timers apply right away, new question topics start with the next tossup, and everyone sees a note in chat.</> },
      { q: 'What does a reader do?', a: <>A reader is optional. They see each question early, read it out loud (in the room or on a call), control the pace and rule on answers. Without one, the app shows the question word by word.</> },
      { q: 'What’s the big-screen view?', a: <>A scoreboard and question view for a TV or projector: <b>⋯ Menu → Big-screen view</b>. It never plays, it just shows the game.</> },
      { q: 'Teams, party mode and bots?', a: <><b>Teams</b>: up to 4 per team, a buzz locks out the whole team, and the team plays the bonus together. <b>Party</b>: everyone for themselves, voting on the next topic. <b>Computer opponents</b> (bots) can be added in the lobby at four skill levels.</> },
    ],
  },
  {
    title: 'Your account',
    items: [
      { q: 'I forgot my password.', a: <>Tap <b>Log in → Forgot password?</b> and enter your username or email. A reset link goes to the email on your account, and works for an hour. Without an email on the account, the password can’t be reset, so add one in <b>gear → Account settings</b>.</> },
      { q: 'Can I change my username?', a: <>Yes, in <b>gear → Account settings</b>. After changing it, you have to wait 7 days to change it again. Your profile link, leaderboard entries and friends follow the new name.</> },
      { q: 'Who can see my email?', a: <>Nobody. It’s only used to send password-reset and confirmation links. See the <a href="/privacy">privacy page</a> for everything Trivio keeps.</> },
      { q: 'Who can see my stats?', a: <>Everyone by default. In <b>Edit profile</b> you can limit them to friends, or to just you.</> },
      { q: 'Can I install Trivio as an app?', a: <>Yes. On the home screen, tap <b>Install app</b> if it shows, or use your browser’s “Add to Home Screen”.</> },
    ],
  },
];

/** /help: questions people ask, and every quiz bowl word explained. */
export function Help() {
  useTheme();
  const [feedback, setFeedback] = useState(false);
  useEffect(() => { document.title = 'Help · Trivio'; }, []);
  const terms = Object.values(GLOSSARY).sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="profile-page with-tabbar">
      <header className="profile-top">
        <a className="brand small" href="/"><Logo /> Trivio</a>
        <AccountBar />
      </header>
      <main className="profile help">
        <section className="card">
          <h1>Help</h1>
          <p className="muted">Tap a question to see the answer. Every quiz bowl word is explained in the glossary below, and the small ⓘ buttons around the site explain them too.</p>
          <nav className="help-toc" aria-label="Sections">
            {SECTIONS.map((sec) => <a key={sec.title} href={`#${slug(sec.title)}`}>{sec.title}</a>)}
            <a href="#glossary">Glossary</a>
          </nav>
        </section>

        {SECTIONS.map((sec) => (
          <section key={sec.title} className="card" id={slug(sec.title)}>
            <h2>{sec.title}</h2>
            {sec.items.map((f) => (
              <details key={f.q} className="faq">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </section>
        ))}

        <section className="card" id="glossary">
          <h2>Glossary</h2>
          <dl className="glossary">
            {terms.map((t) => <div key={t.title}><dt>{t.title}</dt><dd>{t.text}</dd></div>)}
          </dl>
        </section>

        <section className="card">
          <h2>Still stuck?</h2>
          <p className="muted">Tell us what happened and we’ll help.</p>
          <div className="row gap"><button className="btn" onClick={() => setFeedback(true)}>Send feedback</button><a className="btn ghost" href="/">Back to Trivio</a></div>
        </section>
      </main>
      {feedback && <SendFeedback where="help" name="" onClose={() => setFeedback(false)} />}
      <PhoneTabs active={null} />
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-');
