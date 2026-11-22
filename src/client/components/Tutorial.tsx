import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * How to play: four short cards, then a practice tossup that runs on this device only (it scores nothing,
 * so it can pause for hints; real games stay timed and ruled by the server).
 */
const SEEN = 'qb:tourSeen';
export const tourSeen = () => { try { return localStorage.getItem(SEEN) === '1'; } catch { return true; } };
export const markTourSeen = () => { try { localStorage.setItem(SEEN, '1'); } catch { /* private mode */ } };

const CARDS: { title: string; body: string; art: JSX.Element | null }[] = [
  {
    title: 'Questions are read word by word',
    body: 'Each tossup starts with its hardest clues and gets easier as it goes. The sooner you know it, the better.',
    art: <ReadArt />,
  },
  {
    title: 'Buzz the moment you know it',
    body: 'Tap BUZZ (or press Space). Reading stops for everyone and you get 10 seconds to type your answer. Spelling doesn’t need to be perfect.',
    art: <BuzzArt />,
  },
  {
    title: 'How scoring works',
    body: 'Right before the (*) mark is a power: 15 points. Right after it: 10. Wrong before the question finishes is a neg: −5. Wrong after it ends costs nothing. One buzz each per question.',
    art: <ScoreArt />,
  },
  {
    title: 'Ways to play',
    body: '',
    art: null, // the list has its own icons
  },
];

const PRACTICE = CARDS.length; // the practice tossup comes right after the cards
const DONE = PRACTICE + 1;

export function Tutorial({ onClose, onPlay }: { onClose: () => void; onPlay?: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => { markTourSeen(); }, []);
  const go = (n: number) => setStep(Math.max(0, Math.min(DONE, n)));

  // Swipe between the cards (not during the practice tossup, where taps matter).
  const touch = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { touch.current = step !== PRACTICE ? e.touches[0].clientX : null; };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touch.current === null) return;
    const dx = e.changedTouches[0].clientX - touch.current;
    touch.current = null;
    if (Math.abs(dx) > 50) go(step + (dx < 0 ? 1 : -1));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (step === PRACTICE || (e.target as HTMLElement).closest('input')) return;
      if (e.key === 'ArrowRight') go(step + 1);
      if (e.key === 'ArrowLeft') go(step - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal tutorial" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How to play" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="row between">
          <h2>How to play</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>

        <div className="tut-body" key={step}>
          {step < PRACTICE && (
            <div className="tut-card">
              {CARDS[step].art && <div className="tut-art" aria-hidden="true">{CARDS[step].art}</div>}
              <h3>{CARDS[step].title}</h3>
              {CARDS[step].body && <p>{CARDS[step].body}</p>}
              {step === PRACTICE - 1 && <WaysList />}
            </div>
          )}
          {step === PRACTICE && <Practice onDone={() => go(DONE)} />}
          {step === DONE && (
            <div className="tut-card">
              <div className="tut-art" aria-hidden="true"><Icon name="check" className="tut-big-icon" /></div>
              <h3>You’re ready</h3>
              <p>Start with solo practice to get the feel, or create a room and send friends the link.</p>
            </div>
          )}
        </div>

        <div className="tut-foot">
          <div className="tut-dots" aria-label={`Step ${step + 1} of ${DONE + 1}`}>
            {Array.from({ length: DONE + 1 }, (_, i) => (
              <button key={i} className={i === step ? 'on' : ''} onClick={() => go(i)} aria-label={`Go to step ${i + 1}`} />
            ))}
          </div>
          <div className="row gap">
            {step > 0 && step !== DONE && <button className="btn ghost" onClick={() => go(step - 1)}>Back</button>}
            {step < PRACTICE - 1 && <button className="btn primary" onClick={() => go(step + 1)}>Next</button>}
            {step === PRACTICE - 1 && <button className="btn primary" onClick={() => go(PRACTICE)}>Try a practice question</button>}
            {step === PRACTICE && <button className="btn ghost" onClick={() => go(DONE)}>Skip</button>}
            {step === DONE && (onPlay
              ? <><button className="btn ghost" onClick={onClose}>Close</button><button className="btn primary" onClick={() => { onClose(); onPlay(); }}>Play solo practice</button></>
              : <button className="btn primary" onClick={onClose}>Back to the game</button>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- the practice tossup ----------

const PRACTICE_TEXT = 'This planet’s two small moons, Phobos and Deimos, are named for sons of a war god. Its Olympus Mons is the tallest volcano in the solar system. Rovers named Curiosity and Perseverance have explored its (*) dusty surface, reddened by iron oxide. For 10 points, name this fourth planet from the Sun, often called the Red Planet.';
const WORDS = PRACTICE_TEXT.replace(' (*)', '').split(' ');
const POWER = PRACTICE_TEXT.split(' ').indexOf('(*)'); // words before the power mark
const WORD_MS = 330;
/** Where the reading pauses to nudge a player who hasn't buzzed yet (a few words before the power mark). */
const NUDGE_AT = POWER - 3;

/** Lenient check for the practice answer: "mars", "planet mars", or one typo away. */
function isMars(raw: string) {
  const words = raw.toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some((w) => w === 'mars' || (w.length >= 3 && w.length <= 5 && editDistance(w, 'mars') <= 1));
}
function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

type Phase = 'reading' | 'nudge' | 'answering' | 'result';
type Result = { kind: 'power' | 'ten' | 'neg' | 'zero' | 'none'; given: string; at: number };

function Practice({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<Phase>('reading');
  const [nudged, setNudged] = useState(false);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [left, setLeft] = useState(10);
  const input = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // Bring the result and its buttons into view (the question can fill the panel on a phone).
  useEffect(() => { if (phase === 'result') resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [phase]);

  // Reveal a word at a time while reading; pause once for the nudge; give 5 s after the last word.
  useEffect(() => {
    if (phase !== 'reading') return;
    if (shown >= WORDS.length) {
      const t = setTimeout(() => { setResult({ kind: 'none', given: '', at: shown }); setPhase('result'); }, 5000);
      return () => clearTimeout(t);
    }
    if (!nudged && shown === NUDGE_AT) { setNudged(true); setPhase('nudge'); return; }
    const t = setTimeout(() => setShown((n) => n + 1), WORD_MS);
    return () => clearTimeout(t);
  }, [phase, shown, nudged]);

  // The answer clock.
  useEffect(() => {
    if (phase !== 'answering') return;
    if (left <= 0) { submit(); return; }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  });

  const buzz = () => {
    if (phase !== 'reading' && phase !== 'nudge') return;
    setPhase('answering');
    setLeft(10);
    setTimeout(() => input.current?.focus(), 0);
  };
  const submit = () => {
    if (phase !== 'answering') return;
    const right = isMars(answer);
    const kind = right ? (shown <= POWER ? 'power' : 'ten') : shown < WORDS.length ? 'neg' : 'zero';
    setResult({ kind, given: answer.trim(), at: shown });
    setPhase('result');
  };
  const again = () => { setShown(0); setPhase('reading'); setNudged(false); setAnswer(''); setResult(null); };

  const ended = phase === 'result';
  const hint = phase === 'nudge' ? 'Know it? Tap BUZZ now. Buzzing this early, before the power mark, scores 15.'
    : phase === 'answering' ? 'Reading has stopped. Type your answer and press Enter.'
    : phase === 'reading' && shown < 8 ? 'Words appear as they’re read. The first clues are the hardest.'
    : phase === 'reading' ? 'Buzz whenever you know it.'
    : '';

  return (
    <div className="tut-practice">
      {hint && <p className="tut-hint" role="status">{hint}</p>}
      <div className="card tossup tut-q">
        <div className="meta"><span className="tag">Practice</span><span className="muted">Science · Astronomy</span></div>
        <p className="qtext">
          {(ended ? WORDS : WORDS.slice(0, shown)).map((w, i) => (
            <span key={i}>
              {ended && i === POWER && <span className="pmark">(*)</span>}
              <span className={ended && i < POWER ? 'power' : ''}>{w}</span>{' '}
            </span>
          ))}
          {!ended && <span className="caret" />}
        </p>
        {ended && <div className="answer"><span className="label">ANSWER</span> <b><u>Mars</u></b></div>}
      </div>

      {(phase === 'reading' || phase === 'nudge') && (
        <div className="row gap">
          <button className="buzzer tut-buzzer" onPointerDown={(e) => { e.preventDefault(); buzz(); }} onClick={buzz}>BUZZ</button>
          {phase === 'nudge' && <button className="btn ghost" onClick={() => setPhase('reading')}>Keep reading</button>}
        </div>
      )}
      {phase === 'answering' && (
        <form className="answerbox" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="row gap answer-row">
            <input ref={input} className="big grow" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <button className="btn primary">Submit</button>
          </div>
          <span className="muted small">{left}s left · spelling doesn’t need to be exact</span>
        </form>
      )}
      {ended && result && (
        <div ref={resultRef} className={`tut-result r-${result.kind}`} role="status">
          <b>{{ power: 'Power! +15', ten: 'Correct! +10', neg: 'Neg: −5', zero: 'Not quite: 0', none: 'Time’s up' }[result.kind]}</b>
          <span>
            {result.kind === 'power' && ' You buzzed before the (*), so it’s worth extra. Bold text is the power zone.'}
            {result.kind === 'ten' && ' You got it after the (*). Buzz before it, while the text is still bold, for 15.'}
            {result.kind === 'neg' && ` “${result.given || '(blank)'}” wasn’t it, and wrong answers before the question ends cost 5 points.`}
            {result.kind === 'zero' && ` “${result.given || '(blank)'}” wasn’t it. The question had finished, so it costs nothing.`}
            {result.kind === 'none' && ' Nobody buzzed. In a real game the answer is shown and the next tossup starts.'}
          </span>
          <div className="row gap">
            <button className="btn" onClick={again}>Try again</button>
            <button className="btn primary" onClick={onDone}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- drawings (thin lines in the text color, accent for the one thing that matters) ----------

function ReadArt() {
  return (
    <svg viewBox="0 0 160 86">
      <rect x="6" y="6" width="148" height="74" rx="10" className="ta-line" />
      <path d="M22 28h34M62 28h22M90 28h30" className="ta-text" />
      <path d="M22 44h26M54 44h30" className="ta-text" />
      <path d="M90 38v12" className="ta-accent" />
      <path d="M22 60h40M68 60h28M102 60h34" className="ta-faint" />
    </svg>
  );
}
function BuzzArt() {
  return (
    <svg viewBox="0 0 160 86">
      <rect x="30" y="30" width="100" height="40" rx="12" className="ta-accent-fill" />
      <text x="80" y="56" textAnchor="middle" className="ta-label">BUZZ</text>
      <path d="M122 22a12 12 0 0 1 10 10M126 14a22 22 0 0 1 16 16" className="ta-accent" />
    </svg>
  );
}
function ScoreArt() {
  return (
    <svg viewBox="0 0 160 86">
      <rect x="10" y="40" width="140" height="8" rx="4" className="ta-faint-fill" />
      <rect x="10" y="40" width="84" height="8" rx="4" className="ta-power-fill" />
      <path d="M94 32v24" className="ta-power" />
      <text x="94" y="26" textAnchor="middle" className="ta-small ta-power-text">(*)</text>
      <text x="52" y="70" textAnchor="middle" className="ta-small">15</text>
      <text x="122" y="70" textAnchor="middle" className="ta-small">10</text>
      <text x="80" y="84" textAnchor="middle" className="ta-tiny">wrong before the end: −5</text>
    </svg>
  );
}
const WAYS: { icon: IconName; name: string; what: string }[] = [
  { icon: 'users', name: 'Create room', what: 'play live with friends: share the link or QR code' },
  { icon: 'play', name: 'Solo practice', what: 'just you (add bots to race against)' },
  { icon: 'flag', name: 'Daily challenge', what: 'the same 10 tossups for everyone, once a day' },
  { icon: 'bolt', name: 'Survival', what: 'keep going until you miss three' },
  { icon: 'users', name: 'Party mode', what: 'everyone for themselves, and players vote on the next topic' },
];
function WaysList() {
  return (
    <ul className="tut-ways">
      {WAYS.map((w) => <li key={w.name}><Icon name={w.icon} /><span><b>{w.name}</b> · {w.what}</span></li>)}
    </ul>
  );
}
