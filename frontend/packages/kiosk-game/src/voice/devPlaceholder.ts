/**
 * DEV-ONLY placeholder voice (Web Speech synthesis) and its "DEV VOICE" badge.
 *
 * This module is reachable only through a dynamic import guarded by
 * `import.meta.env.DEV && import.meta.env.VITE_DEV_VOICE_PLACEHOLDER === 'true'`, which Vite replaces with
 * `false` in production builds, so neither the synthesis code, the badge nor the reference text is
 * shipped (tested by `voice/stripping.test.ts`). Production plays recorded clips only (VOX-01).
 */
import { REFERENCE_TEXT } from './catalogue/reference-text.generated.ts';

export interface PlaceholderSpeech {
  readonly started: Promise<number>;
  readonly ended: Promise<{
    readonly status: 'completed' | 'interrupted';
    readonly durationMs: number;
  }>;
  cancel(): void;
}

const BADGE_ID = 'shriii-dev-voice-badge';

/** Show the small fixed "DEV VOICE" badge (idempotent). Subtitles are never shown to players. */
export function showDevVoiceBadge(): void {
  if (typeof document === 'undefined' || document.getElementById(BADGE_ID)) return;
  const el = document.createElement('div');
  el.id = BADGE_ID;
  el.setAttribute('data-testid', 'dev-voice-badge');
  el.textContent = 'DEV VOICE';
  Object.assign(el.style, {
    position: 'fixed',
    right: '10px',
    bottom: '10px',
    zIndex: '99999',
    padding: '4px 8px',
    borderRadius: '6px',
    background: 'rgba(216,64,43,0.92)',
    color: '#fff',
    font: '600 11px/1.2 system-ui, sans-serif',
    letterSpacing: '0.08em',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
}

/** Reference text for a line (dev only). */
export function referenceText(lineId: string): string | null {
  return REFERENCE_TEXT[lineId] ?? null;
}

/**
 * Speak reference text with Web Speech. Falls back to a silent timer of the target duration when
 * synthesis is unavailable or never reports an end (headless browsers), so dev flows keep moving.
 */
export function speakPlaceholder(
  lineIds: readonly string[],
  targetDurationMs: number,
  now: () => number,
): PlaceholderSpeech {
  showDevVoiceBadge();
  const text = lineIds
    .map((id) => REFERENCE_TEXT[id] ?? '')
    .filter(Boolean)
    .join(' ');
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let resolveStart: (t: number) => void = () => undefined;
  let resolveEnd: (r: { status: 'completed' | 'interrupted'; durationMs: number }) => void = () =>
    undefined;
  const started = new Promise<number>((r) => {
    resolveStart = r;
  });
  const ended = new Promise<{ status: 'completed' | 'interrupted'; durationMs: number }>((r) => {
    resolveEnd = r;
  });
  let startAt: number | null = null;
  let done = false;
  const finish = (status: 'completed' | 'interrupted'): void => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    if (startAt === null) {
      startAt = now();
      resolveStart(startAt);
    }
    resolveEnd({ status, durationMs: Math.max(0, now() - startAt) });
  };
  const fallback = setTimeout(() => finish('completed'), Math.max(1200, targetDurationMs * 1.6));
  if (synth && text && typeof SpeechSynthesisUtterance !== 'undefined') {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN';
    const voice =
      synth.getVoices().find((v) => v.lang === 'en-IN') ??
      synth.getVoices().find((v) => v.lang.startsWith('en'));
    if (voice) u.voice = voice;
    u.rate = 0.95;
    u.onstart = () => {
      startAt = now();
      resolveStart(startAt);
    };
    u.onend = () => finish('completed');
    u.onerror = () => finish('interrupted');
    synth.speak(u);
  } else {
    startAt = now();
    resolveStart(startAt);
  }
  return {
    started,
    ended,
    cancel: () => {
      synth?.cancel();
      finish('interrupted');
    },
  };
}
