/**
 * Character appearance catalogue: original, warm and diverse villagers and fair-goers. Attire is drawn
 * from many Indian regions (saree, nauvari, mekhela chador, salwar kameez, dhoti-kurta, mundu, pagri,
 * turban, everyday shirts and jeans) as everyday clothing, never as costume or caricature. Ages,
 * genders and skin tones vary. Appearance is a pure function of (role, variant) so the same seeded
 * variant always looks the same (ENG-03 reproducibility of stimuli).
 */
import type { CharacterRole } from '../../core/contracts.ts';
import { MELA } from '../palettes.ts';

export type LowerGarment =
  | 'sari'
  | 'nauvari'
  | 'mekhela'
  | 'dhoti'
  | 'mundu'
  | 'salwar'
  | 'pants'
  | 'lehenga';
export type UpperGarment = 'blouse' | 'kurta' | 'kurta_long' | 'shirt' | 'kameez' | 'vest_shirt';
export type Drape = 'none' | 'pallu' | 'dupatta' | 'gamcha' | 'shawl' | 'chador';
export type HairStyle = 'bun' | 'braid' | 'short' | 'bald_sides' | 'long_open' | 'bob' | 'covered';
export type Headwear = 'none' | 'pagri' | 'turban' | 'cap' | 'gajra' | 'pallu_head' | 'topi';
export type FacialHair = 'none' | 'moustache' | 'beard' | 'stubble';

export interface Appearance {
  readonly skin: number;
  readonly hair: number;
  readonly hairStyle: HairStyle;
  readonly headwear: Headwear;
  readonly headwearColor: number;
  readonly facialHair: FacialHair;
  readonly upper: UpperGarment;
  readonly upperColor: number;
  readonly upperTrim: number;
  readonly lower: LowerGarment;
  readonly lowerColor: number;
  readonly lowerBorder: number;
  readonly drape: Drape;
  readonly drapeColor: number;
  readonly glasses: boolean;
  readonly bindi: boolean;
  readonly tilak: boolean;
  readonly noseRing: boolean;
  readonly earrings: boolean;
  readonly bangles: boolean;
  /** 0 young adult .. 1 elder: wrinkles, grey hair, slight stoop. */
  readonly age: number;
  /** Body width factor (0.9 slim .. 1.15 broad). */
  readonly build: number;
  /** Height factor. */
  readonly height: number;
  readonly feminine: boolean;
  /** Holds a glowing lantern (the guide). */
  readonly lantern: boolean;
}

/** Warm range of skin tones. */
export const SKIN_TONES = [
  0x8d5a3b, 0xa86b45, 0xbf8558, 0x7a4b30, 0xc99468, 0x9c6240, 0x6e4129,
] as const;

const GREY = 0xd8d4d0;
const BLACK_HAIR = 0x231815;
const BROWN_HAIR = 0x3b2618;

/** The recurring guide: an elder market host with a brass lantern (name spoken only, never written). */
export const GUIDE_APPEARANCE: Appearance = {
  skin: 0xa86b45,
  hair: GREY,
  hairStyle: 'bun',
  headwear: 'gajra',
  headwearColor: 0xfff8f0,
  facialHair: 'none',
  upper: 'blouse',
  upperColor: MELA.marigold,
  upperTrim: MELA.vermilion,
  lower: 'sari',
  lowerColor: MELA.peacock,
  lowerBorder: MELA.marigold,
  drape: 'pallu',
  drapeColor: MELA.peacock,
  glasses: true,
  bindi: true,
  tilak: false,
  noseRing: false,
  earrings: true,
  bangles: true,
  age: 0.85,
  build: 1.05,
  height: 0.97,
  feminine: true,
  lantern: true,
};

/** Fair-goers: varied by region, age and gender (customers, partners, vendors...). */
export const VILLAGERS: readonly Appearance[] = [
  {
    // Young woman, salwar kameez with dupatta.
    skin: SKIN_TONES[2],
    hair: BLACK_HAIR,
    hairStyle: 'braid',
    headwear: 'none',
    headwearColor: 0,
    facialHair: 'none',
    upper: 'kameez',
    upperColor: MELA.rose,
    upperTrim: MELA.marigold,
    lower: 'salwar',
    lowerColor: MELA.cream,
    lowerBorder: MELA.rose,
    drape: 'dupatta',
    drapeColor: MELA.marigold,
    glasses: false,
    bindi: true,
    tilak: false,
    noseRing: false,
    earrings: true,
    bangles: true,
    age: 0.15,
    build: 0.95,
    height: 0.98,
    feminine: true,
    lantern: false,
  },
  {
    // Middle-aged man, white kurta and dhoti, saffron pagri.
    skin: SKIN_TONES[1],
    hair: BLACK_HAIR,
    hairStyle: 'short',
    headwear: 'pagri',
    headwearColor: MELA.saffron,
    facialHair: 'moustache',
    upper: 'kurta',
    upperColor: 0xf7f2e6,
    upperTrim: MELA.brass,
    lower: 'dhoti',
    lowerColor: 0xf7f2e6,
    lowerBorder: MELA.brass,
    drape: 'none',
    drapeColor: 0,
    glasses: false,
    bindi: false,
    tilak: true,
    noseRing: false,
    earrings: false,
    bangles: false,
    age: 0.5,
    build: 1.08,
    height: 1.04,
    feminine: false,
    lantern: false,
  },
  {
    // Older man, mundu with gold border and a pale shirt, glasses.
    skin: SKIN_TONES[3],
    hair: GREY,
    hairStyle: 'bald_sides',
    headwear: 'none',
    headwearColor: 0,
    facialHair: 'stubble',
    upper: 'shirt',
    upperColor: 0xbcd7e8,
    upperTrim: 0xffffff,
    lower: 'mundu',
    lowerColor: 0xfaf4e4,
    lowerBorder: MELA.brass,
    drape: 'gamcha',
    drapeColor: MELA.vermilion,
    glasses: true,
    bindi: false,
    tilak: false,
    noseRing: false,
    earrings: false,
    bangles: false,
    age: 0.8,
    build: 0.98,
    height: 0.96,
    feminine: false,
    lantern: false,
  },
  {
    // Young man, indigo kurta and jeans, cap.
    skin: SKIN_TONES[4],
    hair: BROWN_HAIR,
    hairStyle: 'short',
    headwear: 'cap',
    headwearColor: MELA.peacock,
    facialHair: 'none',
    upper: 'shirt',
    upperColor: MELA.indigo,
    upperTrim: MELA.marigold,
    lower: 'pants',
    lowerColor: 0x3d5a80,
    lowerBorder: 0x2c4260,
    drape: 'none',
    drapeColor: 0,
    glasses: false,
    bindi: false,
    tilak: false,
    noseRing: false,
    earrings: false,
    bangles: false,
    age: 0.1,
    build: 0.96,
    height: 1.03,
    feminine: false,
    lantern: false,
  },
  {
    // Middle-aged woman, nauvari-style saree, nose ring, gajra in her bun.
    skin: SKIN_TONES[0],
    hair: BLACK_HAIR,
    hairStyle: 'bun',
    headwear: 'gajra',
    headwearColor: 0xfff8f0,
    facialHair: 'none',
    upper: 'blouse',
    upperColor: MELA.kumkum,
    upperTrim: MELA.brass,
    lower: 'nauvari',
    lowerColor: 0x2e8b57,
    lowerBorder: MELA.kumkum,
    drape: 'pallu',
    drapeColor: 0x2e8b57,
    glasses: false,
    bindi: true,
    tilak: false,
    noseRing: true,
    earrings: true,
    bangles: true,
    age: 0.5,
    build: 1.04,
    height: 0.95,
    feminine: true,
    lantern: false,
  },
  {
    // Woman in mekhela chador, cream with red motifs.
    skin: SKIN_TONES[4],
    hair: BLACK_HAIR,
    hairStyle: 'bun',
    headwear: 'none',
    headwearColor: 0,
    facialHair: 'none',
    upper: 'blouse',
    upperColor: MELA.vermilion,
    upperTrim: MELA.brass,
    lower: 'mekhela',
    lowerColor: 0xf3e7c9,
    lowerBorder: MELA.vermilion,
    drape: 'chador',
    drapeColor: 0xf3e7c9,
    glasses: false,
    bindi: true,
    tilak: false,
    noseRing: false,
    earrings: true,
    bangles: true,
    age: 0.3,
    build: 0.96,
    height: 0.97,
    feminine: true,
    lantern: false,
  },
  {
    // Elder man in a turban, beard, long kurta.
    skin: SKIN_TONES[2],
    hair: GREY,
    hairStyle: 'covered',
    headwear: 'turban',
    headwearColor: MELA.lapis,
    facialHair: 'beard',
    upper: 'kurta_long',
    upperColor: 0xf0e6d0,
    upperTrim: MELA.lapis,
    lower: 'pants',
    lowerColor: 0xf0e6d0,
    lowerBorder: 0xe0d6c0,
    drape: 'none',
    drapeColor: 0,
    glasses: false,
    bindi: false,
    tilak: false,
    noseRing: false,
    earrings: false,
    bangles: false,
    age: 0.75,
    build: 1.06,
    height: 1.05,
    feminine: false,
    lantern: false,
  },
  {
    // Young woman, short bob, kurta and leggings.
    skin: SKIN_TONES[5],
    hair: BLACK_HAIR,
    hairStyle: 'bob',
    headwear: 'none',
    headwearColor: 0,
    facialHair: 'none',
    upper: 'kurta_long',
    upperColor: MELA.marigold,
    upperTrim: MELA.peacock,
    lower: 'pants',
    lowerColor: MELA.peacockDeep,
    lowerBorder: MELA.peacockDeep,
    drape: 'none',
    drapeColor: 0,
    glasses: true,
    bindi: false,
    tilak: false,
    noseRing: false,
    earrings: true,
    bangles: false,
    age: 0.12,
    build: 0.93,
    height: 1.0,
    feminine: true,
    lantern: false,
  },
  {
    // Vendor: man with a vest over his shirt and a gamcha, topi cap.
    skin: SKIN_TONES[6],
    hair: BLACK_HAIR,
    hairStyle: 'short',
    headwear: 'topi',
    headwearColor: 0xfaf4e4,
    facialHair: 'moustache',
    upper: 'vest_shirt',
    upperColor: 0xfaf4e4,
    upperTrim: MELA.kumkum,
    lower: 'pants',
    lowerColor: 0x5a4a3a,
    lowerBorder: 0x4a3a2a,
    drape: 'gamcha',
    drapeColor: MELA.peacock,
    glasses: false,
    bindi: false,
    tilak: false,
    noseRing: false,
    earrings: false,
    bangles: false,
    age: 0.4,
    build: 1.1,
    height: 1.0,
    feminine: false,
    lantern: false,
  },
  {
    // Elder woman in a shawl, plain saree.
    skin: SKIN_TONES[1],
    hair: GREY,
    hairStyle: 'covered',
    headwear: 'pallu_head',
    headwearColor: 0xd9a0b8,
    facialHair: 'none',
    upper: 'blouse',
    upperColor: 0x8a5a9a,
    upperTrim: MELA.brass,
    lower: 'sari',
    lowerColor: 0xd9a0b8,
    lowerBorder: 0x8a5a9a,
    drape: 'shawl',
    drapeColor: 0x7a4a3a,
    glasses: false,
    bindi: true,
    tilak: false,
    noseRing: true,
    earrings: true,
    bangles: true,
    age: 0.9,
    build: 0.98,
    height: 0.93,
    feminine: true,
    lantern: false,
  },
];

/** Variant id that selects the child figure (used only for the "under 18" picture band). */
export const CHILD_VARIANT = 999;

/** A child (under-18 band pictogram only; children never play, ONB-04). */
export const CHILD_APPEARANCE: Appearance = {
  skin: SKIN_TONES[2],
  hair: BLACK_HAIR,
  hairStyle: 'short',
  headwear: 'none',
  headwearColor: 0,
  facialHair: 'none',
  upper: 'shirt',
  upperColor: MELA.marigold,
  upperTrim: MELA.vermilion,
  lower: 'pants',
  lowerColor: MELA.lapis,
  lowerBorder: MELA.lapis,
  drape: 'none',
  drapeColor: 0,
  glasses: false,
  bindi: false,
  tilak: false,
  noseRing: false,
  earrings: false,
  bangles: false,
  age: 0,
  build: 0.82,
  height: 0.66,
  feminine: false,
  lantern: false,
};

/** Role-specific default variants (index into VILLAGERS). */
const ROLE_BASE: Readonly<Record<CharacterRole, number>> = {
  guide: -1,
  player: 3,
  customer: 0,
  assistant: 7,
  partner: 5,
  inspector: 6,
  vendor: 8,
};

/** Resolve the appearance for a role and seeded variant. */
export function appearanceFor(role: CharacterRole, variant = 0): Appearance {
  if (role === 'guide') return GUIDE_APPEARANCE;
  if (variant === CHILD_VARIANT) return CHILD_APPEARANCE;
  const n = VILLAGERS.length;
  const base = ROLE_BASE[role];
  const idx = (((base + variant) % n) + n) % n;
  const a = VILLAGERS[idx];
  if (!a) throw new Error(`appearanceFor: missing villager ${idx}`);
  return a;
}

/**
 * Cloth colourways for {@link withCloth}: [upper, upper trim, lower, lower border, drape, headwear].
 * Every colourway keeps a light/dark contrast between top and bottom so silhouettes stay readable.
 */
export const CLOTH_COLOURWAYS: readonly (readonly [
  number,
  number,
  number,
  number,
  number,
  number,
])[] = [
  [MELA.peacock, MELA.marigold, MELA.cream, MELA.peacock, MELA.marigold, MELA.saffron],
  [MELA.kumkum, MELA.brass, 0x2e8b57, MELA.marigold, MELA.marigold, MELA.kumkum],
  [MELA.marigold, MELA.vermilion, MELA.indigo, MELA.marigold, MELA.rose, MELA.lapis],
  [0xf7f2e6, MELA.lapis, MELA.lapis, MELA.cream, MELA.peacockLight, 0xf7f2e6],
  [MELA.rose, MELA.peacockDeep, MELA.peacockDeep, MELA.rose, MELA.cream, MELA.vermilion],
  [MELA.mango, MELA.kumkum, 0x5a4a3a, MELA.brass, MELA.saffron, MELA.mango],
  [MELA.lotus, MELA.indigo, MELA.cream, MELA.indigo, MELA.indigo, MELA.lotus],
  [MELA.saffron, MELA.cream, MELA.terracotta, MELA.cream, MELA.peacock, MELA.cream],
];

/**
 * Appearance with a cloth colour variant (0 = the original clothes). Skin, hair, build and attire cut
 * are unchanged, so a crowd can reuse a body with fresh colours. Pure and deterministic.
 */
export function withCloth(a: Appearance, cloth: number): Appearance {
  if (!cloth) return a;
  const n = CLOTH_COLOURWAYS.length;
  const cw = CLOTH_COLOURWAYS[(((cloth - 1) % n) + n) % n];
  if (!cw) return a;
  const [upper, trim, lower, border, drape, head] = cw;
  return {
    ...a,
    upperColor: upper,
    upperTrim: trim,
    lowerColor: lower,
    lowerBorder: border,
    drapeColor: a.drape === 'pallu' || a.drape === 'chador' ? lower : drape,
    headwearColor: a.headwear === 'gajra' ? a.headwearColor : head,
  };
}
