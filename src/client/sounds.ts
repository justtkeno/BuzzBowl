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

export type Cue = 'power' | 'correct' | 'neg' | 'wrong' | 'prompt' | 'buzzMine' | 'buzzOther' | 'tick' | 'streak';

export function play(cue: Cue) {
  const a = audio();
  if (!a) return;
  switch (cue) {
    case 'power': // three soft rising notes
      [659.25, 880, 1174.66].forEach((f, i) => tone(a, f, i * 0.06, 0.22, 'sine', 0.045));
      break;
    case 'correct': // two soft notes
      tone(a, 659.25, 0, 0.16, 'sine', 0.045);
      tone(a, 880, 0.07, 0.24, 'sine', 0.045);
      break;
    case 'neg': // gentle low drop
      tone(a, 293.66, 0, 0.28, 'sine', 0.05, 196);
      break;
    case 'wrong': // muted low note
      tone(a, 261.63, 0, 0.2, 'sine', 0.035, 220);
      break;
    case 'prompt': // light questioning lift
      tone(a, 523.25, 0, 0.12, 'sine', 0.04);
      tone(a, 659.25, 0.09, 0.16, 'sine', 0.04);
      break;
    case 'buzzMine':
      tone(a, 880, 0, 0.16, 'square', 0.05);
      break;
    case 'buzzOther':
      tone(a, 520, 0, 0.16, 'square', 0.045);
      break;
    case 'tick': // faint clock tick for the last seconds of an answer
      tone(a, 1000, 0, 0.04, 'sine', 0.015);
      break;
    case 'streak': // two soft high notes
      tone(a, 880, 0, 0.14, 'sine', 0.035);
      tone(a, 1318.5, 0.08, 0.2, 'sine', 0.035);
      break;
  }
}
