import { useEffect, useState } from 'react';
import type { Settings, SourceKind } from '../../shared/types';
import { TOPICS } from '../../shared/topics';
import { prefs, type PracticeQuestions } from '../socket';
import { Icon } from './Icon';
import { countFilters, TopicFilters } from './SettingsPanel';

const SOURCES: { id: SourceKind; name: string; hint: string }[] = [
  { id: 'qbreader', name: 'QBReader', hint: 'Real tournament tossups, read word by word.' },
  { id: 'sample', name: 'Built-in', hint: 'Trivio’s own tossups. Always available, even offline.' },
  { id: 'lightning', name: 'Lightning', hint: 'Short one-line prompts, quick to answer.' },
];
const SOURCE_NAME: Record<string, string> = { qbreader: 'QBReader', sample: 'Built-in', lightning: 'Lightning' };

/** "QBReader · History, Science" — what the next practice will ask. */
export function practiceSummary(p: PracticeQuestions) {
  const f = p.filters;
  const picked = [...(f.topics ?? []).map((id) => TOPICS.find((t) => t.id === id)?.name ?? id), ...f.categories];
  const rest = f.subcategories.length + f.difficulties.length + (f.minYear ? 1 : 0) + (f.maxYear ? 1 : 0);
  const what = picked.length ? (picked.length > 2 ? `${picked.slice(0, 2).join(', ')} +${picked.length - 2}` : picked.join(', ')) : 'all topics';
  return `${SOURCE_NAME[p.source] ?? p.source} · ${what}${rest ? ` · ${rest} more filter${rest === 1 ? '' : 's'}` : ''}`;
}

/** The current practice choice, kept in step when it changes (here or in a practice room). */
export function usePractice() {
  const [p, setP] = useState(prefs.practice);
  useEffect(() => {
    const on = () => setP(prefs.practice());
    window.addEventListener('qb-practice', on);
    return () => window.removeEventListener('qb-practice', on);
  }, []);
  return p;
}

type Tab = 'source' | 'topics';

/** Practice settings: which questions solo practice asks, saved on this device. The rest of the rules come from Room settings. */
export function PracticeSettings({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<PracticeQuestions>(prefs.practice);
  const [tab, setTab] = useState<Tab>('source');
  const setFilter = (patch: Partial<Settings['filters']>) => setP((x) => ({ ...x, filters: { ...x.filters, ...patch } }));
  const filterCount = countFilters(p.filters);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const save = () => { prefs.setPractice(p); onClose(); };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Practice settings">
        <div className="row between"><h2>Practice settings</h2><button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div>
        <p className="muted small settings-note">Which questions solo practice asks. Saved on this device; games with friends keep their own Room settings.</p>

        <div className="settings-tabs few" role="tablist" aria-label="Practice settings sections">
          {(['source', 'topics'] as Tab[]).map((t) => (
            <button key={t} role="tab" id={`ptab-${t}`} aria-selected={tab === t} aria-controls="practice-panel" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'source' ? 'Source' : 'Topics'}{t === 'topics' && filterCount > 0 && <span className="tab-dot" role="img" aria-label={`${filterCount} filter${filterCount === 1 ? '' : 's'} on`} />}
            </button>
          ))}
        </div>

        <div className="settings-body" role="tabpanel" id="practice-panel" aria-labelledby={`ptab-${tab}`}>
          {tab === 'source' ? (
            <section>
              <h3>Question source</h3>
              <div className="seg source-seg">
                {SOURCES.map((x) => (
                  <button key={x.id} className={p.source === x.id ? 'on' : ''} aria-pressed={p.source === x.id} onClick={() => setP((y) => ({ ...y, source: x.id }))}>
                    {x.id === 'lightning' && <Icon name="bolt" />} {x.name}
                  </button>
                ))}
              </div>
              <p className="muted small">{SOURCES.find((x) => x.id === p.source)?.hint}</p>
            </section>
          ) : (
            <section><TopicFilters filters={p.filters} onChange={setFilter} /></section>
          )}
        </div>

        <div className="settings-foot">
          <div className="row gap end">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
