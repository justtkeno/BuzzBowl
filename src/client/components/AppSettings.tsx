import { useEffect, useState } from 'react';
import { TEXT_SIZE_LABEL, setTextSizeChoice, setThemeChoice } from '../App';
import { prefs } from '../socket';
import { BUZZ_SOUNDS, buzzSound, play, setBuzzSound, setSoundOn, setVolume, soundOn, volume, type BuzzSound } from '../sounds';
import { useAccount } from '../account';
import { AccountSettings } from './AccountSettings';
import { Icon } from './Icon';
import { canVibrate, setVibrationOn, vibrate, vibrationOn } from './util';

type Size = keyof typeof TEXT_SIZE_LABEL;
type Theme = 'auto' | 'light' | 'dark';
const THEMES: [Theme, string][] = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];

export type SettingsView = 'menu' | 'account' | 'game';

/**
 * The gear button's menu, on every screen: Account settings (username, email, password) and
 * Game settings (this device's sound, vibration, text size and theme).
 * The host's rules for a room are separate, in Room settings.
 */
export function SettingsMenu({ onClose, start = 'menu' }: { onClose: () => void; start?: SettingsView }) {
  const [view, setView] = useState<SettingsView>(start);
  const { me } = useAccount();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = view === 'account' ? 'Account settings' : view === 'game' ? 'Game settings' : 'Settings';
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal app-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="row between as-head">
          {view !== 'menu' && start === 'menu'
            ? <button className="btn ghost icon as-back" onClick={() => setView('menu')} aria-label="Back to settings"><Icon name="back" /></button>
            : null}
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon close-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        {view === 'menu' && (
          <div className="settings-choices">
            <button className="settings-choice" onClick={() => setView('account')}>
              <Icon name="user" />
              <span className="grow"><b>Account settings</b><small>{me ? `@${me.username} · username, email, password` : 'Log in or sign up'}</small></span>
              <Icon name="next" />
            </button>
            <button className="settings-choice" onClick={() => setView('game')}>
              <Icon name="sliders" />
              <span className="grow"><b>Game settings</b><small>Sound, vibration, text size, theme</small></span>
              <Icon name="next" />
            </button>
            <a className="settings-choice" href="/help">
              <Icon name="help" />
              <span className="grow"><b>Help and glossary</b><small>How things work, and what quiz bowl words mean</small></span>
              <Icon name="next" />
            </a>
          </div>
        )}
        {view === 'account' && <AccountSettings onClose={onClose} />}
        {view === 'game' && <GameSettings onClose={onClose} />}
      </div>
    </div>
  );
}

/** This device's own settings. Everything is saved on the device right away. */
function GameSettings({ onClose }: { onClose: () => void }) {
  const [sound, setSound] = useState(soundOn());
  const [vol, setVol] = useState(Math.round(volume() * 100));
  const [buzz, setBuzz] = useState<BuzzSound>(buzzSound());
  const [vibe, setVibe] = useState(vibrationOn());
  const [size, setSize] = useState<Size>(prefs.textSize());
  const [theme, setTheme] = useState<Theme>((prefs.theme() as Theme) ?? 'auto');

  const toggleSound = (on: boolean) => { setSoundOn(on); setSound(on); if (on) play('correct'); };
  const pickBuzz = (v: BuzzSound) => { setBuzzSound(v); setBuzz(v); };

  return (
    <>
        <p className="muted small as-note">For this device only. A room’s host sets its rules in Room settings.</p>

        <div className="as-body">
          <section className="as-group">
            <h3>Sound</h3>
            <label className="as-row">
              <span>Sound effects<small>buzzes, right and wrong answers, the last seconds of a timer</small></span>
              <Switch on={sound} onChange={toggleSound} label="Sound effects" />
            </label>
            <label className={`as-row ${sound ? '' : 'off'}`}>
              <span>Volume</span>
              <span className="as-volume">
                <input type="range" min={0} max={100} step={5} value={vol} disabled={!sound} aria-label="Volume"
                  onChange={(e) => { const v = Number(e.target.value); setVol(v); setVolume(v / 100); }}
                  onPointerUp={() => play('correct')} onKeyUp={() => play('correct')} />
                <b>{vol}%</b>
              </span>
            </label>
            <div className={`as-sub ${sound ? '' : 'off'}`}>
              <span className="as-label">Buzz sound <small>others hear a lower version of theirs, so you can tell buzzes apart</small></span>
              <div className="chips as-buzz" role="radiogroup" aria-label="Buzz sound">
                {(Object.keys(BUZZ_SOUNDS) as BuzzSound[]).map((v) => (
                  <button key={v} role="radio" aria-checked={buzz === v} disabled={!sound} className={`chip ${buzz === v ? 'on' : ''}`} onClick={() => pickBuzz(v)}>{BUZZ_SOUNDS[v]}</button>
                ))}
              </div>
            </div>
          </section>

          {canVibrate() && (
            <section className="as-group">
              <h3>Vibration</h3>
              <label className="as-row">
                <span>Vibrate<small>a tap when you buzz and in the last seconds to answer</small></span>
                <Switch on={vibe} onChange={(on) => { setVibrationOn(on); setVibe(on); if (on) vibrate(30); }} label="Vibrate" />
              </label>
            </section>
          )}

          <section className="as-group">
            <h3>Display</h3>
            <span className="as-label">Question text</span>
            <div className="seg display-seg" role="radiogroup" aria-label="Question text size">
              {(Object.keys(TEXT_SIZE_LABEL) as Size[]).map((k) => (
                <button key={k} role="radio" aria-checked={size === k} className={size === k ? 'on' : ''} onClick={() => { setTextSizeChoice(k); setSize(k); }}>
                  <span className={`display-aa aa-${k}`} aria-hidden="true">Aa</span>{TEXT_SIZE_LABEL[k]}
                </button>
              ))}
            </div>
            <p className="qtext display-preview">This planet’s two small moons are named for the sons of a war god.</p>
            <span className="as-label">Theme <small>Auto follows your phone or computer’s light or dark setting</small></span>
            <div className="seg display-seg" role="radiogroup" aria-label="Theme">
              {THEMES.map(([k, label]) => (
                <button key={k} role="radio" aria-checked={theme === k} className={theme === k ? 'on' : ''} onClick={() => { setThemeChoice(k); setTheme(k); }}>{label}</button>
              ))}
            </div>
          </section>
        </div>

        <div className="row end as-foot"><button className="btn primary" onClick={onClose}>Done</button></div>
    </>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); onChange(!on); }}>
      <span className="switch-knob" />
    </button>
  );
}
