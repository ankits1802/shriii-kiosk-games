/**
 * Pathway A, Episode 1: The Stall (EPI-01). Public surface for the integrator:
 *
 *   import { registerStallEpisode } from './episodes/stall/index.ts';
 *   registerStallEpisode();                 // into the default moduleRegistry
 *   // or: registerModules({ stall: stallEpisodeFactory })
 *
 * Registration is explicit (the package is `sideEffects: false`). The factory renders with the Pixi
 * scene, or headlessly (scripted bot) when the module host runs with `dev.headless`.
 */
import stallConfig from '../../../../../../content/games/pathway-a/stall.json' with {
  type: 'json',
};
import type {
  ConstructId,
  GameModuleFactory,
  IndicatorId,
  ModuleContext,
  Unsubscribe,
} from '../../core/contracts.ts';
import {
  type GameModuleRegistry,
  moduleRegistry,
  type RegisterOptions,
} from '../../engine/registry.ts';
import { stallGeometry } from './layout.ts';
import { StallEpisode, type StallEpisodeOptions } from './StallEpisode.ts';
import { createStallScene } from './scene/StallScene.ts';
import { NullStallView, type StallView } from './view.ts';

export { MEDIAN_STALL_BOT, StallBot, type StallBotPolicy, sampleStallBotPolicy } from './bot.ts';
export { type StallGeometry, stallGeometry } from './layout.ts';
export {
  STALL_MODULE_ID,
  STALL_TARGETS,
  type StallDebugState,
  StallEpisode,
  type StallEpisodeOptions,
  type StallViewFactory,
} from './StallEpisode.ts';
export { createStallScene, StallScene } from './scene/StallScene.ts';
export { buildStallPlan, type StallPlan, type StallTrial, trialParamsOf } from './schedule.ts';
export { NullStallView, type StallView } from './view.ts';

/** Default view: headless for bots (`dev.headless`), else the Pixi scene. */
export function defaultStallView(ctx: ModuleContext): StallView {
  return ctx.dev.headless ? new NullStallView(stallGeometry(ctx.layout)) : createStallScene(ctx);
}

/** Create a fresh Stall episode (one per session). */
export function createStallEpisode(options: StallEpisodeOptions = {}): StallEpisode {
  return new StallEpisode(
    stallConfig.constructs as ConstructId[],
    stallConfig.indicators as IndicatorId[],
    { ...options, view: options.view ?? defaultStallView },
  );
}

/** Module factory for the registry. */
export const stallEpisodeFactory: GameModuleFactory = () => createStallEpisode();

/** Register The Stall in a registry (default: the shared `moduleRegistry`). */
export function registerStallEpisode(
  registry: GameModuleRegistry = moduleRegistry,
  options?: RegisterOptions,
): Unsubscribe {
  return registry.register('stall', stallEpisodeFactory, options);
}
