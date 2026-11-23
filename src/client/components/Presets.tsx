import { useState } from 'react';
import type { Settings } from '../../shared/types';
import {
  DEFAULT_PRESETS, PRESET_NAME_MAX, PRESET_SLOTS, cleanPresetName, decodePreset, encodePreset, presetFrom, presetMatches, presetSummary,
  type Preset, type PresetSettings,
} from '../../shared/presets';
import { savePresets, useAccount } from '../account';
import { AccountDialog } from './Account';
import { act, isTouch, toast } from './util';

const newId = () => Math.random().toString(36).slice(2, 10);

/** A link that opens Trivio with this preset ready to use or save. */
export function presetLink(name: string, settings: PresetSettings) {
  return `${location.origin}/?preset=${encodePreset(name, settings)}`;
}

export async function sharePreset(name: string, settings: PresetSettings) {
  const url = presetLink(name, settings);
  if (isTouch() && navigator.share) {
    try { await navigator.share({ title: `Trivio preset: ${name}`, url }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone who opens it can use these rules.'); } catch { toast(url); }
}

/** Host's picker: built-in presets plus up to PRESET_SLOTS of their own, saved on their account. */
export function PresetPicker({ settings, canApply }: { settings: Settings; canApply: boolean }) {
  const { me } = useAccount();
  const [login, setLogin] = useState<null | 'login' | 'signup'>(null);
  const [busy, setBusy] = useState(false);
  const mine = me?.presets ?? [];

  const apply = (p: PresetSettings) => { if (canApply) act('settings:update', p); };
  const save = async (next: Preset[], done?: string) => {
    setBusy(true);
    try { await savePresets(next); if (done) toast(done); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const askName = (initial: string) => {
    const n = prompt(`Name this preset (up to ${PRESET_NAME_MAX} characters):`, initial);
    return n === null ? null : cleanPresetName(n) || null;
  };
  const saveCurrent = () => {
    const name = askName(`My rules ${mine.length + 1}`);
    if (name) void save([...mine, { id: newId(), name, settings: presetFrom(settings) }], `Saved “${name}”.`);
  };
  const overwrite = (p: Preset) => {
    if (confirm(`Replace the rules in “${p.name}” with this room’s current rules?`)) void save(mine.map((x) => (x.id === p.id ? { ...x, settings: presetFrom(settings) } : x)), `Updated “${p.name}”.`);
  };
  const rename = (p: Preset) => {
    const name = askName(p.name);
    if (name) void save(mine.map((x) => (x.id === p.id ? { ...x, name } : x)));
  };
  const remove = (p: Preset) => {
    if (confirm(`Delete the preset “${p.name}”?`)) void save(mine.filter((x) => x.id !== p.id), `Deleted “${p.name}”.`);
  };

  return (
    <div className="presets">
      <div className="preset-grid">
        {DEFAULT_PRESETS.map((p) => {
          const on = presetMatches(p.settings, settings);
          return (
            <button key={p.id} className={`preset ${on ? 'on' : ''}`} aria-pressed={on} disabled={!canApply} onClick={() => apply(p.settings)} title={presetSummary(p.settings)}>
              <b>{p.name}</b>
              <small>{p.blurb}</small>
            </button>
          );
        })}
      </div>

      <div className="preset-mine-head">
        <h4>My presets {me && <span className="muted small">({mine.length}/{PRESET_SLOTS})</span>}</h4>
      </div>
      {!me ? (
        <div className="preset-signin">
          <p className="muted small">Sign in to save up to {PRESET_SLOTS} of your own presets on your account, and share them with a link.</p>
          <div className="row gap"><button className="btn small" onClick={() => setLogin('signup')}>Sign up</button><button className="btn small ghost" onClick={() => setLogin('login')}>Log in</button></div>
        </div>
      ) : (
        <ul className="preset-slots">
          {mine.map((p) => (
            <li key={p.id} className={presetMatches(p.settings, settings) ? 'on' : ''}>
              <button className="preset-slot-use" disabled={!canApply} onClick={() => apply(p.settings)} aria-pressed={presetMatches(p.settings, settings)}>
                <b>{p.name}</b>
                <small>{presetSummary(p.settings)}</small>
              </button>
              <div className="preset-slot-actions">
                <button className="link small" onClick={() => void sharePreset(p.name, p.settings)}>Share</button>
                {canApply && <button className="link small" disabled={busy} onClick={() => overwrite(p)} title="Save this room’s current rules into this preset">Update</button>}
                <button className="link small" disabled={busy} onClick={() => rename(p)}>Rename</button>
                <button className="link small danger" disabled={busy} onClick={() => remove(p)}>Delete</button>
              </div>
            </li>
          ))}
          {mine.length < PRESET_SLOTS && canApply && (
            <li className="empty">
              <button className="preset-slot-add" disabled={busy} onClick={saveCurrent}>+ Save the current rules as a preset</button>
              <span className="muted small">{PRESET_SLOTS - mine.length} of {PRESET_SLOTS} slots free</span>
            </li>
          )}
        </ul>
      )}
      {login && <AccountDialog initial={login} onClose={() => setLogin(null)} />}
    </div>
  );
}

/** Read `?preset=` from the address, once. */
export function sharedPresetFromUrl(): { name: string; settings: PresetSettings } | null {
  const code = new URLSearchParams(location.search).get('preset');
  return code ? decodePreset(code) : null;
}

/** Home screen card for a preset someone shared: start a room with it, or save it to your own presets. */
export function SharedPresetCard({ preset, busy, onCreate, onDismiss }: {
  preset: { name: string; settings: PresetSettings }; busy: boolean; onCreate: () => void; onDismiss: () => void;
}) {
  const { me } = useAccount();
  const [login, setLogin] = useState<null | 'login' | 'signup'>(null);
  const [saved, setSaved] = useState(false);
  const mine = me?.presets ?? [];
  const full = mine.length >= PRESET_SLOTS;
  const save = async () => {
    try { await savePresets([...mine, { id: newId(), name: preset.name, settings: preset.settings }]); setSaved(true); toast(`Saved “${preset.name}” to your presets.`); } catch (e: any) { toast(e.message); }
  };
  return (
    <section className="shared-preset">
      <div className="row between">
        <span className="muted small">Someone shared game rules with you</span>
        <button className="link small" onClick={onDismiss}>Dismiss</button>
      </div>
      <b>{preset.name}</b>
      <p className="muted small">{presetSummary(preset.settings) || 'Trivio’s usual rules'}</p>
      <div className="row gap wrap">
        <button className="btn primary" disabled={busy} onClick={onCreate}>Create a room with these rules</button>
        {!me ? <button className="btn" onClick={() => setLogin('login')}>Sign in to save it</button>
          : saved ? <span className="muted small">Saved to your presets.</span>
          : <button className="btn" disabled={full} title={full ? `You already have ${PRESET_SLOTS} presets. Delete one in Account settings first.` : undefined} onClick={() => void save()}>Save to my presets</button>}
      </div>
      {me && full && !saved && <p className="muted small">Your {PRESET_SLOTS} preset slots are full. Delete one in Account settings (gear button) to save this.</p>}
      {login && <AccountDialog initial={login} onClose={() => setLogin(null)} />}
    </section>
  );
}
