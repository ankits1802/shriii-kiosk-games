/**
 * Episode-level stimulus parameters for The Weighing Post (EPI-02), read from the module config
 * (`content/games/pathway-a/weighing-post.json` -> `constraints`). These are stimulus-design values
 * (pictured reward sizes, die faces, probe situations), never scientific thresholds. Every value records
 * whether it came from the config or from the documented fallback, and the episode logs that provenance
 * once per session (`params_source` in {@link EpisodeParams.sources}).
 */
import type { GameConfig } from '@shriii/contracts';

/** One cross-episode probe situation: a sure small basket vs a covered basket (pictured items). */
export interface ProbeSituation {
  readonly safeItems: number;
  readonly riskyItems: number;
}

export interface EpisodeParams {
  /** Chance that a skipped (gambled) inspection is caught out (pictured reward lost). */
  readonly gambleCatchProbability: number;
  /** Sure reward for inspecting every sack (pictured coins). */
  readonly gambleSafeCoins: number;
  /** Reward for skipping the inspection when the gamble pays (pictured coins). */
  readonly gambleWinCoins: number;
  /** Faces on the carved luck die (private report). */
  readonly luckFaces: number;
  /** Probe situations by probe position (repeat groups shared by every episode). */
  readonly probeSituations: readonly ProbeSituation[];
  /** `config` or `episode_default` per key. */
  readonly sources: Readonly<Record<string, 'config' | 'episode_default'>>;
}

/** Fallbacks used only when the config does not carry the key (logged as `episode_default`). */
export const EPISODE_DEFAULTS = {
  gamble_catch_probability: 0.5,
  gamble_safe_coins: 2,
  gamble_win_coins: 4,
  luck_token_faces: 6,
  probe_safe_items: [2, 2, 1, 2],
  probe_risky_items: [4, 5, 4, 6],
} as const;

/** Thrown when a configured value is out of range (fail closed: the episode refuses to run). */
export class EpisodeConfigError extends Error {
  constructor(message: string) {
    super(`weighing_post config: ${message}`);
    this.name = 'EpisodeConfigError';
  }
}

function numberAt(
  constraints: Readonly<Record<string, unknown>>,
  key: keyof typeof EPISODE_DEFAULTS,
  sources: Record<string, 'config' | 'episode_default'>,
): number {
  const v = constraints[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    sources[key] = 'config';
    return v;
  }
  if (v !== undefined) throw new EpisodeConfigError(`${key} must be a finite number`);
  sources[key] = 'episode_default';
  return EPISODE_DEFAULTS[key] as number;
}

function intListAt(
  constraints: Readonly<Record<string, unknown>>,
  key: 'probe_safe_items' | 'probe_risky_items',
  sources: Record<string, 'config' | 'episode_default'>,
): number[] {
  const v = constraints[key];
  if (Array.isArray(v)) {
    if (!v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 12)) {
      throw new EpisodeConfigError(`${key} must be integers in 0..12`);
    }
    sources[key] = 'config';
    return v as number[];
  }
  if (v !== undefined) throw new EpisodeConfigError(`${key} must be an array`);
  sources[key] = 'episode_default';
  return [...EPISODE_DEFAULTS[key]];
}

/** Resolve and validate the episode parameters from a module config. */
export function episodeParams(config: GameConfig): EpisodeParams {
  const c = config.constraints as Readonly<Record<string, unknown>>;
  const sources: Record<string, 'config' | 'episode_default'> = {};
  const p = numberAt(c, 'gamble_catch_probability', sources);
  if (!(p > 0 && p < 1)) throw new EpisodeConfigError('gamble_catch_probability must be in (0, 1)');
  const safe = numberAt(c, 'gamble_safe_coins', sources);
  const win = numberAt(c, 'gamble_win_coins', sources);
  if (!Number.isInteger(safe) || !Number.isInteger(win) || safe < 1 || win <= safe || win > 9) {
    throw new EpisodeConfigError('gamble coins must be integers with 1 <= safe < win <= 9');
  }
  const faces = numberAt(c, 'luck_token_faces', sources);
  if (faces !== 6) throw new EpisodeConfigError('luck_token_faces must be 6 (report schema 1..6)');
  const safeItems = intListAt(c, 'probe_safe_items', sources);
  const riskyItems = intListAt(c, 'probe_risky_items', sources);
  if (safeItems.length === 0 || safeItems.length !== riskyItems.length) {
    throw new EpisodeConfigError('probe_safe_items and probe_risky_items must be equally long');
  }
  return {
    gambleCatchProbability: p,
    gambleSafeCoins: safe,
    gambleWinCoins: win,
    luckFaces: faces,
    probeSituations: safeItems.map((s, i) => ({ safeItems: s, riskyItems: riskyItems[i] ?? s })),
    sources,
  };
}
