/**
 * Language-specific spoken prompt slots. Recorded native-speaker audio is dropped into
 * `public/audio/<language>/<slot>.mp3` (see public/audio/README.md); a missing file falls back
 * silently to the administrator reading the scripted instruction aloud (and a tone for feedback).
 */

import type { LanguageTag } from '../data/types.ts';

export const LANGUAGES: readonly { tag: LanguageTag; label: string }[] = [
  { tag: 'en-IN', label: 'English' },
  { tag: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { tag: 'mr-IN', label: 'मराठी (Marathi)' },
  { tag: 'ta-IN', label: 'தமிழ் (Tamil)' },
];

export const AUDIO_SLOTS = ['instructions', 'begin', 'correct', 'incorrect', 'finished'] as const;
export type AudioSlot = (typeof AUDIO_SLOTS)[number];

/** Instruction key of the registry entry (content/instruments/card-sort-criterion.yaml). */
export const INSTRUCTIONS_KEY = 'criterion.card_sort.instructions';

export function audioUrl(language: LanguageTag, slot: AudioSlot): string {
  return `./audio/${language}/${slot}.mp3`;
}

/** Administrator script (English) shown when a recording is missing; never shown to participants. */
export const ADMIN_SCRIPT: Readonly<Record<AudioSlot, string>> = {
  instructions:
    'Read aloud in the participant\'s language: "Look at these four cards. Each new card at the bottom goes with one of them. Touch the card you think it goes with. I cannot tell you how to match them, but after each touch you will see a tick if you were right or a cross if you were wrong. Try to get as many right as you can."',
  begin: 'Say: "Let us begin."',
  correct: '(tick shown with a high tone)',
  incorrect: '(cross shown with a low tone)',
  finished: 'Say: "Thank you, that is the end. Please give the tablet back."',
};

export interface AudioPlayer {
  play(slot: AudioSlot): Promise<boolean>;
  tone(kind: 'correct' | 'incorrect'): void;
}

/** Plays a slot; resolves false when the recording is missing or blocked. */
export function createAudioPlayer(language: LanguageTag): AudioPlayer {
  let ctx: AudioContext | null = null;
  return {
    play(slot) {
      return new Promise((resolve) => {
        if (typeof Audio === 'undefined') return resolve(false);
        const el = new Audio(audioUrl(language, slot));
        el.onended = () => resolve(true);
        el.onerror = () => resolve(false);
        el.play().catch(() => resolve(false));
      });
    },
    tone(kind) {
      try {
        const Ctor = globalThis.AudioContext;
        if (!Ctor) return;
        ctx ??= new Ctor();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = kind === 'correct' ? 880 : 220;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } catch {
        // audio unavailable: visual feedback still shows
      }
    },
  };
}
