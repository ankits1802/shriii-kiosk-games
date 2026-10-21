/**
 * Musical constants for the procedural score. Everything is in one fixed key so drone, melody, chimes
 * and SFX always agree: Sa = D3 (146.83 Hz), a comfortable tanpura pitch.
 *
 * Scales are pentatonic ragas (no "wrong" notes possible): Bhupali (Sa Re Ga Pa Dha) for bright
 * daytime cues, Durga (Sa Re Ma Pa Dha) for golden hour, and a gentle Megh-like (Sa Re Ma Pa Ni) for
 * dusk and the road home.
 */

/** Tonic (Sa) in Hz. */
export const SA_HZ = 146.83;

/** Just-intonation ratios of the 12 swaras relative to Sa. */
export const SWARA_RATIO = {
  Sa: 1,
  re: 16 / 15,
  Re: 9 / 8,
  ga: 6 / 5,
  Ga: 5 / 4,
  Ma: 4 / 3,
  ma: 45 / 32,
  Pa: 3 / 2,
  dha: 8 / 5,
  Dha: 5 / 3,
  ni: 9 / 5,
  Ni: 15 / 8,
} as const;

export type Swara = keyof typeof SWARA_RATIO;

export type RagaId = 'bhupali' | 'durga' | 'megh';

/** Pentatonic scales (ascending swaras within one octave). */
export const RAGAS: Readonly<Record<RagaId, readonly Swara[]>> = {
  bhupali: ['Sa', 'Re', 'Ga', 'Pa', 'Dha'],
  durga: ['Sa', 'Re', 'Ma', 'Pa', 'Dha'],
  megh: ['Sa', 'Re', 'Ma', 'Pa', 'ni'],
};

/** Frequency of scale degree `degree` (0 = Sa of the base octave, may be negative) in a raga. */
export function degreeHz(raga: RagaId, degree: number, octave = 1): number {
  const scale = RAGAS[raga];
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  const sw = scale[idx] ?? 'Sa';
  return SA_HZ * SWARA_RATIO[sw] * 2 ** (oct + octave);
}

/** Frequency of a swara at an octave offset (0 = the Sa_HZ octave). */
export function swaraHz(sw: Swara, octave = 0): number {
  return SA_HZ * SWARA_RATIO[sw] * 2 ** octave;
}

/** Seconds per beat for a tempo in BPM. */
export function beatSeconds(bpm: number): number {
  return 60 / bpm;
}
