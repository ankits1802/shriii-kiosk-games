/**
 * Block planning from the module config (`content/games/pathway-b/*.json`). Block lengths, minimums
 * and condition flags are read from the config; nothing is hard-coded. The kit's wrap-up rule: after
 * a soft-cap wrap-up request, a block stops once its protected minimum (`min_trials`) is reached.
 */
import type { BlockConfig, GameConfig } from '@shriii/contracts';
import type { PlannedBlock } from './types.ts';

/** Plan one config block (optionally with a session-specific length inside its bounds). */
export function planBlock(block: BlockConfig, length?: number): PlannedBlock {
  const trials = length ?? block.trials;
  if (!Number.isInteger(trials) || trials < 0) {
    throw new RangeError(`block ${block.block_id}: invalid length ${trials}`);
  }
  return {
    blockId: block.block_id,
    phase: block.phase,
    conditionId: block.condition_id,
    scorable: block.scorable,
    trials,
    minTrials: Math.min(block.min_trials, trials),
    timer: block.conditions.timer,
    noise: block.conditions.noise,
    shiftActive: block.conditions.shift_active,
  };
}

/** The config block with this id (throws when absent: fail closed). */
export function configBlock(config: GameConfig, blockId: string): BlockConfig {
  const b = config.blocks.find((x) => x.block_id === blockId);
  if (!b) throw new Error(`${config.module_id}: block ${blockId} missing from config`);
  return b;
}

/** Every block of the config, in config order. */
export function planAllBlocks(config: GameConfig): PlannedBlock[] {
  return config.blocks.map((b) => planBlock(b));
}

/** True when the config marks a block as the cross-module probe block. */
export function isProbeBlock(block: Pick<BlockConfig, 'beats' | 'condition_id'>): boolean {
  return block.beats.includes('probe_segment') || block.condition_id === 'probe';
}

/** A level timing value that must exist (fail closed when the config lacks it). */
export function timing(config: GameConfig, level: 'L1' | 'L2' | 'L3', key: string): number {
  const v = config.levels[level].timing[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${config.module_id}: levels.${level}.timing.${key} is missing`);
  }
  return v;
}

/** A level timing value, or null when absent. */
export function timingOrNull(
  config: GameConfig,
  level: 'L1' | 'L2' | 'L3',
  key: string,
): number | null {
  const v = config.levels[level].timing[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
