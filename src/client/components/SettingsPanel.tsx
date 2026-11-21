import { useState } from 'react';
import { CATEGORIES, DIFFICULTIES, type PublicState, type Settings } from '../../shared/types';
import { call } from '../socket';
import { act, toast } from './util';

/** Room settings. `only="questions"` shows just the question source and filters (the reader's quick mid-match change). */
export function SettingsPanel({ s, onClose, only }: { s: PublicState; onClose: () => void; only?: 'questions' }) {
  const [f, setF] = useState<Settings>(structuredClone(s.settings));
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));
  const setFilter = (patch: Partial<Settings['filters']>) => setF((x) => ({ ...x, filters: { ...x.filters, ...patch } }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const midGame = ['loading', 'reading', 'buzz', 'bonus'].includes(s.phase);

  const save = async () => {
    try {
      await call('settings:update', only === 'questions' ? { source: f.source, filters: f.filters } : f);
      onClose();
    } catch (e: any) { toast(e.message); }
  };

  const upload = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const res = await call<{ tossups: number; bonuses: number }>('packet:upload', json);
      toast(`Loaded ${res.tossups} tossups and ${res.bonuses} bonuses.`);
      set('source', 'upload');
    } catch (e: any) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message);
    }
  };

  const num = (k: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <label className="field inline">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={f[k] as number} onChange={(e) => set(k, Number(e.target.value) as any)} />
    </label>
  );
  const check = (k: keyof Settings, label: string, hint?: string) => (
    <label className="check">
      <input type="checkbox" checked={f[k] as boolean} onChange={(e) => set(k, e.target.checked as any)} />
      <span>{label}{hint && <small className="muted"> — {hint}</small>}</span>
    </label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={only ? 'Change questions' : 'Room settings'}>
        <div className="row between"><h2>{only ? 'Change questions' : 'Settings'}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button></div>
        {s.phase !== 'lobby' && <p className="muted small settings-note">{only
          ? `${midGame ? 'The question being read now finishes as is. ' : ''}New questions start with the next tossup, and everyone sees a note in chat.`
          : `Changes apply right away${midGame ? ', and a clock that is already running grows or shrinks to match' : ''}. Points already scored stay as they are. New questions start with the next tossup. Everyone sees a note in chat.`}</p>}

        {!only && <>
        <section>
          <h3>Format</h3>
          <div className="seg">
            {(['ffa', 'teams'] as const).map((m) => (
              <button key={m} className={f.mode === m ? 'on' : ''} disabled={midGame} onClick={() => setF((x) => ({ ...x, mode: m, bonuses: m === 'teams' }))}>
                {m === 'ffa' ? 'Free-for-all' : 'Teams'}
              </button>
            ))}
          </div>
          {midGame && <p className="muted small">Mode can change between questions.</p>}
          <div className="grid2">
            <label className="field">
              <span>Reading speed: {f.wpm} wpm</span>
              <input type="range" min={100} max={600} step={10} value={f.wpm} onChange={(e) => set('wpm', Number(e.target.value))} />
            </label>
            {num('answerSeconds', 'Seconds to answer', 2, 30)}
            {num('deadSeconds', 'Buzz window after question', 1, 30)}
            {num('bonusSeconds', 'Seconds per bonus part', 5, 60)}
          </div>
        </section>

        <section>
          <h3>Scoring</h3>
          {check('powers', 'Powers', 'correct before the (*) earns extra')}
          {check('negs', 'Negs', 'wrong answers before the question ends lose points')}
          {check('bonuses', 'Bonuses', f.mode === 'teams' ? 'team that gets the tossup plays a 3-part bonus' : 'player who gets the tossup plays a bonus')}
          <div className="grid4">
            {num('powerValue', 'Power', 0, 50)}
            {num('tenValue', 'Tossup', 0, 50)}
            {num('negValue', 'Neg', -50, 0)}
            {num('bonusPartValue', 'Bonus part', 0, 50)}
          </div>
        </section>

        <section>
          <h3>Reader</h3>
          {check('showTextToPlayers', 'Show question text to players while the reader reads', 'off = players only hear it')}
          {check('readerRules', 'Reader rules on answers', 'auto-check becomes a suggestion')}
        </section>
        </>}

        <section>
          {!only && <h3>Questions</h3>}
          <div className="seg">
            <button className={f.source === 'qbreader' ? 'on' : ''} onClick={() => set('source', 'qbreader')}>QBReader</button>
            <button className={f.source === 'sample' ? 'on' : ''} onClick={() => set('source', 'sample')}>Built-in questions</button>
            <button className={f.source === 'upload' ? 'on' : ''} disabled={!s.uploadedCount} onClick={() => set('source', 'upload')}>
              Uploaded{s.uploadedCount ? ` (${s.uploadedCount.tossups})` : ''}
            </button>
          </div>
          <label className="field">
            <span>Upload a packet (.json)</span>
            <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <small className="muted">
              {'{"tossups":[{"question":"… (*) …","answer":"<b><u>X</u></b> [accept Y; prompt on Z]","category":"Science"}],"bonuses":[{"leadin":"…","parts":["…"],"answers":["…"]}]}'}
              {' '}QBReader exports work too.
            </small>
          </label>

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
        </section>

        <div className="row gap end">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>{only ? 'Use these questions' : 'Save'}</button>
          {s.phase === 'lobby' && !only && <button className="btn primary" onClick={async () => { await save(); act('game:start'); }}>Save &amp; start</button>}
        </div>
      </div>
    </div>
  );
}
