/**
 * Production module registration (ENG-05, MG-10, EPI-04): every bespoke Pathway A episode and
 * Pathway B micro-game, keyed by module id. The package is `sideEffects: false`, so nothing registers
 * on import; the kiosk app (or a test) calls {@link registerAllModules} once at start-up.
 *
 * The warm-up has no bespoke module yet and runs the engine's generic config-driven module.
 */
import type { ModuleRegistry, Unsubscribe } from './core/contracts.ts';
import {
  type GameModuleRegistry,
  moduleRegistry,
  type RegisterOptions,
} from './engine/registry.ts';
import { createRoadHomeEpisode } from './episodes/road-home/index.ts';
import { stallEpisodeFactory } from './episodes/stall/index.ts';
import { createWeighingPost } from './episodes/weighing-post/index.ts';
import { createBalloon } from './games/balloon/BalloonModule.ts';
import { createCardSort } from './games/card-sort/CardSortModule.ts';
import { createDontTap } from './games/dont-tap/DontTapModule.ts';
import { set2ModuleFactories } from './games/hub/modules.ts';
import { createTower } from './games/tower/TowerModule.ts';
import { createWaitOrNow } from './games/wait-or-now/WaitOrNowModule.ts';

/** Pathway A: the three narrative episodes. */
export function pathwayAFactories(): ModuleRegistry {
  return {
    stall: stallEpisodeFactory,
    weighing_post: () => createWeighingPost(),
    road_home: () => createRoadHomeEpisode(),
  };
}

/** Pathway B: the five core micro-games plus the four slot modules. */
export function pathwayBFactories(): ModuleRegistry {
  return {
    dont_tap: () => createDontTap(),
    card_sort: () => createCardSort(),
    tower: () => createTower(),
    balloon: () => createBalloon(),
    wait_or_now: () => createWaitOrNow(),
    ...set2ModuleFactories(),
  };
}

/** Every bespoke module factory. */
export function allModuleFactories(): ModuleRegistry {
  return { ...pathwayAFactories(), ...pathwayBFactories() };
}

/**
 * Register every bespoke module in `registry` (default: the shared {@link moduleRegistry} the kiosk
 * runtime and the module dev harness read). Idempotent with `replace: true` (the default here), so a
 * hot reload or a second call does not throw.
 */
export function registerAllModules(
  registry: GameModuleRegistry = moduleRegistry,
  options: RegisterOptions = { replace: true },
): Unsubscribe {
  return registry.registerAll(allModuleFactories(), options);
}
