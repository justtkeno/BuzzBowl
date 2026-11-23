import { Logo } from './Logo';
import { useEffect, useState } from 'react';
import type { PresetSettings } from '../../shared/presets';
import { useAccount } from '../account';
import { randomName } from '../names';
import { prefs } from '../socket';
import { AccountBar } from './Account';
import { BoostChip } from './BoostChip';
import { DailyCard } from './Daily';
import { SurvivalCard } from './Survival';
import { FriendsTab } from './Friends';
import { InstallButton } from './InstallButton';
import { Icon, type IconName } from './Icon';
import { Info } from './Info';
import { PhoneTabs } from './PhoneTabs';
import { SharedPresetCard, sharedPresetFromUrl } from './Presets';
import { Tutorial } from './Tutorial';
import { SendFeedback } from './SendFeedback';

interface Props {
  initialCode: string | null;
  error: string | null;
  connected: boolean;
  onJoin: (code: string, name: string) => Promise<void>;
  onCreate: (name: string, solo: boolean, preset?: PresetSettings) => Promise<void>;
  onDaily: (name: string) => Promise<void>;
  onSurvival: (name: string) => Promise<void>;
  /** Opened at /daily: show today's results right away. */
  dailyOpen: boolean;
  /** Opened at /survival: show the leaderboard right away. */
  survivalOpen: boolean;
}

type Choice = 'friends' | 'solo' | 'daily';

export function Home({ initialCode, error, connected, onJoin, onCreate, onDaily, onSurvival, dailyOpen, survivalOpen }: Props) {
  const [tour, setTour] = useState(false);
  const [name, setName] = useState(() => prefs.name() || randomName());
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(false);
  const [open, setOpen] = useState<Choice | null>(dailyOpen ? 'daily' : survivalOpen ? 'solo' : null);
  // A preset someone shared (?preset=…): offer to start a room with it, or save it.
  const [shared, setShared] = useState(sharedPresetFromUrl);
  const dropShared = () => { setShared(null); history.replaceState(null, '', location.pathname); };
  const { me } = useAccount();
  // Logging in fills in the account's display name.
  useEffect(() => { if (me) setName(me.displayName); setErr(null); }, [me?.id]);
  // The phone tab bar opens a choice (Daily) or folds them all (Play).
  useEffect(() => {
    const on = (e: Event) => { setOpen((e as CustomEvent<Choice | null>).detail); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    window.addEventListener('qb-home-open', on);
    return () => window.removeEventListener('qb-home-open', on);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    if (!name.trim()) return setErr('Pick a display name first.');
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggle = (c: Choice) => setOpen((o) => (o === c ? null : c));

  return (
    <div className="home with-tabbar">
      <div className="home-card">
        <AccountBar />
        <div className="brand"><Logo /> Trivio</div>
        <BoostChip className="home-boost" />
        <p className="muted">Quiz bowl practice: questions read word by word, and you race to buzz in. Play with friends or on your own.<Info term="tossup" /></p>

        <label className="field">
          <span>Your name</span>
          <div className="row gap">
            <input className="grow" value={name} maxLength={24} placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" title="Pick a random name" aria-label="Pick a random name" onClick={() => setName(randomName())}><Icon name="dice" /></button>
          </div>
        </label>

        {shared && !initialCode && (
          <SharedPresetCard preset={shared} busy={busy || !connected}
            onCreate={() => { const p = shared.settings; dropShared(); void run(() => onCreate(name.trim(), false, p)); }} onDismiss={dropShared} />
        )}

        {initialCode ? (
          <button className="btn primary big" disabled={busy || !connected} onClick={() => run(() => onJoin(initialCode, name.trim()))}>
            Join room {initialCode}
          </button>
        ) : (
          <div className="choices">
            <ChoiceCard icon="users" title="Play with friends" sub="Make a room and invite people, or join one with a code." open={open === 'friends'} onToggle={() => toggle('friends')}>
              <button className="btn primary big" disabled={busy || !connected} onClick={() => run(() => onCreate(name.trim(), false))}>Create a room</button>
              <p className="muted small">You’ll get a link and QR code to invite people. You pick the rules before starting.</p>
              <div className="divider"><span>or join with a code</span></div>
              <form className="row gap" onSubmit={(e) => { e.preventDefault(); run(() => onJoin(code.trim().toUpperCase(), name.trim())); }}>
                <input className="grow code-input" value={code} maxLength={8} placeholder="ABCD" aria-label="Room code" onChange={(e) => setCode(e.target.value.toUpperCase())} />
                <button className="btn" disabled={busy || !connected || code.trim().length < 4}>Join</button>
              </form>
            </ChoiceCard>

            <ChoiceCard icon="user" title="Play solo" sub="Practice at your own pace, or see how long you survive." open={open === 'solo'} onToggle={() => toggle('solo')}>
              <button className="btn primary big" disabled={busy || !connected} onClick={() => run(() => onCreate(name.trim(), true))}>Practice</button>
              <p className="muted small">Questions just for you. In the room you can add computer opponents and pick topics.</p>
              <div className="choice-sub-head">Survival<Info term="survival" /></div>
              <SurvivalCard busy={busy} connected={connected} onPlay={() => run(() => onSurvival(name.trim()))} openOnLoad={survivalOpen} />
            </ChoiceCard>

            <ChoiceCard icon="calendar" title="Today’s challenge" sub="One short set for everyone, new every day. See how you rank." open={open === 'daily'} onToggle={() => toggle('daily')}>
              <DailyCard busy={busy} connected={connected} onPlay={() => run(() => onDaily(name.trim()))} openOnLoad={dailyOpen} />
              <p className="muted small">You get one try per day; it resets at midnight US Eastern.<Info term="daily" /></p>
            </ChoiceCard>
          </div>
        )}
        {!connected && <p className="warn">Connecting to server…</p>}
        {(err || error) && <p className="error">{err || error}</p>}

        <footer className="home-foot">
          <nav className="home-links" aria-label="More">
            <button className="link" onClick={() => setTour(true)}>How to play</button>
            <span aria-hidden="true">·</span>
            <a className="link" href="/leaderboards">Leaderboards</a>
            <span aria-hidden="true">·</span>
            <a className="link" href="/help">Help</a>
            <span aria-hidden="true">·</span>
            <button className="link" onClick={() => setFeedback(true)}>Feedback</button>
            <span aria-hidden="true">·</span>
            <a className="link" href="/privacy">Privacy</a>
          </nav>
          <InstallButton />
          <p className="muted small">Questions from <a href="https://www.qbreader.org" target="_blank" rel="noreferrer">QBReader</a> and Trivio’s own built-in set.</p>
        </footer>
      </div>
      {tour && <Tutorial onClose={() => setTour(false)} onPlay={initialCode ? undefined : () => run(() => onCreate(name.trim(), true))} />}
      {feedback && <SendFeedback where="home" name={name.trim()} onClose={() => setFeedback(false)} />}
      <FriendsTab disabled={busy || !connected} onJoin={(c) => run(() => onJoin(c, name.trim()))} />
      <PhoneTabs active="play" />
    </div>
  );
}

/** One of the three big choices on the home screen. Tap to open its options; only one is open at a time. */
function ChoiceCard({ icon, title, sub, open, onToggle, children }: { icon: IconName; title: string; sub: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className={`choice ${open ? 'open' : ''}`}>
      <button className="choice-head" aria-expanded={open} onClick={onToggle}>
        <span className="choice-icon"><Icon name={icon} /></span>
        <span className="choice-text"><b>{title}</b><small>{sub}</small></span>
        <Icon name="next" className="choice-chev" />
      </button>
      {open && <div className="choice-body">{children}</div>}
    </section>
  );
}
