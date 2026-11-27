// Read aloud: this device speaks each tossup with the best text-to-speech voice it has, as the server reveals
// the words. The server still owns the timing: only words already on screen are spoken, so nobody hears a word
// before it is shown. Speech stops on a buzz or pause and picks up from the current word when reading resumes.
//
// Keeping in sync: every voice talks at its own speed, so each voice's real speed is measured as it talks and the
// rate is set to match the room's reading speed. Words are spoken in small chunks as soon as they appear; if the
// voice still falls behind it speeds up a little, and if it falls far behind it skips ahead to the current word.
import { useEffect, useRef, useState } from 'react';
import type { PublicState } from '../shared/types';

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const ON_KEY = 'qb:tts';
const VOICE_KEY = 'qb:voice';

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/** This device's choice. Off unless turned on in Game settings. */
export const speechOn = () => store.get(ON_KEY) === 'on';
export function setSpeechOn(on: boolean) {
  store.set(ON_KEY, on ? 'on' : 'off');
  if (on) unlock(); else if (speechSupported()) speechSynthesis.cancel();
  window.dispatchEvent(new Event('qb-tts'));
}
function useSpeechOn(): boolean {
  const [on, setOn] = useState(speechOn);
  useEffect(() => {
    const f = () => setOn(speechOn());
    window.addEventListener('qb-tts', f);
    return () => window.removeEventListener('qb-tts', f);
  }, []);
  return on;
}

// ---------- voices ----------

/** Novelty and old robotic voices: never picked automatically. */
const BAD = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|pipe organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|espeak|robot)\b/i;

/** Higher is more natural-sounding. Neural "Natural"/"Online" voices (Edge), Apple's Premium/Enhanced and Siri, Google's. */
export function voiceScore(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>): number {
  if (!/^en(-|_|$)/i.test(v.lang)) return -1000;
  if (BAD.test(v.name)) return -500;
  let s = 0;
  if (/natural|neural/i.test(v.name)) s += 60;
  if (/premium/i.test(v.name)) s += 50;
  if (/enhanced/i.test(v.name)) s += 40;
  if (/siri/i.test(v.name)) s += 35;
  if (/google/i.test(v.name)) s += 30;
  if (/online/i.test(v.name)) s += 10;
  if (/en[-_]US/i.test(v.lang)) s += 5; else if (/en[-_](GB|AU|CA|IE|NZ)/i.test(v.lang)) s += 3;
  return s;
}

/** English voices on this device, best first. */
export function englishVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  return speechSynthesis.getVoices().filter((v) => voiceScore(v) > -1000).sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
}

/** The voice to use: the one picked in Game settings if this device still has it, else the best one. */
export function currentVoice(): SpeechSynthesisVoice | null {
  const all = englishVoices();
  const chosen = store.get(VOICE_KEY);
  return all.find((v) => v.voiceURI === chosen) ?? all[0] ?? null;
}
export const chosenVoiceId = () => store.get(VOICE_KEY);
export function setVoice(voiceURI: string | null) {
  store.set(VOICE_KEY, voiceURI ?? '');
  window.dispatchEvent(new Event('qb-tts'));
}

/** Voices load late on some browsers: re-render when they arrive. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState(englishVoices);
  useEffect(() => {
    if (!speechSupported()) return;
    const f = () => setVoices(englishVoices());
    speechSynthesis.addEventListener('voiceschanged', f);
    f();
    return () => speechSynthesis.removeEventListener('voiceschanged', f);
  }, []);
  return voices;
}

/** Say a sample sentence in a voice (Game settings → Preview). */
export function previewVoice(voiceURI?: string) {
  if (!speechSupported()) return;
  speechSynthesis.cancel();
  const v = englishVoices().find((x) => x.voiceURI === voiceURI) ?? currentVoice();
  const u = new SpeechSynthesisUtterance('For ten points, name this planet, whose two small moons are named for the sons of a war god.');
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 1;
  speechSynthesis.speak(u);
}

// iOS and some Android browsers only allow speech that starts inside a tap. Speaking an empty utterance on a tap
// or key press unlocks it for the rest of the visit.
let unlocked = false;
function unlock() {
  if (unlocked || !speechSupported()) return;
  unlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}
function unlockOnGesture() {
  if (unlocked || !speechSupported()) return;
  const go = () => { unlock(); window.removeEventListener('pointerdown', go, true); window.removeEventListener('keydown', go, true); };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

// ---------- pace ----------

/**
 * Each voice's measured words per minute at rate 1, so the rate can match the room's reading speed. Chunks are
 * often just two words, too short to time alone, so words and (time × rate) are summed over recent chunks, older
 * ones fading out.
 */
const pace = new Map<string, number>();
const tally = new Map<string, { words: number; msAtOne: number }>();
const DEFAULT_WPM_AT_1 = 175;
function learnPace(voice: string, words: number, ms: number, rate: number) {
  if (!words || ms < 120) return; // cut off before it really spoke
  const one = (words / (ms / 60_000)) / rate;
  if (one < 50 || one > 450) return; // a stall or a dropped utterance, not a real measure
  const t = tally.get(voice) ?? { words: 0, msAtOne: 0 };
  t.words = t.words * 0.85 + words;
  t.msAtOne = t.msAtOne * 0.85 + ms * rate;
  tally.set(voice, t);
  if (t.words >= 5) pace.set(voice, t.words / (t.msAtOne / 60_000));
}

/** Whether this viewer's device should read the room aloud: nobody holds the reader seat and the text is shown. */
export function readAloudActive(s: PublicState) {
  const readerOnline = !!s.readerId && !!s.players.find((p) => p.id === s.readerId)?.online;
  return !readerOnline && !!s.tossup?.textVisible;
}

/** Ends a phrase: punctuation, maybe followed by closing quotes or brackets. */
const PHRASE_END = /[.,;:!?…]["'”’)\]]*$/;
/** Behind by more than this many words: skip ahead to the latest words. */
const SKIP_AFTER = 10;

/** Speak the current tossup aloud while it is read. Call once on each screen that shows a tossup. */
export function useReadAloud(s: PublicState | null) {
  const on = useSpeechOn();
  const t = s?.tossup;
  const reading = !!s && !!t && s.phase === 'reading' && !s.paused && !t.paused;
  const active = !!s && speechSupported() && on && readAloudActive(s) && reading;
  const st = useRef({ num: -1, spoken: 0, speaking: false, seq: 0 });
  const latest = useRef({ s, active });
  latest.current = { s, active };

  useEffect(() => { if (on) unlockOnGesture(); }, [on]);

  const pump = useRef(() => {});
  pump.current = () => {
    const { s: cur, active: live } = latest.current;
    const tt = cur?.tossup;
    const r = st.current;
    if (!live || !tt || r.speaking || tt.num !== r.num) return;
    // Far behind (a slow voice, or the tab was in the background): drop the backlog and carry on from near the latest word.
    if (tt.revealed.length - r.spoken > SKIP_AFTER) r.spoken = tt.revealed.length - 2;
    const words = tt.revealed.slice(r.spoken).filter(Boolean);
    if (!words.length) return;
    // Start as soon as there are two words (or a phrase ends, or the question is done): waiting for more is what made it lag.
    const done = tt.revealed.length >= tt.totalWords;
    if (!done && words.length < 2 && !PHRASE_END.test(words[words.length - 1])) return;
    r.spoken = tt.revealed.length;
    r.speaking = true;
    const id = ++r.seq;
    const v = currentVoice();
    const u = new SpeechSynthesisUtterance(words.join(' '));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    const atOne = (v && pace.get(v.voiceURI)) || DEFAULT_WPM_AT_1;
    const target = cur!.settings.wpm || 200;
    // A few words behind (a bigger chunk than the usual two): talk a bit faster to catch up.
    const catchUp = 1 + Math.min(0.35, Math.max(0, words.length - 2) * 0.07);
    u.rate = Math.min(2.5, Math.max(0.6, (target / atOne) * 1.05 * catchUp));
    let started = 0;
    u.onstart = () => { started = performance.now(); };
    // A cancelled chunk can report its end late; only the chunk still playing moves things on.
    const next = (ok: boolean) => {
      const c = st.current;
      if (ok && started && v) learnPace(v.voiceURI, words.length, performance.now() - started, u.rate);
      if (c.speaking && c.seq === id) { c.speaking = false; pump.current(); }
    };
    u.onend = () => next(true);
    u.onerror = () => next(false);
    speechSynthesis.speak(u);
  };

  const num = t?.num ?? -1;
  const revealedCount = t?.revealed.length ?? 0;
  useEffect(() => {
    if (!speechSupported()) return;
    const r = st.current;
    if (num !== r.num) {
      if (r.speaking) speechSynthesis.cancel();
      // Joining mid-question starts from the current word, not from the beginning.
      Object.assign(r, { num, spoken: revealedCount, speaking: false, seq: r.seq + 1 });
    }
    if (!active) {
      // Buzz, pause or tossup over: stop now; what was shown counts as read.
      if (r.speaking) { r.speaking = false; r.seq++; speechSynthesis.cancel(); }
      r.spoken = revealedCount;
      return;
    }
    pump.current();
  }, [num, revealedCount, active]);

  useEffect(() => () => { if (speechSupported() && st.current.speaking) speechSynthesis.cancel(); }, []);
}
