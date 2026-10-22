/**
 * Road Home lighting: the episode's story clock runs from sunset through dusk into a starry night
 * with moonrise. Keyframes extend the art kit's {@link ScenePalette} (sunset is the kit's golden hour
 * lowered, dusk is the kit's dusk) with two night states, plus moon and lantern values. The active
 * palette is published to the shared {@link Lighting} so characters, props and particles all share
 * one light.
 */
import { lerp, mixColor } from '../../../art/color.ts';
import { lerpScenePalette, type ScenePalette, TIME_PALETTES } from '../../../art/palettes.ts';

/** Episode palette: the kit's scene palette plus night extras. */
export interface RoadPalette extends ScenePalette {
  /** Moon disc position (normalised) and visibility 0..1. */
  readonly moonX: number;
  readonly moonY: number;
  readonly moonAlpha: number;
  /** Warm lantern/window glow colour. */
  readonly lamp: number;
  /** Ambient multiply tint for the top-down map (night darkens and cools it). */
  readonly mapTint: number;
  /** Strength of the night overlay on the map (0 day .. 1 deep night). */
  readonly night: number;
  /** River surface colours. */
  readonly water: number;
  readonly waterLit: number;
}

const sunset: RoadPalette = {
  ...TIME_PALETTES.golden_hour,
  skyTop: 0x5a6fae,
  skyMid: 0xc98aa0,
  skyLow: 0xf7a46e,
  skyHorizon: 0xffd08a,
  sun: 0xffe2a0,
  sunHalo: 0xffa65a,
  sunX: 0.7,
  sunY: 0.5,
  sunRadius: 0.075,
  lights: 0.35,
  stars: 0,
  fireflies: 0.15,
  godrays: 0.8,
  dust: 0.7,
  shadowDir: -1,
  shadowLength: 2.4,
  moonX: 0.16,
  moonY: 0.72,
  moonAlpha: 0,
  lamp: 0xffc46a,
  mapTint: 0xfff0dc,
  night: 0,
  water: 0x4f86a8,
  waterLit: 0xf7c27e,
};

const dusk: RoadPalette = {
  ...TIME_PALETTES.dusk,
  moonX: 0.18,
  moonY: 0.62,
  moonAlpha: 0.15,
  lamp: 0xffb85a,
  mapTint: 0xcdb4d6,
  night: 0.35,
  water: 0x3d4f86,
  waterLit: 0xd88aa0,
};

const night: RoadPalette = {
  ...TIME_PALETTES.dusk,
  skyTop: 0x0c1030,
  skyMid: 0x1d2357,
  skyLow: 0x3a3a78,
  skyHorizon: 0x6b5a92,
  sun: 0xffc27a,
  sunHalo: 0x8a4a6a,
  sunX: 0.62,
  sunY: 0.66,
  sunRadius: 0.05,
  cloud: 0x2c2f5c,
  cloudLit: 0x7a76b4,
  cloudShade: 0x1a1c40,
  haze: 0x3c3f78,
  hillFar: 0x2a2c5c,
  hillMid: 0x1f2148,
  hillNear: 0x15173a,
  ground: 0x3e3a5c,
  groundShade: 0x26243e,
  path: 0x6c6488,
  lightTint: 0x8a90c8,
  rim: 0x9fb4ff,
  shadow: 0x070818,
  shadowAlpha: 0.42,
  lights: 1,
  stars: 1,
  fireflies: 1,
  godrays: 0,
  dust: 0.05,
  shadowDir: 1,
  shadowLength: 1.2,
  saturation: 0.92,
  brightness: 0.86,
  vignette: 0.42,
  moonX: 0.24,
  moonY: 0.34,
  moonAlpha: 0.85,
  lamp: 0xffb04a,
  mapTint: 0x8090cc,
  night: 0.72,
  water: 0x23305e,
  waterLit: 0xbfc8ff,
};

const deepNight: RoadPalette = {
  ...night,
  skyTop: 0x070a24,
  skyMid: 0x141a48,
  skyLow: 0x2a2f66,
  skyHorizon: 0x47507e,
  lightTint: 0x9aa2d8,
  rim: 0xc4d2ff,
  moonX: 0.3,
  moonY: 0.18,
  moonAlpha: 1,
  stars: 1,
  brightness: 0.9,
  mapTint: 0x8a98d0,
  night: 0.8,
  waterLit: 0xdfe6ff,
};

/** Keyframes on the story clock (0 sunset .. 1 deep night). */
const KEYS: readonly (readonly [number, RoadPalette])[] = [
  [0, sunset],
  [0.36, dusk],
  [0.62, night],
  [1, deepNight],
];

const EXTRA_COLORS = ['lamp', 'mapTint', 'water', 'waterLit'] as const;
const EXTRA_NUMBERS = ['moonX', 'moonY', 'moonAlpha', 'night'] as const;

function lerpRoad(a: RoadPalette, b: RoadPalette, t: number): RoadPalette {
  const base = lerpScenePalette(a, b, t) as ScenePalette & Record<string, number>;
  const out: Record<string, number> = { ...base };
  for (const k of EXTRA_COLORS) out[k] = mixColor(a[k], b[k], t);
  for (const k of EXTRA_NUMBERS) out[k] = lerp(a[k], b[k], t);
  return out as unknown as RoadPalette;
}

/** Palette at story time `t` in [0, 1]. */
export function roadPaletteAt(t: number): RoadPalette {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i + 1 < KEYS.length; i += 1) {
    const [t0, p0] = KEYS[i] as readonly [number, RoadPalette];
    const [t1, p1] = KEYS[i + 1] as readonly [number, RoadPalette];
    if (x <= t1) {
      const k = (x - t0) / (t1 - t0);
      // Smoothstep so the light glides rather than snaps between keyframes.
      return lerpRoad(p0, p1, k * k * (3 - 2 * k));
    }
  }
  return deepNight;
}
