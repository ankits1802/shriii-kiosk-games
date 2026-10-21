/**
 * Card model for the criterion card sort (WCST-style).
 *
 * Four key (stimulus) cards are always shown in the standard order
 * (one red triangle, two green stars, three yellow crosses, four blue circles). Response cards vary
 * on colour, shape and number; a 64-card deck holds every combination exactly once and a 128-card
 * administration uses two such decks back to back.
 */

export const COLOURS = ['red', 'green', 'yellow', 'blue'] as const;
export const SHAPES = ['triangle', 'star', 'cross', 'circle'] as const;
export const NUMBERS = [1, 2, 3, 4] as const;
export const DIMENSIONS = ['colour', 'shape', 'number'] as const;

export type Colour = (typeof COLOURS)[number];
export type Shape = (typeof SHAPES)[number];
export type CardNumber = (typeof NUMBERS)[number];
export type Dimension = (typeof DIMENSIONS)[number];
/** Index of a key card (0-3, left to right). */
export type KeyIndex = 0 | 1 | 2 | 3;

export interface Card {
  readonly colour: Colour;
  readonly shape: Shape;
  readonly number: CardNumber;
}

export const KEY_CARDS: readonly [Card, Card, Card, Card] = [
  { colour: 'red', shape: 'triangle', number: 1 },
  { colour: 'green', shape: 'star', number: 2 },
  { colour: 'yellow', shape: 'cross', number: 3 },
  { colour: 'blue', shape: 'circle', number: 4 },
];

export const KEY_INDICES: readonly KeyIndex[] = [0, 1, 2, 3];

/** Stable machine id, e.g. `green-star-3`. */
export function cardId(card: Card): string {
  return `${card.colour}-${card.shape}-${card.number}`;
}

export function parseCardId(id: string): Card {
  const [colour, shape, n] = id.split('-');
  const number = Number(n);
  if (
    !COLOURS.includes(colour as Colour) ||
    !SHAPES.includes(shape as Shape) ||
    !NUMBERS.includes(number as CardNumber)
  ) {
    throw new Error(`invalid card id: ${id}`);
  }
  return { colour: colour as Colour, shape: shape as Shape, number: number as CardNumber };
}

/** Dimensions on which `card` matches `key` (empty = an "other" response). */
export function matchingDimensions(card: Card, key: Card): Dimension[] {
  const out: Dimension[] = [];
  if (card.colour === key.colour) out.push('colour');
  if (card.shape === key.shape) out.push('shape');
  if (card.number === key.number) out.push('number');
  return out;
}

/** The key card that is correct for `card` under `rule` (exactly one key card always matches). */
export function correctKey(card: Card, rule: Dimension): KeyIndex {
  const idx = KEY_CARDS.findIndex((k) =>
    rule === 'colour'
      ? k.colour === card.colour
      : rule === 'shape'
        ? k.shape === card.shape
        : k.number === card.number,
  );
  return idx as KeyIndex;
}

/** Deterministic PRNG (mulberry32) so every participant sees the same standard card order. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allCombinations(): Card[] {
  const out: Card[] = [];
  for (const colour of COLOURS)
    for (const shape of SHAPES) for (const number of NUMBERS) out.push({ colour, shape, number });
  return out;
}

function sharesAttribute(a: Card, b: Card): boolean {
  return a.colour === b.colour || a.shape === b.shape || a.number === b.number;
}

/**
 * Build the fixed response-card sequence: `size / 64` shuffled copies of the 64-card deck.
 * Consecutive cards share no attribute value where a greedy repair after the seeded Fisher-Yates
 * shuffle can avoid it (the tail of a deck may keep a few), so repeats rarely cue the next sort.
 */
export function buildDeck(size: 64 | 128, seed: number): Card[] {
  const rand = mulberry32(seed);
  const out: Card[] = [];
  for (let d = 0; d < size / 64; d++) {
    const deck = allCombinations();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [deck[i], deck[j]] = [deck[j] as Card, deck[i] as Card];
    }
    for (let i = 0; i < deck.length; i++) {
      const prev = i === 0 ? out[out.length - 1] : deck[i - 1];
      const cur = deck[i] as Card;
      if (prev && sharesAttribute(prev, cur)) {
        const swap = deck.findIndex((c, j) => j > i && !sharesAttribute(prev, c));
        if (swap > i) [deck[i], deck[swap]] = [deck[swap] as Card, deck[i] as Card];
      }
    }
    out.push(...deck);
  }
  return out;
}
