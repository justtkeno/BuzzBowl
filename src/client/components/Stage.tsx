import { TOPIC_BY_NAME } from '../../shared/topics';
import { CategoryChip } from './CategoryChip';
import { useEffect, useRef, useState } from 'react';
import type { BuzzMarker, PublicState, Verdict } from '../../shared/types';
import { DIFFICULTIES, VOTE_SECONDS, buzzWindowSeconds } from '../../shared/types';
import { socket } from '../socket';
import { play } from '../sounds';
import { readAloudActive, setSpeechOn, speechSupported, useSpeechOn } from '../speech';
import { act, colorFor, isTouch, resultLabel, roles, useNow, vibrate } from './util';
import { ReportQuestion } from './Report';
import { Icon } from './Icon';

export function Stage({ s }: { s: PublicState }) {
  const r = roles(s);
  const t = s.tossup;
  const inBonus = s.phase === 'bonus' && s.bonus;
  const myTeamLocked = !!r.myTeam && !!t?.lockedTeamIds.includes(r.myTeam);
  const canBuzz = s.phase === 'reading' && !!t && !r.isReader && !!r.myTeam && !myTeamLocked && !s.paused;
  const iAmAnswering = s.phase === 'buzz' && s.buzz?.playerId === r.me && !s.buzz.awaitingRuling;
  const bonusDone = s.phase === 'bonus' && s.bonus?.done;
  // The site admin can move things along in any room.
  const isAdmin = !!s.players.find((p) => p.id === r.me)?.admin;
  const canSkip = r.isController || isAdmin;
  // The set game length is reached: moving on shows the results instead of another tossup.
  const lastOne = !s.daily && s.settings.gameLength > 0 && (t?.num ?? 0) >= s.settings.gameLength;
  const canNext = (r.canDirect || isAdmin) && (s.phase === 'tossupEnd' || !!bonusDone) && !s.vote;
  const [buzzing, setBuzzing] = useState(false);
  // Phones only open the keyboard when focus happens inside a tap, but the answer box appears a moment
  // later (after the server awards the buzz). Focusing this hidden input during the tap opens the keyboard
  // early; the answer box then takes focus and the keyboard stays up.
  const keeper = useRef<HTMLInputElement>(null);

  useEffect(() => setBuzzing(false), [s.phase, t?.num]);
  // A buzz the server didn't award (someone was faster) lets go after a moment.
  useEffect(() => {
    if (!buzzing) return;
    const h = setTimeout(() => {
      setBuzzing(false);
      // Not awarded: put the keyboard away again.
      if (document.activeElement === keeper.current) keeper.current?.blur();
    }, 1500);
    return () => clearTimeout(h);
  }, [buzzing]);
  useEffect(() => {
    if (s.phase !== 'buzz' || s.buzz?.playerId !== r.me) keeper.current?.blur();
  }, [s.phase, s.buzz?.playerId]);

  // Phones: open the keyboard inside the tap itself (iOS only allows it there). Runs on press and on click,
  // since some browsers only count the click as the tap.
  const openKeyboard = () => {
    if (!isTouch() || !canBuzz || !keeper.current || document.activeElement === keeper.current) return;
    keeper.current.value = '';
    keeper.current.focus({ preventScroll: true });
  };
  const buzz = (e?: { preventDefault(): void }) => {
    openKeyboard();
    if (!canBuzz || buzzing || !t) return;
    e?.preventDefault();
    setBuzzing(true);
    vibrate(25);
    act('buzz', t.revealed.length);
  };

  // Keyboard: Space buzzes (reader: pause/resume), N = next, → = reader advances a word.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (r.isReader && s.phase === 'reading' && t) act('game:pause', !t.paused);
        else buzz();
      } else if (e.key === 'n' || e.key === 'N') {
        if (canNext || s.vote || (canSkip && !s.survival && (s.phase === 'reading' || s.phase === 'bonus'))) act('game:next');
      } else if (s.vote && /^[1-9]$/.test(e.key) && s.vote.options[Number(e.key) - 1]) {
        act('vote', s.vote.options[Number(e.key) - 1]);
      } else if (e.key === 'ArrowRight' && r.isController && s.phase === 'reading' && t) {
        act('game:revealTo', t.revealed.length + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="stage">
      {s.phase === 'loading' && <QuestionSkeleton />}
      {t && !inBonus && s.phase !== 'loading' && <TossupCard key={`t${s.tossup!.num}`} s={s} />}
      {inBonus && <BonusCard key={`b${s.bonus!.num}`} s={s} />}

      <div className="actionbar">
        <input ref={keeper} className="keyboard-keeper" aria-hidden="true" tabIndex={-1} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        {iAmAnswering && (
          <AnswerBox key={`${t?.num}-${s.buzz?.prompts}`} event="answer:submit" keeper={keeper} deadline={s.buzz!.deadline} total={s.buzz!.prompts ? 5 : s.settings.answerSeconds}
            prompted={s.buzz!.prompts > 0} lastGiven={t?.buzzes.filter((b) => b.playerId === r.me).at(-1)?.given} paused={s.paused} />
        )}
        {s.buzz?.awaitingRuling && r.isReader && <RulingBox given={s.buzz.awaitingRuling.given} suggestion={s.buzz.awaitingRuling.suggestion} />}
        {s.phase === 'reading' && !r.isReader && (
          <button className={`buzzer ${canBuzz ? '' : 'disabled'} ${buzzing ? 'pressed' : ''}`} onPointerDown={buzz} onTouchEnd={openKeyboard} onClick={() => buzz()} disabled={!canBuzz}>
            {!r.myTeam ? 'Spectating' : myTeamLocked ? 'Locked out' : s.paused ? 'Paused' : buzzing ? '…' : 'BUZZ'}
            <small>{canBuzz ? (isTouch() ? 'tap' : 'Space / tap') : ''}</small>
          </button>
        )}
        {r.isController && t && s.phase === 'reading' && !r.fixed && <ReaderControls s={s} />}
        {isAdmin && !r.isController && t && s.phase === 'reading' && !s.survival && <button className="btn ghost" onClick={() => act('game:next')}>Skip tossup</button>}
        {canSkip && !s.survival && (s.phase === 'buzz' || (s.phase === 'bonus' && !bonusDone)) && (
          <button className="btn ghost" onClick={() => act('game:next')}>Skip {s.phase === 'bonus' ? 'bonus' : 'tossup'}</button>
        )}
        {canNext && (
          <button className="btn primary big next-btn" onClick={() => act('game:next')} disabled={s.paused}>
            {s.survival?.done ? 'See results' : s.phase === 'tossupEnd' && s.tossup?.bonusTeamId ? 'Read bonus' : lastOne ? 'Finish game' : s.settings.source === 'lightning' ? 'Next question' : 'Next tossup'} <kbd>N</kbd>
          </button>
        )}
        {s.vote && <VotePanel s={s} />}
        {!r.canDirect && (s.phase === 'tossupEnd' || bonusDone) && <p className="muted">Waiting for the reader to continue…</p>}
      </div>
    </div>
  );
}

/** Between tossups in party mode: pick the next topic. Starts when everyone has voted, time runs out, or someone taps Start now. */
function VotePanel({ s }: { s: PublicState }) {
  const v = s.vote!;
  const canVote = !!roles(s).myTeam;
  return (
    <div className="vote" role="group" aria-label="Vote on the next topic">
      <div className="vote-head">
        <span>Next topic <span className="muted small">· {v.voted}/{v.voters} voted</span></span>
        <button className="btn ghost small" onClick={() => act('game:next')} disabled={s.paused}>Start now</button>
      </div>
      <div className="vote-options">
        {v.options.map((o, i) => (
          <button key={o} className={`vote-opt ${v.mine === o ? 'on' : ''}`} disabled={!canVote || s.paused} onClick={() => act('vote', o)} aria-pressed={v.mine === o}>
            <span className="vote-name">{TOPIC_BY_NAME.get(o) ? `${TOPIC_BY_NAME.get(o)!.icon} ` : ''}{o}</span>
            <span className="vote-count">{v.counts[o] ? v.counts[o] : ''}</span>
            {!isTouch() && <kbd>{i + 1}</kbd>}
          </button>
        ))}
      </div>
      <Countdown deadline={v.deadline} total={VOTE_SECONDS} frozen={s.paused} />
    </div>
  );
}

/** Shown while the next question loads: a faint outline of the question card instead of a line of text. */
export function QuestionSkeleton() {
  return (
    <div className="card tossup skel" role="status" aria-label="Loading question">
      <div className="meta"><span className="skel-bar" style={{ width: '4.5rem' }} /><span className="skel-bar" style={{ width: '6rem' }} /></div>
      <div className="skel-lines">
        <span className="skel-bar" /><span className="skel-bar" /><span className="skel-bar" style={{ width: '62%' }} />
      </div>
    </div>
  );
}

/** Hairline along the top of the question card: how much has been read. After the tossup, a tick marks the (*). */
function ReadLine({ read, total, power }: { read: number; total: number; power?: number | null }) {
  if (!total) return null;
  const pct = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
  return (
    <div className="read-line" aria-hidden="true">
      <div className="read-fill" style={{ width: pct(read) }} />
      {power != null && power > 0 && <span className="read-power" style={{ left: pct(power) }} />}
    </div>
  );
}

/** This device only: turn the read-aloud voice on or off. */
function SpeakerToggle() {
  const on = useSpeechOn();
  return (
    <button className={`speaker ${on ? 'on' : ''}`} onClick={() => setSpeechOn(!on)} aria-pressed={on}
      title={on ? 'Reading aloud on this device. Tap to mute.' : 'Muted on this device. Tap to read aloud.'}>
      {on ? 'Read aloud' : 'Muted'}
    </button>
  );
}

/** Time bar that goes green → yellow → red. With `ticks`, it also ticks each of the last 3 seconds. */
function Countdown({ deadline, total, ticks, frozen }: { deadline: number | null | undefined; total: number; ticks?: boolean; frozen?: boolean }) {
  const now = useNow(!!deadline && !frozen);
  const frozenAt = useRef<number | null>(null);
  if (frozen && frozenAt.current === null) frozenAt.current = now;
  if (!frozen) frozenAt.current = null;
  const left = deadline ? Math.max(0, deadline - (frozenAt.current ?? now)) : 0;
  const secs = Math.ceil(left / 1000);
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    if (!ticks || !deadline || frozen) return;
    if (secs > 0 && secs <= 3 && lastTick.current !== secs) { play('tick'); if (secs === 1) vibrate(15); }
    lastTick.current = secs;
  }, [secs, ticks, deadline, frozen]);
  if (!deadline) return null;
  const frac = Math.min(1, left / (total * 1000));
  const level = frac > 0.5 ? 'ok' : frac > 0.25 ? 'mid' : 'low';
  return (
    <div className={`countdown cd-${level}`} aria-label={`${secs} seconds left`}>
      <div className="cd-track"><div className="bar" style={{ width: `${frac * 100}%` }} /></div>
      <span>{(left / 1000).toFixed(1)}s</span>
    </div>
  );
}

/**
 * Where everyone buzzed, drawn on a strip the length of the question. The power zone is shaded,
 * and during reading a cursor shows how far the reader has got.
 */
export function BuzzMap({ buzzes, totalWords, powerIndex, revealed, order }: {
  buzzes: BuzzMarker[]; totalWords: number; powerIndex?: number | null; revealed?: number; order?: string[];
}) {
  if (!totalWords) return null;
  const pct = (i: number) => `${Math.min(100, (i / totalWords) * 100)}%`;
  return (
    <div className="buzzmap" role="img" aria-label={`Buzzes: ${buzzes.map((b) => `${b.playerName} at word ${b.wordIndex} of ${totalWords}`).join(', ') || 'none'}`}>
      <div className="bm-track">
        {powerIndex !== undefined && powerIndex !== null && <div className="bm-power" style={{ width: pct(powerIndex) }} />}
        {revealed !== undefined && <div className="bm-read" style={{ width: pct(revealed) }} />}
        {buzzes.map((b, i) => (
          <div key={i} className={`bm-pin r-${b.result}`} style={{ left: pct(b.wordIndex), ['--pc' as string]: colorFor(b.playerId, order) }} title={`${b.playerName}: ${b.given || '…'} (${resultLabel[b.result]})`}>
            <span className="bm-dot" />
            <span className="bm-name">{b.playerName.split(' ')[0]} <b>{resultLabel[b.result]}</b></span>
          </div>
        ))}
      </div>
      <div className="bm-scale"><span>start</span>{powerIndex ? <span className="bm-star" style={{ left: pct(powerIndex) }}>(*)</span> : null}<span>end</span></div>
    </div>
  );
}

export function TossupCard({ s }: { s: PublicState }) {
  const r = roles(s);
  const t = s.tossup!;
  const ended = s.phase === 'tossupEnd' || s.phase === 'gameOver';
  const teleprompter = r.isReader && !ended && t.words;
  const bottomRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [t.revealed.length]);

  const markersAt = (i: number) => t.buzzes.filter((b) => b.wordIndex === i);
  const words = ended || teleprompter ? t.words ?? t.revealed : t.revealed;
  const hidden = !t.textVisible && !ended && !teleprompter;

  return (
    <div className={`card tossup ${s.phase === 'reading' ? 'is-live' : ''}`}>
      {!hidden && <ReadLine read={ended ? t.totalWords : t.revealed.length} total={t.totalWords} power={ended ? t.powerIndex : null} />}
      <div className="meta">
        <span className="tag">{s.settings.source === 'lightning' ? <><Icon name="bolt" /> Lightning {t.num}</> : `Tossup ${t.num}`}{!s.daily && !s.survival && s.settings.gameLength ? ` of ${s.settings.gameLength}` : ''}</span>
        {t.topic ? <CategoryChip category={t.topic.name} icon={t.topic.icon} /> : <CategoryChip category={t.category} sub={t.subcategory} />}
        {t.difficulty ? <span className="muted">{DIFFICULTIES[t.difficulty] ?? `Level ${t.difficulty}`}</span> : null}
        {t.setName && <span className="muted hide-sm">{t.setName}{t.year ? ` (${t.year})` : ''}</span>}
        {readAloudActive(s) && speechSupported() && <SpeakerToggle />}
      </div>

      {hidden ? (
        <div className="listen">
          <div className="listen-icon"><Icon name="mic" /></div>
          <p>Listen to the reader{s.readerId ? ` (${s.players.find((p) => p.id === s.readerId)?.name})` : ''}. Buzz when you know it.</p>
          <div className="progress"><div style={{ width: `${(t.revealed.length / Math.max(1, t.totalWords)) * 100}%` }} /></div>
          <BuzzMap buzzes={t.buzzes} totalWords={t.totalWords} revealed={t.revealed.length} order={s.players.map((p) => p.id)} />
        </div>
      ) : (
        <p className={`qtext ${teleprompter ? 'prompter' : ''}`}>
          {words.map((w, i) => {
            const read = i < t.revealed.length;
            const inPower = t.powerIndex !== undefined && t.powerIndex !== null && i < t.powerIndex;
            const cls = [teleprompter && !read ? 'unread' : '', teleprompter && i === t.revealed.length - 1 ? 'cursor' : '', (ended || teleprompter) && inPower ? 'power' : '', !teleprompter ? 'w' : ''].join(' ');
            return (
              <span key={i}>
                {markersAt(i).map((m, j) => <Marker key={j} m={m} />)}
                {(ended || teleprompter) && t.powerIndex === i && <span className="pmark">(*)</span>}
                <span className={cls} onClick={teleprompter && !read ? () => act('game:revealTo', i + 1) : undefined} title={teleprompter && !read ? 'Jump the cursor here' : undefined}>{w}</span>{' '}
              </span>
            );
          })}
          {markersAt(words.length).map((m, j) => <Marker key={`e${j}`} m={m} />)}
          {!ended && !teleprompter && t.revealed.length < t.totalWords && <span className="caret" />}
          <span ref={bottomRef} />
        </p>
      )}

      {(ended || r.isReader) && t.answerHtml && (
        <div className="answer">
          <span className="label">ANSWER</span> <span dangerouslySetInnerHTML={{ __html: t.answerHtml }} />
          {ended && s.review.some((x) => x.num === t.num) && <> <ReportQuestion s={s} num={t.num} /></>}
        </div>
      )}
      {!ended && !r.isReader && s.peek?.tossup && (
        <div className="peek" title="Only you can see this"><Icon name="eye" /> <span dangerouslySetInnerHTML={{ __html: s.peek.tossup }} /></div>
      )}
      {ended && t.buzzes.length > 0 && <BuzzMap buzzes={t.buzzes} totalWords={t.totalWords} powerIndex={t.powerIndex} order={s.players.map((p) => p.id)} />}

      {s.phase === 'reading' && t.deadline && !t.paused && (
        <div className="status"><span>Last chance to buzz</span><Countdown deadline={t.deadline} total={buzzWindowSeconds(s.settings)} frozen={s.paused} /></div>
      )}
      {s.phase === 'reading' && t.paused && <div className="status muted">Paused{r.isReader ? ' — press Space to resume' : ' by the reader'}</div>}
      {s.buzz && <BuzzStatus s={s} />}
      {ended && <EndSummary s={s} />}
      {ended && t.answerKey && t.answerKey.misses.length > 0 && <WhyWrong k={t.answerKey} />}
    </div>
  );
}

const WHY: Record<'rejected' | 'prompt' | 'wrong', string> = {
  rejected: 'That one is on the answer line’s do-not-accept list.',
  prompt: 'That was close: it would only have been prompted. It needed more detail.',
  wrong: 'That didn’t match any accepted answer.',
};

/** After you miss: what you said, why it missed, and what the answer line would have taken. */
function WhyWrong({ k }: { k: NonNullable<PublicState['tossup']>['answerKey'] & {} }) {
  const [open, setOpen] = useState(false);
  const list = (label: string, items: string[], cls = '') => items.length > 0 && (
    <div className={`why-row ${cls}`}><span className="why-label">{label}</span><span>{items.join(' · ')}</span></div>
  );
  return (
    <div className="why">
      {k.misses.map((m, i) => (
        <div key={i} className="why-miss">
          <span className="muted">You said</span> <b>“{m.given}”</b>. <span>{WHY[m.why]}</span>
        </div>
      ))}
      {list('Accepted', k.accept, 'ok')}
      {open ? (
        <>
          {list('Prompt on', k.prompt)}
          {list('Not accepted', k.reject, 'bad')}
        </>
      ) : (k.prompt.length > 0 || k.reject.length > 0) && (
        <button className="btn ghost small why-more" onClick={() => setOpen(true)}>Show prompts and rejects</button>
      )}
    </div>
  );
}

function Marker({ m }: { m: BuzzMarker }) {
  return <span className={`marker m-${m.result}`} style={{ ['--pc' as string]: colorFor(m.playerId) }} title={`${m.playerName}: ${m.given || '…'}`}>{m.playerName} {resultLabel[m.result]}</span>;
}

function BuzzStatus({ s }: { s: PublicState }) {
  const b = s.buzz!;
  const mine = b.playerId === s.you;
  return (
    <div className="status buzz-status" style={{ ['--pc' as string]: colorFor(b.playerId) }}>
      <span><span className="who-dot" /><b>{mine ? 'You' : b.playerName}</b> buzzed{b.prompts ? ' — prompted, say more' : ''}</span>
      {!mine && <span className="typing">{b.awaitingRuling ? `“${b.awaitingRuling.given}”` : b.typing ? `“${b.typing}”` : '…'}</span>}
      {b.awaitingRuling ? <span className="muted">Waiting for the reader’s ruling</span> : !mine && <Countdown deadline={b.deadline} total={b.prompts ? 5 : s.settings.answerSeconds} frozen={s.paused} />}
    </div>
  );
}

function EndSummary({ s }: { s: PublicState }) {
  const t = s.tossup!;
  const winner = t.buzzes.find((b) => b.result === 'power' || b.result === 'ten');
  return (
    <div className="end-line">
      {winner ? <span><b>{winner.playerName}</b> got it for {winner.result === 'power' ? s.settings.powerValue : s.settings.tenValue}{winner.given ? ` with “${winner.given}”` : ''}.{winner.correctedTo && <span className="corrected"> Close enough: read as <b>{winner.correctedTo}</b>.</span>}</span> : <span className="muted">Dead tossup — nobody got it.</span>}
      {t.buzzes.filter((b) => b.result === 'neg' || b.result === 'zero').map((b, i) => (
        <span key={i} className="muted"> {b.playerName}: “{b.given || '—'}” ({b.result === 'neg' ? 'neg' : 'no points'})</span>
      ))}
    </div>
  );
}

function AnswerBox({ event, deadline, total, prompted, placeholder, lastGiven, paused, keeper }: {
  event: string; deadline: number | null; total?: number; prompted: boolean; placeholder?: string; lastGiven?: string; paused?: boolean;
  /** The hidden input that opened the phone keyboard on the buzz tap; anything typed into it carries over. */
  keeper?: React.RefObject<HTMLInputElement>;
}) {
  const [text, setText] = useState(() => {
    const early = keeper?.current?.value ?? '';
    if (keeper?.current) keeper.current.value = '';
    if (early) socket.emit('answer:typing', early);
    return early;
  });
  const sent = useRef(false);
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    // Keep the box visible above the phone keyboard.
    const t = setTimeout(() => box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
    return () => clearTimeout(t);
  }, []);
  const submit = () => {
    if (sent.current) return;
    sent.current = true;
    act(event, text);
  };
  return (
    <form ref={box} className={`answerbox ${prompted ? 'prompted' : ''}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {prompted && (
        <div className="prompt-note">
          <b>Prompt — be more specific.</b>
          {lastGiven && <span> You said “{lastGiven}”.</span>}
        </div>
      )}
      <div className="row gap answer-row">
        <input ref={input} className="grow big" value={text} placeholder={placeholder ?? (prompted ? 'More specific answer…' : 'Type your answer')}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send" aria-label="Your answer"
          onChange={(e) => { setText(e.target.value); socket.emit('answer:typing', e.target.value); }} />
        <button className="btn primary big">Submit</button>
      </div>
      <Countdown deadline={deadline} total={total ?? (prompted ? 5 : 10)} ticks frozen={paused} />
      <div className="muted small hint">Spelling and accents don’t need to be exact.</div>
    </form>
  );
}

function RulingBox({ given, suggestion }: { given: string; suggestion: Verdict }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      const map: Record<string, Verdict> = { a: 'correct', p: 'prompt', r: 'incorrect' };
      const v = map[e.key.toLowerCase()];
      if (v) act('reader:rule', v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const label: Record<Verdict, string> = { correct: 'Accept', prompt: 'Prompt', incorrect: 'Reject' };
  return (
    <div className="ruling-box">
      <div>Player answered <b>“{given}”</b>. Auto-check suggests <span className={`sugg s-${suggestion}`}>{label[suggestion]}</span>.</div>
      <div className="row gap">
        <button className="btn ok" onClick={() => act('reader:rule', 'correct')}>Accept <kbd>A</kbd></button>
        <button className="btn" onClick={() => act('reader:rule', 'prompt')}>Prompt <kbd>P</kbd></button>
        <button className="btn bad" onClick={() => act('reader:rule', 'incorrect')}>Reject <kbd>R</kbd></button>
      </div>
    </div>
  );
}

function ReaderControls({ s }: { s: PublicState }) {
  const t = s.tossup!;
  const [wpm, setWpm] = useState(s.settings.wpm);
  // Lightning round with no reader shows each prompt all at once, so word-by-word controls don't apply.
  const instant = s.settings.source === 'lightning' && !roles(s).readerOnline;
  useEffect(() => setWpm(s.settings.wpm), [s.settings.wpm]);
  const [speedOpen, setSpeedOpen] = useState(false);
  const saveWpm = () => act('settings:update', { wpm });
  // A host who isn't reading aloud rarely needs these: a slim row of small buttons instead of the reader's panel.
  if (!roles(s).isReader) {
    return (
      <div className="host-tools" role="toolbar" aria-label="Host controls">
        <button className="btn ghost small icon" onClick={() => act('game:pause', !t.paused)} title={t.paused ? 'Resume reading (Space)' : 'Pause reading (Space)'} aria-label={t.paused ? 'Resume reading' : 'Pause reading'}>
          <Icon name={t.paused ? 'play' : 'pause'} />
        </button>
        {!instant && (
          <>
            <button className="btn ghost small icon" onClick={() => act('game:revealTo', t.revealed.length + 1)} disabled={t.revealed.length >= t.totalWords} title="Next word (→)" aria-label="Next word">
              <Icon name="next" />
            </button>
            <button className={`btn ghost small ${speedOpen ? 'on' : ''}`} onClick={() => setSpeedOpen(!speedOpen)} aria-expanded={speedOpen} title="Reading speed">{wpm} wpm</button>
            {speedOpen && (
              <input className="host-speed" type="range" min={100} max={600} step={10} value={wpm} aria-label="Reading speed"
                onChange={(e) => setWpm(Number(e.target.value))} onPointerUp={saveWpm} onKeyUp={saveWpm} />
            )}
          </>
        )}
        <button className="btn ghost small icon" onClick={() => act('game:next')} title="Skip this tossup (N)" aria-label="Skip this tossup">
          <Icon name="skip" />
        </button>
      </div>
    );
  }
  return (
    <div className="reader-controls">
      <button className="btn" onClick={() => act('game:pause', !t.paused)}>{t.paused ? <><Icon name="play" /> Resume</> : <><Icon name="pause" /> Pause</>} <kbd>Space</kbd></button>
      {!instant && (
        <>
          <button className="btn" onClick={() => act('game:revealTo', t.revealed.length + 1)} disabled={t.revealed.length >= t.totalWords}>Next word <kbd>→</kbd></button>
          <label className="wpm">
            <span>{wpm} wpm</span>
            <input type="range" min={100} max={600} step={10} value={wpm} onChange={(e) => setWpm(Number(e.target.value))}
              onPointerUp={saveWpm} onKeyUp={saveWpm} />
          </label>
        </>
      )}
      <button className="btn ghost" onClick={() => act('game:next')}>Skip <kbd>N</kbd></button>
    </div>
  );
}

export function BonusCard({ s }: { s: PublicState }) {
  const r = roles(s);
  const bn = s.bonus!;
  const mineTeam = r.myTeam === bn.teamId;
  const team = s.teams.find((t) => t.id === bn.teamId);
  const captainId = team?.captainId ?? bn.teamId;
  const iAmCaptain = captainId === r.me;
  const captainName = s.players.find((p) => p.id === captainId)?.name ?? 'captain';
  const answering = !bn.revealing && !bn.done && !bn.awaitingRuling;
  const parts = r.isReader && bn.readerParts ? bn.readerParts.map((p, i) => ({ ...p, ...bn.parts[i], text: p.text, readerAnswer: p.answerHtml })) : bn.parts;

  return (
    <div className="card bonus">
      <div className="meta">
        <span className="tag">Bonus {bn.num}</span>
        <span>{bn.category}</span>
        <span className="muted">for <b>{bn.teamName}</b></span>
      </div>
      {bn.leadin ? <p className="leadin">{bn.leadin}</p> : <p className="muted">Listen to the reader.</p>}
      <ol className="parts">
        {parts.map((p: any, i: number) => {
          const future = i > bn.current;
          const state = p.correct === true ? 'ok' : p.correct === false ? 'bad' : i === bn.current && !bn.done ? 'live' : '';
          return (
            <li key={i} className={`part ${state} ${future ? 'future' : ''}`}>
              <span className="pv">[{s.settings.bonusPartValue}]</span> {p.text || <span className="muted">(listen)</span>}
              {(p.answerHtml || p.readerAnswer) && (
                <div className="answer small"><span className="label">ANSWER</span> <span dangerouslySetInnerHTML={{ __html: p.answerHtml ?? p.readerAnswer }} /></div>
              )}
              {p.given !== undefined && <div className="given">{bn.teamName}: “{p.given || '—'}” {p.correct ? <Icon name="check" className="ok" /> : <Icon name="close" className="bad" />}{p.correctedTo && <span className="corrected"> read as <b>{p.correctedTo}</b></span>}</div>}
            </li>
          );
        })}
      </ol>

      {answering && (
        <div className="status">
          {iAmCaptain ? <span>You are captain — confer with your team, then submit.</span>
            : mineTeam ? <span>Talk it over in <b>team chat</b>. {captainName} submits{bn.typing ? `: “${bn.typing}”` : '.'}</span>
              : <span>{bn.teamName} is conferring{r.isReader && bn.typing ? `: “${bn.typing}”` : '…'}</span>}
          <Countdown deadline={bn.deadline} total={bn.prompts ? 5 : s.settings.bonusSeconds} ticks={mineTeam} frozen={s.paused} />
        </div>
      )}
      {iAmCaptain && answering && (
        <AnswerBox key={`${bn.num}-${bn.current}-${bn.prompts}`} event="bonus:submit" deadline={null} prompted={bn.prompts > 0} placeholder="Team answer" />
      )}
      {bn.awaitingRuling && (r.isReader
        ? <RulingBox given={bn.awaitingRuling.given} suggestion={bn.awaitingRuling.suggestion} />
        : <div className="status muted">“{bn.awaitingRuling.given}” — waiting for the reader’s ruling</div>)}
      {!r.isReader && !bn.revealing && !bn.done && s.peek?.bonus?.[bn.current] && (
        <div className="peek" title="Only you can see this"><Icon name="eye" /> <span dangerouslySetInnerHTML={{ __html: s.peek.bonus[bn.current] }} /></div>
      )}
      {bn.done && <div className="end-line">Bonus total: <b>{bn.parts.filter((p) => p.correct).length * s.settings.bonusPartValue}</b></div>}
    </div>
  );
}
