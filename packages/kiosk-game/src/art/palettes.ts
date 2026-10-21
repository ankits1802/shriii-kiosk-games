/**
 * "Mela at golden hour" palette system.
 *
 * - {@link MELA} holds the named pigments of the art direction (turmeric, saffron, marigold, vermilion,
 *   peacock teal, indigo dusk, soft cream...).
 * - {@link KIOSK_PALETTE} is the contract {@link Palette}: colour-blind-safe UI tokens. Colour is never
 *   the only cue: every token is paired with a shape and an icon (KSK-06).
 * - {@link TIME_PALETTES} drive the lighting of every backdrop. A scene's time of day is a continuous
 *   parameter; {@link scenePaletteAt} interpolates between keyframes so the fair can glide from bright
 *   afternoon (The Stall) to late golden afternoon (The Weighing Post) to sunset and dusk (The Road Home).
 */
import type { Palette, TimeOfDay } from '../core/contracts.ts';
import { clamp, lerp, mixColor } from './color.ts';

/** Named pigments of the art direction. */
export const MELA = {
  turmeric: 0xe3a92b,
  saffron: 0xf28c28,
  marigold: 0xf6b11f,
  marigoldDeep: 0xe8871e,
  vermilion: 0xd9402b,
  kumkum: 0xb8282f,
  rose: 0xe56b7f,
  lotus: 0xf2a7b5,
  peacock: 0x0f7c7a,
  peacockDeep: 0x0a5a63,
  peacockLight: 0x46b3a6,
  indigo: 0x2e2a5a,
  indigoDeep: 0x1b1838,
  lapis: 0x2f5fa7,
  mango: 0x7aa33c,
  neem: 0x4f7a3a,
  banyan: 0x3e6b3a,
  leafDark: 0x2c4a2a,
  cream: 0xfff4de,
  parchment: 0xf6e3bf,
  sandstone: 0xd9a66b,
  terracotta: 0xb85c38,
  clay: 0x9c5a3c,
  earth: 0x7a4a2e,
  wood: 0x6b4128,
  woodDark: 0x43281a,
  brass: 0xd4a23c,
  brassLight: 0xf5d47a,
  ink: 0x2b1b17,
  smoke: 0x6e6470,
  white: 0xffffff,
} as const;

/** Contract palette: UI and accent tokens (colour-blind-safe pairs; shapes also differ). */
export const KIOSK_PALETTE: Palette = {
  sky: 0x9ed0ea,
  sun: 0xffd27a,
  earth: MELA.sandstone,
  foliage: MELA.neem,
  accentA: MELA.saffron,
  accentB: MELA.peacock,
  accentC: MELA.indigo,
  ink: MELA.ink,
  paper: MELA.cream,
  // Confirm = teal-blue circle + tick; cancel = burnt-orange rounded square + cross.
  // Blue/orange stays separable for protan/deutan/tritan viewers (dE > 50) and both faces keep the
  // cream icon above 4.5:1 contrast (KSK-06).
  confirm: 0x12707a,
  cancel: 0xc2410c,
};

/** Every colour a backdrop needs for one lighting state. */
export interface ScenePalette {
  /** Sky gradient stops top -> horizon. */
  readonly skyTop: number;
  readonly skyMid: number;
  readonly skyLow: number;
  readonly skyHorizon: number;
  /** Sun disc and halo. */
  readonly sun: number;
  readonly sunHalo: number;
  /** Sun position in normalised stage coordinates (0..1); y > horizon means set. */
  readonly sunX: number;
  readonly sunY: number;
  readonly sunRadius: number;
  /** Cloud body, lit rim and shadow. */
  readonly cloud: number;
  readonly cloudLit: number;
  readonly cloudShade: number;
  /** Atmospheric haze colour mixed into far layers. */
  readonly haze: number;
  /** Hill ridges, far -> near. */
  readonly hillFar: number;
  readonly hillMid: number;
  readonly hillNear: number;
  /** Ground and path. */
  readonly ground: number;
  readonly groundShade: number;
  readonly path: number;
  /** Multiplicative light tint for props, characters and foliage. */
  readonly lightTint: number;
  /** Rim light colour for silhouettes. */
  readonly rim: number;
  /** Shadow colour and strength. */
  readonly shadow: number;
  readonly shadowAlpha: number;
  /** 0..1: lamps, diyas and string lights glow intensity. */
  readonly lights: number;
  /** 0..1: star visibility. */
  readonly stars: number;
  /** 0..1: fireflies density. */
  readonly fireflies: number;
  /** 0..1: godray strength. */
  readonly godrays: number;
  /** 0..1: dust mote density in the light. */
  readonly dust: number;
  /** Long-shadow direction (-1 left .. 1 right) and length factor. */
  readonly shadowDir: number;
  readonly shadowLength: number;
  /** Colour grade: saturation and brightness multipliers. */
  readonly saturation: number;
  readonly brightness: number;
  /** Vignette strength 0..1. */
  readonly vignette: number;
}

const morning: ScenePalette = {
  skyTop: 0x7fbde3,
  skyMid: 0xb9def0,
  skyLow: 0xe6efe8,
  skyHorizon: 0xfbe2b6,
  sun: 0xfff6d8,
  sunHalo: 0xfff0c0,
  sunX: 0.2,
  sunY: 0.2,
  sunRadius: 0.045,
  cloud: 0xf6f3ee,
  cloudLit: 0xffffff,
  cloudShade: 0xc9d3dc,
  haze: 0xdfe9ee,
  hillFar: 0xa7bccb,
  hillMid: 0x8eab98,
  hillNear: 0x6f9363,
  ground: 0xd2a874,
  groundShade: 0xa27a50,
  path: 0xe6c998,
  lightTint: 0xfffaf2,
  rim: 0xfff4d6,
  shadow: 0x3a3040,
  shadowAlpha: 0.22,
  lights: 0,
  stars: 0,
  fireflies: 0,
  godrays: 0.25,
  dust: 0.3,
  shadowDir: 1,
  shadowLength: 0.9,
  saturation: 1.0,
  brightness: 1.03,
  vignette: 0.25,
};

/** Bright afternoon: The Stall. */
const midday: ScenePalette = {
  skyTop: 0x3f9ad6,
  skyMid: 0x86c6e8,
  skyLow: 0xcfe7ee,
  skyHorizon: 0xf7e3b8,
  sun: 0xfffbe8,
  sunHalo: 0xfff3c8,
  sunX: 0.78,
  sunY: 0.1,
  sunRadius: 0.04,
  cloud: 0xfbf8f2,
  cloudLit: 0xffffff,
  cloudShade: 0xc6d4e2,
  haze: 0xd8e8f0,
  hillFar: 0x9cb6c8,
  hillMid: 0x7f9f8c,
  hillNear: 0x678d55,
  ground: 0xd9a96a,
  groundShade: 0xa8703f,
  path: 0xecc890,
  lightTint: 0xfffbf3,
  rim: 0xffffff,
  shadow: 0x3b2c34,
  shadowAlpha: 0.26,
  lights: 0,
  stars: 0,
  fireflies: 0,
  godrays: 0.15,
  dust: 0.35,
  shadowDir: -0.4,
  shadowLength: 0.45,
  saturation: 1.06,
  brightness: 1.04,
  vignette: 0.22,
};

/** Late golden afternoon: The Weighing Post. */
const goldenHour: ScenePalette = {
  skyTop: 0x4a78b8,
  skyMid: 0xeaa86a,
  skyLow: 0xffb35c,
  skyHorizon: 0xff8a3d,
  sun: 0xfff6d0,
  sunHalo: 0xffa840,
  sunX: 0.7,
  sunY: 0.3,
  sunRadius: 0.05,
  cloud: 0xe9a98a,
  cloudLit: 0xffe2a8,
  cloudShade: 0xb07a86,
  haze: 0xf0b07a,
  hillFar: 0xc48a86,
  hillMid: 0x9a6e62,
  hillNear: 0x6e6a40,
  ground: 0xcf8d4c,
  groundShade: 0x8e5230,
  path: 0xe9b072,
  lightTint: 0xffe2bc,
  rim: 0xffcf7a,
  shadow: 0x4a2234,
  shadowAlpha: 0.34,
  lights: 0.45,
  stars: 0,
  fireflies: 0,
  godrays: 0.8,
  dust: 0.9,
  shadowDir: -1,
  shadowLength: 1.6,
  saturation: 1.1,
  brightness: 1.0,
  vignette: 0.26,
};

/** Sunset into dusk: The Road Home. */
const dusk: ScenePalette = {
  skyTop: 0x1e2150,
  skyMid: 0x5b4687,
  skyLow: 0xd8697a,
  skyHorizon: 0xffa866,
  sun: 0xffc27a,
  sunHalo: 0xff7e52,
  sunX: 0.62,
  sunY: 0.555,
  sunRadius: 0.06,
  cloud: 0x7a5a8c,
  cloudLit: 0xff9e7a,
  cloudShade: 0x463a6c,
  haze: 0x9a6a8c,
  hillFar: 0x5e4c7c,
  hillMid: 0x433965,
  hillNear: 0x2c2848,
  ground: 0x806066,
  groundShade: 0x523a48,
  path: 0xb08a82,
  lightTint: 0xb9a9dc,
  rim: 0xff9f70,
  shadow: 0x150f2a,
  shadowAlpha: 0.38,
  lights: 1,
  stars: 0.8,
  fireflies: 1,
  godrays: 0.35,
  dust: 0.2,
  shadowDir: -1,
  shadowLength: 2.2,
  saturation: 1.05,
  brightness: 0.97,
  vignette: 0.34,
};

/** Lighting keyframes by time of day. */
export const TIME_PALETTES: Readonly<Record<TimeOfDay, ScenePalette>> = {
  morning,
  midday,
  golden_hour: goldenHour,
  dusk,
};

/** Order of the keyframes on the continuous time axis (0 = morning .. 3 = dusk). */
export const TIME_ORDER: readonly TimeOfDay[] = ['morning', 'midday', 'golden_hour', 'dusk'];

/** Continuous time value of a keyframe. */
export function timeValueOf(tod: TimeOfDay): number {
  return TIME_ORDER.indexOf(tod);
}

const COLOR_KEYS = [
  'skyTop',
  'skyMid',
  'skyLow',
  'skyHorizon',
  'sun',
  'sunHalo',
  'cloud',
  'cloudLit',
  'cloudShade',
  'haze',
  'hillFar',
  'hillMid',
  'hillNear',
  'ground',
  'groundShade',
  'path',
  'lightTint',
  'rim',
  'shadow',
] as const satisfies readonly (keyof ScenePalette)[];

const NUMBER_KEYS = [
  'sunX',
  'sunY',
  'sunRadius',
  'shadowAlpha',
  'lights',
  'stars',
  'fireflies',
  'godrays',
  'dust',
  'shadowDir',
  'shadowLength',
  'saturation',
  'brightness',
  'vignette',
] as const satisfies readonly (keyof ScenePalette)[];

/** Interpolate two palettes (colours in linear light, numbers linearly). */
export function lerpScenePalette(a: ScenePalette, b: ScenePalette, t: number): ScenePalette {
  const out: Record<string, number> = {};
  for (const k of COLOR_KEYS) out[k] = mixColor(a[k], b[k], t);
  for (const k of NUMBER_KEYS) out[k] = lerp(a[k], b[k], t);
  return out as unknown as ScenePalette;
}

/** Palette at a continuous time value in [0, 3] (0 morning, 1 midday, 2 golden hour, 3 dusk). */
export function scenePaletteAt(time: number): ScenePalette {
  const t = clamp(time, 0, TIME_ORDER.length - 1);
  const i = Math.min(Math.floor(t), TIME_ORDER.length - 2);
  const a = TIME_PALETTES[TIME_ORDER[i] ?? 'midday'];
  const b = TIME_PALETTES[TIME_ORDER[i + 1] ?? 'dusk'];
  return lerpScenePalette(a, b, t - i);
}
