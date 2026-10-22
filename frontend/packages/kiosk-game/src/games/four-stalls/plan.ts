/**
 * Four Stalls (MG-09, IGT-lite) schedule and payoff decks — pure and seeded.
 *
 * - Four mango stalls `stall_a..stall_d` (left to right; reading order in portrait). Two of them are
 *   high-variance (big gains, occasional big losses, lower expected value); which two is drawn per
 *   session (`constraints.high_variance_assignment: seeded`) so stall position never stands in for
 *   risk. Payoff ranges and loss rates come from `constraints.*_variance_gain|loss|loss_rate`.
 * - Each stall has a fixed deck (IGT-style): its k-th pick always yields the k-th card, so outcomes
 *   depend on the seed and the player's own picks only. Losses are placed exactly
 *   (round(rate x 10) per run of 10 picks).
 * - Repeated identical situations (`repeat_probe`): `repeat_groups` villagers each bring the same
 *   errand `repeat_presentations` times (same person, same request, same stalls, no payoff shown to
 *   the player). Their choices give `response_consistency.choice_entropy_repeats`
 *   (`params.repeat_group_id`). Errands never open the block and a group never repeats back to back.
 */
import type { GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';

export const STALL_CODES = ['stall_a', 'stall_b', 'stall_c', 'stall_d'] as const;
export type StallCode = (typeof STALL_CODES)[number];

export interface StallCard {
  readonly gain: number;
  readonly loss: number;
}

export interface FourStallsTrialPlan {
  /** 0-based position within the choices block. */
  readonly position: number;
  readonly kind: 'own' | 'errand';
  /** `stalls_repeat_<g>` for errands, null for the player's own purchases. */
  readonly repeatGroupId: string | null;
  /** Errand villager index (appearance) for errands. */
  readonly villager: number | null;
}

export interface FourStallsPlan {
  readonly trials: readonly FourStallsTrialPlan[];
  readonly highVariance: readonly StallCode[];
  readonly decks: Readonly<Record<StallCode, readonly StallCard[]>>;
  /** Expected net value per pick, by stall (diagnostics and tests). */
  readonly expected: Readonly<Record<StallCode, number>>;
}

function numbers(config: GameConfig, key: string): number[] {
  const v = (config.constraints as Record<string, unknown>)[key];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number')) {
    throw new Error(`four_stalls: constraints.${key} must be [min, max]`);
  }
  return v as number[];
}

function num(config: GameConfig, key: string): number {
  const v = (config.constraints as Record<string, unknown>)[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`four_stalls: constraints.${key} must be a number`);
  }
  return v;
}

/** A deck of `n` cards: gains uniform in range, exactly round(rate x 10) losses per 10 picks. */
export function buildDeck(
  n: number,
  gain: readonly number[],
  loss: readonly number[],
  lossRate: number,
  rng: SeededRng,
): StallCard[] {
  const [g0, g1] = gain as [number, number];
  const [l0, l1] = loss as [number, number];
  const perTen = Math.round(Math.max(0, Math.min(1, lossRate)) * 10);
  const cards: StallCard[] = [];
  for (let start = 0; start < n; start += 10) {
    const flags = rng.shuffle(Array.from({ length: 10 }, (_, i) => i < perTen));
    for (let i = 0; i < 10 && start + i < n; i++) {
      cards.push({
        gain: rng.int(g0, g1),
        loss: flags[i] ? rng.int(l0, l1) : 0,
      });
    }
  }
  return cards;
}

/** Place `groups` x `per` errands among `n` choices: not in the first `lead`, no back-to-back group. */
export function placeErrands(
  n: number,
  groups: number,
  per: number,
  lead: number,
  rng: SeededRng,
): (number | null)[] {
  const k = groups * per;
  if (k > n - lead) throw new Error('four_stalls: too many repeat probes for the block');
  for (let attempt = 0; attempt < 500; attempt++) {
    const r = rng.stream(`errands.${attempt}`);
    const slots: (number | null)[] = new Array<number | null>(n).fill(null);
    const positions = r.shuffle(Array.from({ length: n - lead }, (_, i) => i + lead)).slice(0, k);
    positions.sort((a, b) => a - b);
    const labels = r.shuffle(Array.from({ length: k }, (_, i) => i % groups));
    positions.forEach((p, i) => {
      slots[p] = labels[i] ?? 0;
    });
    let ok = true;
    for (let i = 1; i < n; i++) {
      const a = slots[i - 1];
      const b = slots[i];
      if (a !== null && a !== undefined && a === b) ok = false;
    }
    if (ok) return slots;
  }
  throw new Error('four_stalls: could not place repeat probes');
}

export function buildFourStallsPlan(
  config: GameConfig,
  rng: SeededRng,
  choices: number,
): FourStallsPlan {
  const groups = Math.round(num(config, 'repeat_groups'));
  const per = Math.round(num(config, 'repeat_presentations'));
  const hvCount = Math.round(num(config, 'high_variance_stalls'));
  const assignment = (config.constraints as Record<string, unknown>).high_variance_assignment;
  const highVariance: StallCode[] =
    assignment === 'seeded'
      ? rng
          .stream('high_variance')
          .shuffle([...STALL_CODES])
          .slice(0, hvCount)
          .sort()
      : [...STALL_CODES].slice(STALL_CODES.length - hvCount);
  const lowGain = numbers(config, 'low_variance_gain');
  const lowLoss = numbers(config, 'low_variance_loss');
  const lowRate = num(config, 'low_variance_loss_rate');
  const highGain = numbers(config, 'high_variance_gain');
  const highLoss = numbers(config, 'high_variance_loss');
  const highRate = num(config, 'high_variance_loss_rate');
  const decks = {} as Record<StallCode, StallCard[]>;
  const expected = {} as Record<StallCode, number>;
  for (const code of STALL_CODES) {
    const hv = highVariance.includes(code);
    decks[code] = buildDeck(
      choices,
      hv ? highGain : lowGain,
      hv ? highLoss : lowLoss,
      hv ? highRate : lowRate,
      rng.stream(`deck.${code}`),
    );
    const g = hv ? highGain : lowGain;
    const l = hv ? highLoss : lowLoss;
    const rate = Math.round((hv ? highRate : lowRate) * 10) / 10;
    expected[code] = ((g[0] ?? 0) + (g[1] ?? 0)) / 2 - rate * (((l[0] ?? 0) + (l[1] ?? 0)) / 2);
  }
  const slots = placeErrands(
    choices,
    groups,
    per,
    Math.min(4, choices - groups * per),
    rng.stream('placement'),
  );
  const villagers = rng.stream('villagers').shuffle([1, 2, 4, 6, 8, 9]).slice(0, groups);
  const trials: FourStallsTrialPlan[] = slots.map((g, position) =>
    g === null || g === undefined
      ? { position, kind: 'own', repeatGroupId: null, villager: null }
      : {
          position,
          kind: 'errand',
          repeatGroupId: `stalls_repeat_${g}`,
          villager: villagers[g] ?? g,
        },
  );
  return { trials, highVariance, decks, expected };
}
