import { useEffect, useRef, useState } from 'react';
import type { BuzzMarker, PublicState, Verdict } from '../../shared/types';
import { DIFFICULTIES } from '../../shared/types';
import { socket } from '../socket';
import { act, resultLabel, roles, useNow } from './util';

export function Stage({ s }: { s: PublicState }) {
  const r = roles(s);
  const t = s.tossup;
  const inBonus = s.phase === 'bonus' && s.bonus;
  const myTeamLocked = !!r.myTeam && !!t?.lockedTeamIds.includes(r.myTeam);
  const canBuzz = s.phase === 'reading' && !!t && !r.isReader && !!r.myTeam && !myTeamLocked;
  const iAmAnswering = s.phase === 'buzz' && s.buzz?.playerId === r.me && !s.buzz.awaitingRuling;
  const bonusDone = s.phase === 'bonus' && s.bonus?.done;
  const canNext = r.canDirect && (s.phase === 'tossupEnd' || !!bonusDone);
  const [buzzing, setBuzzing] = useState(false);

  useEffect(() => setBuzzing(false), [s.phase, t?.num]);

  const buzz = () => {
    if (!canBuzz || buzzing || !t) return;
    setBuzzing(true);
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
        if (canNext || (r.isController && (s.phase === 'reading' || s.phase === 'bonus'))) act('game:next');
      } else if (e.key === 'ArrowRight' && r.isController && s.phase === 'reading' && t) {
        act('game:revealTo', t.revealed.length + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="stage">
      {s.phase === 'loading' && <div className="card center muted">Loading question…</div>}
      {t && !inBonus && s.phase !== 'loading' && <TossupCard s={s} />}
      {inBonus && <BonusCard s={s} />}

      <div className="actionbar">
        {iAmAnswering && <AnswerBox key={`${t?.num}-${s.buzz?.prompts}`} event="answer:submit" deadline={s.buzz!.deadline} prompted={s.buzz!.prompts > 0} />}
        {s.buzz?.awaitingRuling && r.isReader && <RulingBox given={s.buzz.awaitingRuling.given} suggestion={s.buzz.awaitingRuling.suggestion} />}
        {s.phase === 'reading' && !r.isReader && (
          <button className={`buzzer ${canBuzz ? '' : 'disabled'}`} onPointerDown={buzz} onClick={buzz} disabled={!canBuzz}>
            {!r.myTeam ? 'Spectating' : myTeamLocked ? 'Locked out' : buzzing ? '…' : 'BUZZ'}
            <small>{canBuzz ? 'Space / tap' : ''}</small>
          </button>
        )}
        {r.isController && t && s.phase === 'reading' && <ReaderControls s={s} />}
        {r.isController && (s.phase === 'buzz' || (s.phase === 'bonus' && !bonusDone)) && (
          <button className="btn ghost" onClick={() => act('game:next')}>Skip {s.phase === 'bonus' ? 'bonus' : 'tossup'}</button>
        )}
        {canNext && (
          <button className="btn primary big" onClick={() => act('game:next')} autoFocus>
            {s.phase === 'tossupEnd' && s.tossup?.bonusTeamId ? 'Read bonus' : 'Next tossup'} <kbd>N</kbd>
          </button>
        )}
        {!r.canDirect && (s.phase === 'tossupEnd' || bonusDone) && <p className="muted">Waiting for the reader to continue…</p>}
      </div>
    </div>
  );
}

function Countdown({ deadline, total }: { deadline: number | null | undefined; total: number }) {
  const now = useNow(!!deadline);
  if (!deadline) return null;
  const left = Math.max(0, deadline - now);
  return (
    <div className="countdown" aria-label={`${Math.ceil(left / 1000)} seconds left`}>
      <div className="bar" style={{ width: `${Math.min(100, (left / (total * 1000)) * 100)}%` }} />
      <span>{(left / 1000).toFixed(1)}s</span>
    </div>
  );
}

function TossupCard({ s }: { s: PublicState }) {
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
    <div className="card tossup">
      <div className="meta">
        <span className="tag">Tossup {t.num}</span>
        <span>{t.category}{t.subcategory && t.subcategory !== t.category ? ` · ${t.subcategory}` : ''}</span>
        {t.difficulty ? <span className="muted">{DIFFICULTIES[t.difficulty] ?? `Level ${t.difficulty}`}</span> : null}
        {t.setName && <span className="muted hide-sm">{t.setName}{t.year ? ` (${t.year})` : ''}</span>}
      </div>

      {hidden ? (
        <div className="listen">
          <div className="listen-icon">🎙</div>
          <p>Listen to the reader{s.readerId ? ` (${s.players.find((p) => p.id === s.readerId)?.name})` : ''}. Buzz when you know it.</p>
          <div className="progress"><div style={{ width: `${(t.revealed.length / Math.max(1, t.totalWords)) * 100}%` }} /></div>
          <div className="buzz-row">{t.buzzes.map((b, i) => <Marker key={i} m={b} />)}</div>
        </div>
      ) : (
        <p className={`qtext ${teleprompter ? 'prompter' : ''}`}>
          {words.map((w, i) => {
            const read = i < t.revealed.length;
            const inPower = t.powerIndex !== undefined && t.powerIndex !== null && i < t.powerIndex;
            const cls = [teleprompter && !read ? 'unread' : '', teleprompter && i === t.revealed.length - 1 ? 'cursor' : '', (ended || teleprompter) && inPower ? 'power' : ''].join(' ');
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
        <div className="answer"><span className="label">ANSWER</span> <span dangerouslySetInnerHTML={{ __html: t.answerHtml }} /></div>
      )}

      {s.phase === 'reading' && t.deadline && !t.paused && (
        <div className="status"><span>Last chance to buzz</span><Countdown deadline={t.deadline} total={s.settings.deadSeconds} /></div>
      )}
      {s.phase === 'reading' && t.paused && <div className="status muted">Paused{r.isReader ? ' — press Space to resume' : ' by the reader'}</div>}
      {s.buzz && <BuzzStatus s={s} />}
      {ended && <EndSummary s={s} />}
    </div>
  );
}

function Marker({ m }: { m: BuzzMarker }) {
  return <span className={`marker m-${m.result}`} title={`${m.playerName}: ${m.given || '…'}`}>{m.playerName} {resultLabel[m.result]}</span>;
}

function BuzzStatus({ s }: { s: PublicState }) {
  const b = s.buzz!;
  const mine = b.playerId === s.you;
  return (
    <div className="status buzz-status">
      <span><b>{mine ? 'You' : b.playerName}</b> buzzed{b.prompts ? ' — prompted, say more' : ''}</span>
      {!mine && <span className="typing">{b.awaitingRuling ? `“${b.awaitingRuling.given}”` : b.typing ? `“${b.typing}”` : '…'}</span>}
      {b.awaitingRuling ? <span className="muted">Waiting for the reader’s ruling</span> : <Countdown deadline={b.deadline} total={b.prompts ? 5 : s.settings.answerSeconds} />}
    </div>
  );
}

function EndSummary({ s }: { s: PublicState }) {
  const t = s.tossup!;
  const winner = t.buzzes.find((b) => b.result === 'power' || b.result === 'ten');
  return (
    <div className="end-line">
      {winner ? <span><b>{winner.playerName}</b> got it for {winner.result === 'power' ? 15 : 10}{winner.given ? ` with “${winner.given}”` : ''}.</span> : <span className="muted">Dead tossup — nobody got it.</span>}
      {t.buzzes.filter((b) => b.result === 'neg' || b.result === 'zero').map((b, i) => (
        <span key={i} className="muted"> {b.playerName}: “{b.given || '—'}” ({b.result === 'neg' ? 'neg' : 'no points'})</span>
      ))}
    </div>
  );
}

function AnswerBox({ event, deadline, prompted, placeholder }: { event: string; deadline: number | null; prompted: boolean; placeholder?: string }) {
  const [text, setText] = useState('');
  const sent = useRef(false);
  const submit = () => {
    if (sent.current) return;
    sent.current = true;
    act(event, text);
  };
  return (
    <form className="answerbox" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {prompted && <div className="prompt-note">Prompt: be more specific.</div>}
      <div className="row gap">
        <input autoFocus className="grow big" value={text} placeholder={placeholder ?? 'Type your answer, then Enter'} autoComplete="off" autoCapitalize="off" spellCheck={false}
          onChange={(e) => { setText(e.target.value); socket.emit('answer:typing', e.target.value); }} />
        <button className="btn primary big">Submit</button>
      </div>
      <Countdown deadline={deadline} total={prompted ? 5 : 7} />
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
  useEffect(() => setWpm(s.settings.wpm), [s.settings.wpm]);
  return (
    <div className="reader-controls">
      <button className="btn" onClick={() => act('game:pause', !t.paused)}>{t.paused ? '▶ Resume' : '❚❚ Pause'} <kbd>Space</kbd></button>
      <button className="btn" onClick={() => act('game:revealTo', t.revealed.length + 1)} disabled={t.revealed.length >= t.totalWords}>Next word <kbd>→</kbd></button>
      <label className="wpm">
        <span>{wpm} wpm</span>
        <input type="range" min={100} max={600} step={10} value={wpm} onChange={(e) => setWpm(Number(e.target.value))}
          onPointerUp={() => act('settings:update', { wpm })} onKeyUp={() => act('settings:update', { wpm })} />
      </label>
      <button className="btn ghost" onClick={() => act('game:next')}>Skip <kbd>N</kbd></button>
    </div>
  );
}

function BonusCard({ s }: { s: PublicState }) {
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
              {p.given !== undefined && <div className="given">{bn.teamName}: “{p.given || '—'}” {p.correct ? '✓' : '✗'}</div>}
            </li>
          );
        })}
      </ol>

      {answering && (
        <div className="status">
          {iAmCaptain ? <span>You are captain — confer with your team, then submit.</span>
            : mineTeam ? <span>Talk it over in <b>team chat</b>. {captainName} submits{bn.typing ? `: “${bn.typing}”` : '.'}</span>
              : <span>{bn.teamName} is conferring{r.isReader && bn.typing ? `: “${bn.typing}”` : '…'}</span>}
          <Countdown deadline={bn.deadline} total={bn.prompts ? 5 : s.settings.bonusSeconds} />
        </div>
      )}
      {iAmCaptain && answering && (
        <AnswerBox key={`${bn.num}-${bn.current}-${bn.prompts}`} event="bonus:submit" deadline={null} prompted={bn.prompts > 0} placeholder="Team answer, then Enter" />
      )}
      {bn.awaitingRuling && (r.isReader
        ? <RulingBox given={bn.awaitingRuling.given} suggestion={bn.awaitingRuling.suggestion} />
        : <div className="status muted">“{bn.awaitingRuling.given}” — waiting for the reader’s ruling</div>)}
      {bn.done && <div className="end-line">Bonus total: <b>{bn.parts.filter((p) => p.correct).length * s.settings.bonusPartValue}</b></div>}
    </div>
  );
}
