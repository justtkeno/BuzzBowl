import { useState } from 'react';
import { CATEGORIES, DIFFICULTIES, VOTE_SECONDS, type PublicState, type Settings } from '../../shared/types';
import { TOPICS } from '../../shared/topics';
import { call } from '../socket';
import { act, toast } from './util';
import { Icon } from './Icon';
import { Info } from './Info';
import type { TermId } from '../glossary';

/** Room settings. `only="questions"` shows just the question source and filters (the reader's quick mid-match change). */
export function SettingsPanel({ s, onClose, only }: { s: PublicState; onClose: () => void; only?: 'questions' }) {
  const [f, setF] = useState<Settings>(structuredClone(s.settings));
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const setFilter = (patch: Partial<Settings['filters']>) => setF((x) => ({ ...x, filters: { ...x.filters, ...patch } }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const midGame = ['loading', 'reading', 'buzz', 'bonus'].includes(s.phase);
  const tabs = only ? QUESTION_TABS : ALL_TABS;
  const [tab, setTabState] = useState<Tab>(() => (tabs.includes(lastTab[only ?? 'all']) ? lastTab[only ?? 'all'] : tabs[0]));
  const setTab = (t: Tab) => { lastTab[only ?? 'all'] = t; setTabState(t); };
  const filterCount = (f.filters.topics?.length ?? 0) + f.filters.categories.length + f.filters.subcategories.length
    + f.filters.difficulties.length + (f.filters.minYear ? 1 : 0) + (f.filters.maxYear ? 1 : 0);

  const save = async () => {
    try {
      await call('settings:update', only === 'questions' ? { source: f.source, filters: f.filters } : f);
      onClose();
    } catch (e: any) { toast(e.message); }
  };

  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const json = JSON.parse(await file.text());
      const res = await call<{ tossups: number; bonuses: number }>('packet:upload', json);
      toast(`Loaded ${res.tossups} tossups and ${res.bonuses} bonuses.`);
      setFileName(file.name);
      set('source', 'upload');
    } catch (e: any) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message);
    } finally { setUploading(false); }
  };

  const num = (k: keyof Settings, label: string, min: number, max: number, step = 1, term?: TermId) => (
    <label className="field inline">
      <span>{label}{term && <Info term={term} />}</span>
      <input type="number" min={min} max={max} step={step} value={f[k] as number} onChange={(e) => set(k, Number(e.target.value) as any)} />
    </label>
  );
  const check = (k: keyof Settings, label: string, hint?: string, term?: TermId) => (
    <label className="check">
      <input type="checkbox" checked={f[k] as boolean} onChange={(e) => set(k, e.target.checked as any)} />
      <span>{label}{term && <Info term={term} />}{hint && <small className="muted"> — {hint}</small>}</span>
    </label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={only ? 'Change questions' : 'Room settings'}>
        <div className="row between"><h2>{only ? 'Change questions' : 'Room settings'}</h2><button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        {s.phase !== 'lobby' && <p className="muted small settings-note">{only
          ? `${midGame ? 'The question being read now finishes as is. ' : ''}New questions start with the next tossup, and everyone sees a note in chat.`
          : `Changes apply right away${midGame ? ', and a clock that is already running grows or shrinks to match' : ''}. Points already scored stay as they are. New questions start with the next tossup. Everyone sees a note in chat.`}</p>}

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((t) => (
            <button key={t} role="tab" id={`stab-${t}`} aria-selected={tab === t} aria-controls="settings-panel" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}{t === 'topics' && filterCount > 0 && <span className="tab-dot" role="img" aria-label={`${filterCount} filter${filterCount === 1 ? '' : 's'} on`} title={`${filterCount} filter${filterCount === 1 ? '' : 's'} on`} />}
            </button>
          ))}
        </div>

        <div className="settings-body" role="tabpanel" id="settings-panel" aria-labelledby={`stab-${tab}`}>
        {tab === 'game' && (
        <section>
          <h3>Format <Info term="ffa" /></h3>
          <div className="seg">
            {(['ffa', 'teams', 'party'] as const).map((m) => {
              const on = m === 'teams' ? f.mode === 'teams' : f.mode === 'ffa' && (m === 'party') === partyOn(f);
              return (
                <button key={m} className={on ? 'on' : ''} disabled={midGame && (m === 'teams' ? f.mode !== 'teams' : f.mode !== 'ffa')} onClick={() => setF((x) => pickFormat(x, m))}>
                  {m === 'ffa' ? 'Free-for-all' : m === 'teams' ? 'Teams' : 'Party'}
                </button>
              );
            })}
          </div>
          {f.mode === 'ffa' && partyOn(f) && <p className="muted small">Party: everyone for themselves, and players vote on the next topic.</p>}
          {midGame && <p className="muted small">Mode can change between questions.</p>}
          <GameLength value={f.gameLength} playing={s.phase === 'lobby' || s.phase === 'gameOver' ? 0 : s.tossup?.num ?? 0} onChange={(n) => set('gameLength', n)} />
          <div className="grid2">
            <label className="field">
              <span>Reading speed: {f.wpm} wpm<Info term="wpm" /></span>
              <input type="range" min={100} max={600} step={10} value={f.wpm} onChange={(e) => set('wpm', Number(e.target.value))} />
            </label>
            {num('answerSeconds', 'Seconds to answer', 2, 30, 1, 'answerTime')}
            {num('deadSeconds', 'Buzz window after question', 1, 30, 1, 'buzzWindow')}
            {num('bonusSeconds', 'Seconds per bonus part', 5, 60, 1, 'bonus')}
          </div>
        </section>
        )}

        {tab === 'scoring' && (
        <section>
          <h3>Scoring</h3>
          {check('powers', 'Powers', 'correct before the (*) earns extra', 'power')}
          {check('negs', 'Negs', 'wrong answers before the question ends lose points', 'neg')}
          {check('bounty', 'Bounty tossups', 'now and then a tossup is worth double for a correct answer; it’s marked before it’s read', 'bounty')}
          {check('bonuses', 'Bonuses', f.mode === 'teams' ? 'team that gets the tossup plays a 3-part bonus' : 'player who gets the tossup plays a bonus', 'bonus')}
          <div className="grid4">
            {num('powerValue', 'Power', 0, 50)}
            {num('tenValue', 'Tossup', 0, 50)}
            {num('negValue', 'Neg', -50, 0)}
            {num('bonusPartValue', 'Bonus part', 0, 50)}
          </div>
        </section>
        )}

        {tab === 'reading' && (<>
        <section>
          <h3>Without a reader</h3>
          {check('topicVote', 'Vote on the topic', `players pick from 3 categories (${VOTE_SECONDS}s); the winner plays for 5 questions, up to 10 in long games`)}
        </section>

        <section>
          <h3>Reader <Info term="reader" /></h3>
          {check('showTextToPlayers', 'Show question text to players while the reader reads', 'off = players only hear it')}
          {check('readerRules', 'Reader rules on answers', 'auto-check becomes a suggestion')}
        </section>
        </>)}

        {tab === 'questions' && (
        <section>
          <h3>Question source</h3>
          <div className="seg source-seg">
            <button className={f.source === 'qbreader' ? 'on' : ''} onClick={() => set('source', 'qbreader')}>QBReader</button>
            <button className={f.source === 'sample' ? 'on' : ''} title="Built-in questions: always available, even offline" onClick={() => set('source', 'sample')}>Built-in</button>
            <button className={f.source === 'lightning' ? 'on' : ''} title="Lightning round: short one-line prompts" onClick={() => set('source', 'lightning')}><Icon name="bolt" /> Lightning</button>
            <button className={f.source === 'upload' ? 'on' : ''} disabled={!s.uploadedCount} onClick={() => set('source', 'upload')}>
              Uploaded{s.uploadedCount ? ` (${s.uploadedCount.tossups})` : ''}
            </button>
          </div>
          <div className="upload">
            <label className={`btn small upload-btn ${uploading ? 'busy' : ''}`}>
              <input type="file" accept=".json,application/json" disabled={uploading}
                onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
              {uploading ? 'Uploading…' : s.uploadedCount ? 'Upload another packet' : 'Upload a packet'}
            </label>
            <span className="muted small">
              {s.uploadedCount
                ? `${fileName ? `${fileName} · ` : ''}${s.uploadedCount.tossups} tossups, ${s.uploadedCount.bonuses} bonuses`
                : '.json file · QBReader exports work too'}
            </span>
          </div>
          <details className="upload-help">
            <summary>File format</summary>
            <pre>{EXAMPLE_TEXT}</pre>
            <p className="small muted">Bold and underline the required part of the answer. <code>(*)</code> marks where power ends.</p>
            <button type="button" className="link" onClick={downloadExample}>Download this example</button>
          </details>
        </section>
        )}

        {tab === 'topics' && (
        <section>
          <h4>Topics <small className="muted">(mix any; with topics picked, questions come only from them and any categories below)</small></h4>
          <div className="chips topic-chips">
            {TOPICS.map((t) => {
              const on = (f.filters.topics ?? []).includes(t.id);
              return (
                <button key={t.id} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={t.sources.length ? undefined : 'Built-in questions'}
                  onClick={() => setFilter({ topics: toggle(f.filters.topics ?? [], t.id) })}>{t.icon} {t.name}</button>
              );
            })}
          </div>
          <h4>Categories <small className="muted">(none = all)</small></h4>
          <div className="chips">
            {Object.keys(CATEGORIES).map((c) => (
              <button key={c} className={`chip ${f.filters.categories.includes(c) ? 'on' : ''}`} onClick={() => setFilter({ categories: toggle(f.filters.categories, c) })}>{c}</button>
            ))}
          </div>
          {f.filters.categories.some((c) => CATEGORIES[c]?.length) && (
            <>
              <h4>Subcategories <small className="muted">(none = all within the category)</small></h4>
              <div className="chips">
                {f.filters.categories.flatMap((c) => CATEGORIES[c] ?? []).map((sc) => (
                  <button key={sc} className={`chip ${f.filters.subcategories.includes(sc) ? 'on' : ''}`} onClick={() => setFilter({ subcategories: toggle(f.filters.subcategories, sc) })}>{sc}</button>
                ))}
              </div>
            </>
          )}
          <h4>Difficulty <small className="muted">(none = all)</small></h4>
          <div className="chips">
            {Object.entries(DIFFICULTIES).map(([d, label]) => (
              <button key={d} className={`chip ${f.filters.difficulties.includes(Number(d)) ? 'on' : ''}`} onClick={() => setFilter({ difficulties: toggle(f.filters.difficulties, Number(d)) })}>{d} · {label}</button>
            ))}
          </div>
          <div className="grid2">
            <label className="field inline"><span>From year</span><input type="number" min={1990} max={2100} placeholder="any" value={f.filters.minYear ?? ''} onChange={(e) => setFilter({ minYear: e.target.value ? Number(e.target.value) : undefined })} /></label>
            <label className="field inline"><span>To year</span><input type="number" min={1990} max={2100} placeholder="any" value={f.filters.maxYear ?? ''} onChange={(e) => setFilter({ maxYear: e.target.value ? Number(e.target.value) : undefined })} /></label>
          </div>
          {filterCount > 0 && <button type="button" className="link clear-filters" onClick={() => setFilter({ topics: [], categories: [], subcategories: [], difficulties: [], minYear: undefined, maxYear: undefined })}>Clear all filters</button>}
        </section>
        )}
        </div>

        <div className="row gap end settings-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>{only ? 'Use these questions' : 'Save'}</button>
          {s.phase === 'lobby' && !only && <button className="btn primary" onClick={async () => { await save(); act('game:start'); }}>Save &amp; start</button>}
        </div>
      </div>
    </div>
  );
}

type Tab = 'game' | 'scoring' | 'questions' | 'topics' | 'reading';
const ALL_TABS: Tab[] = ['game', 'scoring', 'questions', 'topics', 'reading'];
const QUESTION_TABS: Tab[] = ['questions', 'topics'];
const TAB_LABEL: Record<Tab, string> = { game: 'Game', scoring: 'Scoring', questions: 'Source', topics: 'Topics', reading: 'Reading' };
/** The tab the panel last showed (per kind of panel), so it reopens where the host left off. */
const lastTab: Record<string, Tab> = {};

const LENGTHS = [0, 10, 20, 30];

/** How many tossups a game has: a few common picks, or any number. `playing` is the tossup on now (0 outside a game). */
function GameLength({ value, playing, onChange }: { value: number; playing: number; onChange: (n: number) => void }) {
  const custom = !LENGTHS.includes(value);
  return (
    <div className="field game-length">
      <span>Game length</span>
      <div className="chips">
        {LENGTHS.map((n) => (
          <button type="button" key={n} className={`chip ${value === n ? 'on' : ''}`} onClick={() => onChange(n)}>{n ? `${n} tossups` : 'No limit'}</button>
        ))}
        <input type="number" className={`chip length-other ${custom ? 'on' : ''}`} min={1} max={500} placeholder="Other" aria-label="Other number of tossups"
          value={custom ? value : ''} onChange={(e) => onChange(Math.max(0, Math.min(500, Math.floor(Number(e.target.value)) || 0)))} />
      </div>
      <small className="muted">
        {!value ? 'Plays until the host ends the game.'
          : playing && value <= playing ? `Tossup ${playing} is on now, so the game finishes after it.`
          : `The game finishes after tossup ${value}${playing ? ` (${value - playing} more after this one)` : ''}.`}
      </small>
    </div>
  );
}

/** Party = free-for-all with topic votes. */
export const partyOn = (f: Settings) => f.mode === 'ffa' && f.topicVote;
function pickFormat(x: Settings, m: 'ffa' | 'teams' | 'party'): Settings {
  if (m === 'party') return { ...x, mode: 'ffa', bonuses: x.mode === 'ffa' ? x.bonuses : false, topicVote: true };
  if (m === 'ffa') return { ...x, mode: 'ffa', bonuses: x.mode === 'ffa' ? x.bonuses : false, topicVote: false };
  return { ...x, mode: 'teams', bonuses: true };
}

/** The packet format, shown under "File format" and offered as a starter file. */
const EXAMPLE = {
  tossups: [{
    question: 'This planet has the Great Red Spot, a storm larger than Earth. Its moons include Io and (*) Europa. For 10 points, name this largest planet in the solar system.',
    answer: '<b><u>Jupiter</u></b> [accept Iuppiter]',
    category: 'Science',
    subcategory: 'Other Science',
  }],
  bonuses: [{
    leadin: 'For 10 points each, answer these questions about Shakespeare.',
    parts: ['Name this play about a Danish prince.', 'Hamlet says “Alas, poor” this jester while holding his skull.', 'This play features three witches and Banquo.'],
    answers: ['<b><u>Hamlet</u></b>', '<b><u>Yorick</u></b>', '<b><u>Macbeth</u></b>'],
    category: 'Literature',
  }],
};
const EXAMPLE_TEXT = JSON.stringify(EXAMPLE, null, 2);

function downloadExample() {
  const url = URL.createObjectURL(new Blob([EXAMPLE_TEXT + '\n'], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'example-packet.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
