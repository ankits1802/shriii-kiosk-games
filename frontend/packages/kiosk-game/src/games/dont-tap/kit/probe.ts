/**
 * Cross-module probe segments (MG-10: "cross-module probe trials support the style traits, >= 4
 * comparable segments"). Every Pathway B module ends with the same short probe block: a quick choice
 * between a sure small treat on an open plate (`safe`) and a covered pot that may hold more (`risky`).
 * The situations, sides, timing and art are identical in every module so the segments are comparable
 * (persistence of style); only the backdrop differs. No outcome is ever revealed (hypothetical
 * choice), so probes cannot teach anything that changes later behaviour.
 *
 * Conventions (scorer `cross_module.probe_segments`): block `probe`, trial type `probe`, response
 * `safe`/`risky`, `task.probe_group_id = <module>.probe` (one 4-trial segment per module) and
 * `params.repeat_group_id = probe_situation_<position>` (the same situation across modules).
 */
import type { Layout, Rect } from '../../../core/contracts.ts';

export type ProbeChoice = 'safe' | 'risky';
export type ProbeSide = 'left' | 'right';

/** One probe situation (pictured quantities only; never numerals). */
export interface ProbeSituation {
  readonly position: number;
  /** Sweets on the open plate. */
  readonly safeAmount: number;
  /** Sweets pictured (ghosted) behind the lid of the covered pot. */
  readonly riskyAmount: number;
  /** Side of the open plate. */
  readonly safeSide: ProbeSide;
}

/**
 * The fixed situation cycle (identical in every module and form, so segments stay comparable). Sides
 * are counterbalanced within the four situations; attractiveness of the pot varies from low to high.
 */
const SITUATIONS: readonly Omit<ProbeSituation, 'position'>[] = [
  { safeAmount: 2, riskyAmount: 3, safeSide: 'left' },
  { safeAmount: 1, riskyAmount: 3, safeSide: 'right' },
  { safeAmount: 1, riskyAmount: 4, safeSide: 'right' },
  { safeAmount: 2, riskyAmount: 4, safeSide: 'left' },
];

/** Situation at a probe position (cycles every four). */
export function probeSituation(position: number): ProbeSituation {
  const s = SITUATIONS[((position % SITUATIONS.length) + SITUATIONS.length) % SITUATIONS.length];
  if (!s) throw new RangeError(`no probe situation ${position}`);
  return { position, ...s };
}

/** Scoring params of a probe trial. */
export function probeParams(s: ProbeSituation): Record<string, unknown> {
  return {
    repeat_group_id: `probe_situation_${s.position}`,
    probe_index: s.position,
    safe_amount: s.safeAmount,
    risky_amount: s.riskyAmount,
    safe_side: s.safeSide,
  };
}

/** Target rects of the two probe choices (>= 20 mm, >= 8 mm apart, lower two-thirds). */
export function probeGeometry(layout: Layout): { readonly left: Rect; readonly right: Rect } {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const size = Math.max(metrics.minTargetPx * 2.6, Math.min(W, H) * (portrait ? 0.34 : 0.3));
  const gap = Math.max(metrics.minSpacingPx * 3, size * 0.35);
  const cy = portrait ? H * 0.64 : H * 0.66;
  const cx = W / 2;
  return {
    left: { x: cx - gap / 2 - size, y: cy - size / 2, width: size, height: size },
    right: { x: cx + gap / 2, y: cy - size / 2, width: size, height: size },
  };
}

/** Rect of a choice for a situation. */
export function probeRectFor(layout: Layout, s: ProbeSituation, choice: ProbeChoice): Rect {
  const g = probeGeometry(layout);
  const side: ProbeSide = choice === 'safe' ? s.safeSide : s.safeSide === 'left' ? 'right' : 'left';
  return side === 'left' ? g.left : g.right;
}
