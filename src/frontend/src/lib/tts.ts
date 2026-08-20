/**
 * Text-to-speech via the browser's built-in Web Speech API (chantier #13,
 * Recall's per-card "Listen" button). Free, no server round-trip, no extra
 * dependency — every modern browser ships `window.speechSynthesis`. Quality
 * is voice-dependent (varies by OS/browser) but that trade-off is explicitly
 * accepted in the roadmap note over the paid alternative (edge-tts server-side).
 *
 * A single module-level utterance is tracked so starting a new read always
 * cancels whatever was playing before — matches how every other "Listen"
 * button behaves (one thing reads at a time, never overlapping voices).
 */

export type TTSState = 'idle' | 'playing' | 'paused';

type Listener = (state: TTSState) => void;
const listeners = new Set<Listener>();
let currentState: TTSState = 'idle';
let currentUtterance: SpeechSynthesisUtterance | null = null;

function setState(s: TTSState) {
  currentState = s;
  listeners.forEach(l => l(s));
}

export function getTTSState(): TTSState {
  return currentState;
}

export function onTTSStateChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isTTSSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Pick the best available voice for the given language, preferring a local
 * (non-network) voice when one exists — noticeably lower latency. */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const prefix = lang.slice(0, 2);
  const matching = voices.filter(v => v.lang.toLowerCase().startsWith(prefix));
  return matching.find(v => v.localService) ?? matching[0] ?? voices[0];
}

/** Start reading `text` aloud. Cancels any utterance already in progress. */
export function speak(text: string, lang: 'fr' | 'en' = 'fr'): void {
  if (!isTTSSupported() || !text.trim()) return;
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'fr' ? 'fr-FR' : 'en-US';
  const voice = pickVoice(utterance.lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.0;

  utterance.onstart = () => setState('playing');
  utterance.onend = () => { currentUtterance = null; setState('idle'); };
  utterance.onerror = () => { currentUtterance = null; setState('idle'); };

  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function pauseTTS(): void {
  if (!isTTSSupported() || currentState !== 'playing') return;
  window.speechSynthesis.pause();
  setState('paused');
}

export function resumeTTS(): void {
  if (!isTTSSupported() || currentState !== 'paused') return;
  window.speechSynthesis.resume();
  setState('playing');
}

export function stopTTS(): void {
  if (!isTTSSupported()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
  setState('idle');
}
