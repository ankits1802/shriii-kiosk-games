/**
 * Pathway A, Episode 3: The Road Home (EPI-03). Register with the module registry as
 *
 *   registerModules({ road_home: createRoadHomeEpisode })
 *
 * `createRoadHomeEpisode()` renders with the Pixi view; tests and CI construct
 * `new RoadHomeEpisode({ view: 'headless' })` to run the scripted bot without rendering.
 */
import { RoadHomeEpisode, type RoadHomeEpisodeOptions } from './RoadHomeEpisode.ts';
import { roadHomeView } from './view/index.ts';

export { BotPlayer, MEDIAN_ROAD_BOT, type RoadBotPolicy } from './bot.ts';
export { RoadHomeDirector } from './director.ts';
export { ROAD_HOME_LINES, ROAD_HOME_OPTIONAL_LINES } from './lines.ts';
export {
  generateErrandMap,
  generateFallenTreeMap,
  generateFloodMap,
  type RoadMap,
} from './maps.ts';
export { type BeatDurations, NullPresenter } from './null-presenter.ts';
export { buildRoadHomePlan, type RoadHomePlan, type RoadHomeTrial } from './plan.ts';
export {
  ROAD_HOME_CONSTRUCTS,
  ROAD_HOME_INDICATORS,
  RoadHomeEpisode,
  type RoadHomeEpisodeOptions,
  type RoadHomeViewFactory,
} from './RoadHomeEpisode.ts';
export { RoadHomeConfigError, resolveSettings } from './settings.ts';
export { VIEW_BEATS } from './view/beats.ts';

/** Factory for the module registry: the full Pixi episode. */
export function createRoadHomeEpisode(
  options: Omit<RoadHomeEpisodeOptions, 'view'> = {},
): RoadHomeEpisode {
  return new RoadHomeEpisode({ ...options, view: roadHomeView });
}
