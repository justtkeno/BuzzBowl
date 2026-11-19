// Small synthesized sound effects (no audio files). All respect the sound on/off preference.

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const soundOn = () => store.get('qb:sound') !== 'off';
export function setSoundOn(on: boolean) {
  store.set('qb:sound', on ? 'on' : 'off');
  window.dispatchEvent(new Event('qb-sound'));
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (!soundOn()) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}

/** One note: frequency in Hz, start offset and length in seconds. */
function tone(a: AudioContext, freq: number, at: number, len: number, type: OscillatorType = 'triangle', vol = 0.08, slideTo?: number) {
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + len);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + len + 0.02);
}

export type Cue = 'power' | 'correct' | 'neg' | 'wrong' | 'prompt' | 'buzzMine' | 'buzzOther';

export function play(cue: Cue) {
  const a = audio();
  if (!a) return;
  switch (cue) {
    case 'power': // bright rising arpeggio with a sparkle on top
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(a, f, i * 0.07, 0.32, 'triangle', 0.09));
      tone(a, 2093, 0.3, 0.4, 'sine', 0.035);
      break;
    case 'correct': // two-note "ding-ding"
      tone(a, 659.25, 0, 0.22, 'triangle', 0.09);
      tone(a, 987.77, 0.1, 0.35, 'triangle', 0.09);
      break;
    case 'neg': // low falling buzz
      tone(a, 220, 0, 0.45, 'sawtooth', 0.05, 110);
      tone(a, 233, 0, 0.45, 'square', 0.025, 116);
      break;
    case 'wrong': // soft "bonk"
      tone(a, 330, 0, 0.18, 'triangle', 0.07, 247);
      tone(a, 247, 0.12, 0.28, 'triangle', 0.06, 196);
      break;
    case 'prompt': // questioning upturn
      tone(a, 440, 0, 0.16, 'sine', 0.08);
      tone(a, 587.33, 0.13, 0.24, 'sine', 0.08);
      break;
    case 'buzzMine':
      tone(a, 880, 0, 0.16, 'square', 0.05);
      break;
    case 'buzzOther':
      tone(a, 520, 0, 0.16, 'square', 0.045);
      break;
  }
}
