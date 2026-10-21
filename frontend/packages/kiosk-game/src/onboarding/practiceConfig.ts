/**
 * ONB-05: practice timing and pass rules come from the warm-up game config
 * (`content/games/shared/warmup.json`), never from constants in the screen code:
 * - tap window and hold threshold from the level's `timing` (`tap_window_ms`, `hold_required_ms`);
 * - passes required per skill from the skill blocks' `min_trials`;
 * - the attempt cap from the skill blocks' `trials`.
 */
import type { GameConfig } from '@shriii/contracts';
import type { OnboardingConfig } from './types.ts';

const SKILL_BLOCKS = ['tap', 'hold', 'choice'] as const;

/** Derive the practice config for a level; throws when the warm-up config lacks a required field. */
export function practiceConfigFromWarmup(
  warmup: GameConfig,
  level: 'L1' | 'L2' | 'L3' = 'L2',
): OnboardingConfig['practice'] {
  const timing = warmup.levels[level].timing;
  const tapWindowMs = timing.tap_window_ms;
  const holdRequiredMs = timing.hold_required_ms;
  if (tapWindowMs === undefined || holdRequiredMs === undefined)
    throw new Error(`warm-up ${level} timing lacks tap_window_ms / hold_required_ms`);
  const blocks = SKILL_BLOCKS.map((id) => {
    const b = warmup.blocks.find((x) => x.block_id === id);
    if (!b) throw new Error(`warm-up config lacks the '${id}' practice block`);
    return b;
  });
  // The strictest skill rule applies to all three skills (they share one practice loop).
  const passesRequired = Math.max(...blocks.map((b) => b.min_trials));
  const maxAttempts = Math.min(...blocks.map((b) => b.trials));
  if (!(passesRequired >= 1 && maxAttempts >= passesRequired))
    throw new Error('warm-up practice blocks need 1 <= min_trials <= trials');
  return { tapWindowMs, holdRequiredMs, passesRequired, maxAttempts };
}
