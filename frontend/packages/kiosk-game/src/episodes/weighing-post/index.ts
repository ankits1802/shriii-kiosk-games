/**
 * Episode 2 of Pathway A, The Weighing Post (EPI-02). Register with the module registry, e.g.
 * `moduleRegistry.register('weighing_post', createWeighingPost)`.
 */
import type { GameModule, ModuleContext } from '../../core/contracts.ts';
import { HeadlessWeighingScene } from './scene/headless.ts';
import { type PixiSceneOptions, PixiWeighingScene } from './scene/PixiWeighingScene.ts';
import type { WeighingScene } from './scene/types.ts';
import { WeighingPostEpisode, type WeighingPostOptions } from './WeighingPostEpisode.ts';

export { type BotPolicy, MEDIAN_BOT } from './bot.ts';
export { type EpisodeParams, episodeParams } from './params.ts';
export { HeadlessWeighingScene } from './scene/headless.ts';
export { type PixiSceneOptions, PixiWeighingScene } from './scene/PixiWeighingScene.ts';
export { CHOREO, type WeighingScene } from './scene/types.ts';
export {
  buildEpisodePlan,
  type EpisodePlan,
  type EpisodeTrial,
  trialParamsOf,
} from './schedule.ts';
export {
  TARGET as WEIGHING_POST_TARGETS,
  WEIGHING_POST_CONSTRUCTS,
  WEIGHING_POST_INDICATORS,
  WeighingPostEpisode,
  type WeighingPostOptions,
} from './WeighingPostEpisode.ts';

/** Rendered scene when the Pixi application has a renderer; headless otherwise (bots, tests). */
export function weighingPostScene(
  ctx: ModuleContext,
  options: PixiSceneOptions = {},
): WeighingScene {
  const renderer = (ctx.app as { renderer?: unknown }).renderer;
  return renderer ? new PixiWeighingScene(ctx, options) : new HeadlessWeighingScene(ctx.layout);
}

/** Module factory (one fresh episode per session). */
export function createWeighingPost(
  options: Omit<WeighingPostOptions, 'scene'> & { readonly scene?: PixiSceneOptions } = {},
): GameModule {
  const { scene, ...rest } = options;
  return new WeighingPostEpisode({ ...rest, scene: (ctx) => weighingPostScene(ctx, scene ?? {}) });
}
