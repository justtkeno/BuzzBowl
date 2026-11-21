// Read-aloud: speaks each tossup with the device's text-to-speech as the server reveals the words.
// The server still owns the timing. This only voices words that are already on screen, a few at a time,
// so nobody hears a word before it is shown. Speech stops on a buzz or pause and picks up from the
// current word when reading resumes.
import { useEffect, useRef, useState } from 'react';
import type { PublicState } from '../shared/types';

const KEY = 'qb:tts';
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v: string) { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } },
};

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/** This device's choice: read aloud here or stay quiet (for a room where one phone does the talking). */
export const speechOn = () => store.get() !== 'off';
export function setSpeechOn(on: boolean) {
  store.set(on ? 'on' : 'off');
  if (!on && speechSupported()) speechSynthesis.cancel();
  window.dispatchEvent(new Event('qb-tts'));
}
export function useSpeechOn(): boolean {
  const [on, setOn] = useState(speechOn);
  useEffect(() => {
    const f = () => setOn(speechOn());
    window.addEventListener('qb-tts', f);
    return () => window.removeEventListener('qb-tts', f);
  }, []);
  return on;
}

/** Whether this room reads aloud for this viewer: the setting is on, nobody holds the reader seat, and the text is shown. */
export function readAloudActive(s: PublicState) {
  const readerOnline = !!s.readerId && !!s.players.find((p) => p.id === s.readerId)?.online;
  return s.settings.readAloud && !readerOnline && !s.daily && !!s.tossup?.textVisible;
}

// iOS and some Android browsers only allow speech that starts inside a tap. Speaking an empty
// utterance on the first tap or key press unlocks it for the rest of the visit.
let unlocked = false;
function unlockOnGesture() {
  if (unlocked || !speechSupported()) return;
  const go = () => {
    if (unlocked) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

let voice: SpeechSynthesisVoice | null | undefined;
function pickVoice(): SpeechSynthesisVoice | null {
  if (voice !== undefined) return voice;
  const all = speechSynthesis.getVoices();
  if (!all.length) return null; // not loaded yet; try again next time
  const en = all.filter((v) => /^en(-|_|$)/i.test(v.lang));
  voice = en.find((v) => v.default) ?? en.find((v) => /en[-_]US/i.test(v.lang) && v.localService) ?? en.find((v) => v.localService) ?? en[0] ?? null;
  return voice;
}

/** Ends a phrase: punctuation, maybe followed by closing quotes or brackets. */
const PHRASE_END = /[.,;:!?…]["'”’)\]]*$/;

/**
 * Speak the current tossup aloud while it is read. Call once per screen that shows a tossup.
 * Words are voiced in short phrases as soon as they are revealed, slightly faster than the reveal
 * speed so speech keeps up instead of drifting behind.
 */
export function useReadAloud(s: PublicState | null) {
  const on = useSpeechOn();
  const t = s?.tossup;
  const reading = !!s && !!t && s.phase === 'reading' && !s.paused && !t.paused;
  const active = !!s && speechSupported() && on && readAloudActive(s) && reading;
  const st = useRef({ num: -1, spoken: 0, speaking: false, seq: 0 });
  const latest = useRef({ s, active });
  latest.current = { s, active };

  useEffect(() => { if (s?.settings.readAloud) unlockOnGesture(); }, [s?.settings.readAloud]);

  const pump = useRef(() => {});
  pump.current = () => {
    const { s: cur, active: live } = latest.current;
    const tt = cur?.tossup;
    const r = st.current;
    if (!live || !tt || r.speaking || tt.num !== r.num) return;
    const words = tt.revealed.slice(r.spoken).filter(Boolean);
    if (!words.length) return;
    // Wait for a natural phrase unless the question is fully read.
    const done = tt.revealed.length >= tt.totalWords;
    if (!done && words.length < 3 && !PHRASE_END.test(words[words.length - 1])) return;
    r.spoken = tt.revealed.length;
    r.speaking = true;
    const id = ++r.seq;
    const u = new SpeechSynthesisUtterance(words.join(' '));
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang ?? 'en-US';
    // At rate 1 most voices say about 175 words a minute; run a little ahead of the reveal.
    u.rate = Math.min(2.4, Math.max(0.6, ((cur!.settings.wpm || 150) / 175) * 1.1));
    // A cancelled phrase can report its end late; only the phrase still playing moves things on.
    const next = () => { const c = st.current; if (c.speaking && c.seq === id) { c.speaking = false; pump.current(); } };
    u.onend = next;
    u.onerror = next;
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
