/**
 * Content-as-config bundle (ENG-04): the module/episode configs from `content/games/**` and the
 * session plan, imported statically (works in Vite, Next.js, vitest and Node) and validated with the
 * strict contract validators at load. An invalid bundle is refused (fail closed).
 */
import type { GameConfig, SessionPlan } from '@shriii/contracts';
import { validateGameConfig } from '@shriii/contracts/validators/game-config';
import { validateSessionPlan } from '@shriii/contracts/validators/session-plan';
import coplay from '../../../../content/games/pathway-a/coplay.json' with { type: 'json' };
import roadHome from '../../../../content/games/pathway-a/road-home.json' with { type: 'json' };
import stall from '../../../../content/games/pathway-a/stall.json' with { type: 'json' };
import weighingPost from '../../../../content/games/pathway-a/weighing-post.json' with {
  type: 'json',
};
import balloon from '../../../../content/games/pathway-b/balloon.json' with { type: 'json' };
import cardSort from '../../../../content/games/pathway-b/card-sort.json' with { type: 'json' };
import dontTap from '../../../../content/games/pathway-b/dont-tap.json' with { type: 'json' };
import fourStalls from '../../../../content/games/pathway-b/four-stalls.json' with { type: 'json' };
import privateDice from '../../../../content/games/pathway-b/private-dice.json' with {
  type: 'json',
};
import sharePot from '../../../../content/games/pathway-b/share-pot.json' with { type: 'json' };
import steadyHands from '../../../../content/games/pathway-b/steady-hands.json' with {
  type: 'json',
};
import tower from '../../../../content/games/pathway-b/tower.json' with { type: 'json' };
import waitOrNow from '../../../../content/games/pathway-b/wait-or-now.json' with { type: 'json' };
import sessionPlan from '../../../../content/games/session-plan.json' with { type: 'json' };
import warmup from '../../../../content/games/shared/warmup.json' with { type: 'json' };
import type { ModuleId } from '../core/contracts.ts';
import { sha256Canonical } from '../logging/hash.ts';

/** A validated content bundle. */
export interface GameContent {
  readonly plan: SessionPlan;
  readonly configs: ReadonlyMap<ModuleId, GameConfig>;
  /** SHA-256 of the canonical JSON of the plan and every config (stamped as `bundle_hash`). */
  readonly bundleHash: string;
  /** Config for a module; throws when the bundle has none (callers should check `has`). */
  get(moduleId: ModuleId): GameConfig;
  has(moduleId: ModuleId): boolean;
  /** `sha256` of one config (stamped on `module_start.config_hash`). */
  configHash(moduleId: ModuleId): string;
}

/** Thrown when a content file fails validation. The message names the file and JSON path. */
export class ContentBundleError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`content bundle invalid:\n  ${issues.join('\n  ')}`);
    this.name = 'ContentBundleError';
    this.issues = issues;
  }
}

const RAW_CONFIGS: readonly (readonly [string, unknown])[] = [
  ['shared/warmup.json', warmup],
  ['pathway-b/dont-tap.json', dontTap],
  ['pathway-b/card-sort.json', cardSort],
  ['pathway-b/balloon.json', balloon],
  ['pathway-b/tower.json', tower],
  ['pathway-b/share-pot.json', sharePot],
  ['pathway-b/wait-or-now.json', waitOrNow],
  ['pathway-b/steady-hands.json', steadyHands],
  ['pathway-b/four-stalls.json', fourStalls],
  ['pathway-b/private-dice.json', privateDice],
  ['pathway-a/stall.json', stall],
  ['pathway-a/weighing-post.json', weighingPost],
  ['pathway-a/road-home.json', roadHome],
  ['pathway-a/coplay.json', coplay],
];

const MODULE_IDS: ReadonlySet<string> = new Set<ModuleId>([
  'dont_tap',
  'card_sort',
  'balloon',
  'tower',
  'share_pot',
  'wait_or_now',
  'steady_hands',
  'four_stalls',
  'private_dice',
  'stall',
  'weighing_post',
  'road_home',
  'coplay',
  'warmup',
]);

/** True when `id` is a known {@link ModuleId}. */
export function isModuleId(id: string): id is ModuleId {
  return MODULE_IDS.has(id);
}

/**
 * Build a content bundle from raw JSON values (exposed so tests and tools can validate variants).
 * Every file is validated; all problems are reported together.
 */
export function buildGameContent(
  rawPlan: unknown,
  rawConfigs: readonly (readonly [string, unknown])[],
): GameContent {
  const issues: string[] = [];
  if (!validateSessionPlan(rawPlan)) {
    for (const e of validateSessionPlan.errors ?? []) {
      issues.push(`session-plan.json${e.instancePath || '/'}: ${e.message ?? e.keyword}`);
    }
  }
  const configs = new Map<ModuleId, GameConfig>();
  const hashes = new Map<ModuleId, string>();
  for (const [file, raw] of rawConfigs) {
    if (!validateGameConfig(raw)) {
      for (const e of validateGameConfig.errors ?? []) {
        issues.push(`${file}${e.instancePath || '/'}: ${e.message ?? e.keyword}`);
      }
      continue;
    }
    if (!isModuleId(raw.module_id)) {
      issues.push(`${file}/module_id: unknown module id ${raw.module_id}`);
      continue;
    }
    if (configs.has(raw.module_id)) {
      issues.push(`${file}/module_id: duplicate module id ${raw.module_id}`);
      continue;
    }
    for (const block of raw.blocks) {
      if (block.min_trials > block.trials) {
        issues.push(`${file}/blocks/${block.block_id}: min_trials exceeds trials`);
      }
      if ((block.phase === 'practice' || block.phase === 'warmup') && block.scorable) {
        issues.push(`${file}/blocks/${block.block_id}: practice/warm-up blocks cannot be scorable`);
      }
    }
    if (raw.budget.soft_cap_ms > raw.budget.hard_cap_ms) {
      issues.push(`${file}/budget: soft_cap_ms exceeds hard_cap_ms`);
    }
    configs.set(raw.module_id, raw);
    hashes.set(raw.module_id, sha256Canonical(raw));
  }
  if (issues.length > 0) throw new ContentBundleError(issues);
  const plan = rawPlan as SessionPlan;
  const bundleHash = sha256Canonical({
    plan,
    configs: [...configs.values()].map((c) => ({
      id: c.config_id,
      hash: hashes.get(c.module_id as ModuleId),
    })),
  });
  return {
    plan,
    configs,
    bundleHash,
    has: (id) => configs.has(id),
    get(id) {
      const c = configs.get(id);
      if (!c) throw new ContentBundleError([`no config for module ${id}`]);
      return c;
    },
    configHash(id) {
      const h = hashes.get(id);
      if (!h) throw new ContentBundleError([`no config for module ${id}`]);
      return h;
    },
  };
}

let cached: GameContent | null = null;

/** The bundled content from `content/games` (validated once, then cached). */
export function loadGameContent(): GameContent {
  cached ??= buildGameContent(sessionPlan, RAW_CONFIGS);
  return cached;
}
