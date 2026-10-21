/**
 * Music cue definitions: tempo, raga, layers and densities per scene. A cue never encodes performance:
 * the `pressure` cue (timed rush) is chosen by block condition, never by score, so music cannot reveal
 * how a player is doing (ENG-11).
 */
import type { MusicCueId } from '../../core/contracts.ts';
import type { TablaStroke } from '../synth.ts';
import type { RagaId } from '../theory.ts';

export interface TablaPattern {
  /** Strokes per beat subdivision; `null` = rest. Length = beats x subdivisions. */
  readonly strokes: readonly (TablaStroke | null)[];
  readonly subdivisions: number;
}

export interface CueDef {
  readonly bpm: number;
  readonly raga: RagaId;
  /** Relative layer levels 0..1 (0 = layer off). */
  readonly drone: number;
  readonly tabla: number;
  readonly melody: number;
  readonly tension: number;
  readonly ghungroo: number;
  readonly pattern: TablaPattern;
  /** Probability a melody phrase plays in a 2-bar slot (call and response breathing room). */
  readonly melodyDensity: number;
  /** Melody register (octave offset for degree 0). */
  readonly melodyOctave: number;
}

/** Keherwa (8 beats), one stroke per half-beat. */
export const KEHERWA: TablaPattern = {
  subdivisions: 2,
  strokes: [
    'dha',
    null,
    'ge',
    null,
    'na',
    'ti',
    'na',
    null,
    'ke',
    null,
    'na',
    null,
    'dhin',
    'na',
    'na',
    null,
  ],
};

/** Dadra (6 beats), lilting. */
export const DADRA: TablaPattern = {
  subdivisions: 2,
  strokes: ['dha', null, 'dhin', null, 'na', null, 'dha', null, 'tin', null, 'na', null],
};

/** Gentle half-time keherwa for calm scenes. */
export const SOFT_KEHERWA: TablaPattern = {
  subdivisions: 2,
  strokes: [
    'dha',
    null,
    null,
    null,
    'na',
    null,
    null,
    'ti',
    'ge',
    null,
    null,
    null,
    'na',
    null,
    'tin',
    null,
  ],
};

/** Driving pattern for the pressure/tension layer. */
export const RUSH: TablaPattern = {
  subdivisions: 4,
  strokes: [
    'dha',
    'ti',
    'na',
    'ti',
    'ge',
    'ti',
    'na',
    'ke',
    'dha',
    'ti',
    'na',
    'ti',
    'dhin',
    'na',
    'ke',
    'ti',
  ],
};

export const CUES: Readonly<Record<MusicCueId, CueDef>> = {
  attract: {
    bpm: 84,
    raga: 'bhupali',
    drone: 0.9,
    tabla: 0.55,
    melody: 0.9,
    tension: 0,
    ghungroo: 0.4,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.75,
    melodyOctave: 1,
  },
  onboarding: {
    bpm: 72,
    raga: 'bhupali',
    drone: 0.85,
    tabla: 0,
    melody: 0.5,
    tension: 0,
    ghungroo: 0,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.4,
    melodyOctave: 1,
  },
  hub: {
    bpm: 92,
    raga: 'bhupali',
    drone: 0.8,
    tabla: 0.7,
    melody: 0.8,
    tension: 0,
    ghungroo: 0.5,
    pattern: KEHERWA,
    melodyDensity: 0.6,
    melodyOctave: 1,
  },
  stall: {
    bpm: 100,
    raga: 'bhupali',
    drone: 0.7,
    tabla: 0.75,
    melody: 0.65,
    tension: 0,
    ghungroo: 0.3,
    pattern: DADRA,
    melodyDensity: 0.5,
    melodyOctave: 1,
  },
  weighing_post: {
    bpm: 76,
    raga: 'durga',
    drone: 0.9,
    tabla: 0.45,
    melody: 0.6,
    tension: 0,
    ghungroo: 0.2,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.45,
    melodyOctave: 1,
  },
  road_home: {
    bpm: 66,
    raga: 'megh',
    drone: 1,
    tabla: 0.35,
    melody: 0.75,
    tension: 0,
    ghungroo: 0.35,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.55,
    melodyOctave: 1,
  },
  pressure: {
    bpm: 116,
    raga: 'bhupali',
    drone: 0.7,
    tabla: 0.8,
    melody: 0,
    tension: 0.8,
    ghungroo: 0,
    pattern: RUSH,
    melodyDensity: 0,
    melodyOctave: 1,
  },
  report: {
    bpm: 70,
    raga: 'durga',
    drone: 0.9,
    tabla: 0.3,
    melody: 0.85,
    tension: 0,
    ghungroo: 0.3,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.7,
    melodyOctave: 1,
  },
  farewell: {
    bpm: 64,
    raga: 'megh',
    drone: 1,
    tabla: 0,
    melody: 0.7,
    tension: 0,
    ghungroo: 0.25,
    pattern: SOFT_KEHERWA,
    melodyDensity: 0.6,
    melodyOctave: 1,
  },
};
