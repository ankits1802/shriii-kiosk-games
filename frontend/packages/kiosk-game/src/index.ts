/**
 * @shriii/kiosk-game — the kiosk game library mounted by `frontend/apps/kiosk` (Vite/Electron) and by
 * `frontend/apps/web` at `/kiosk` (Next.js).
 *
 * The shared interfaces in `core/contracts.ts` are the boundary every engine service, micro-game,
 * episode, onboarding screen and report view codes against.
 */

export { KioskGame, type KioskGameProps } from './app/KioskGame.tsx';
export * from './core/contracts.ts';
// Engine, logger SDK/outbox, input layer and session orchestration (kiosk engine agent).
export * from './engine/index.ts';
export { createRoadHomeEpisode } from './episodes/road-home/index.ts';
export {
  createStallEpisode,
  registerStallEpisode,
  stallEpisodeFactory,
} from './episodes/stall/index.ts';
export { createWeighingPost } from './episodes/weighing-post/index.ts';
export { createBalloon } from './games/balloon/BalloonModule.ts';
export { createCardSort } from './games/card-sort/CardSortModule.ts';
export { createDontTap } from './games/dont-tap/DontTapModule.ts';
export {
  bridgeBudgetMs,
  CarouselHubRunner,
  carouselOrder,
} from './games/hub/CarouselHubRunner.ts';
export { set2ModuleFactories } from './games/hub/modules.ts';
export { createTower } from './games/tower/TowerModule.ts';
export { createWaitOrNow } from './games/wait-or-now/WaitOrNowModule.ts';
export * from './input/index.ts';
export * from './logging/index.ts';
// Module registration: every Pathway A episode and Pathway B micro-game (explicit, no side effects).
export {
  allModuleFactories,
  pathwayAFactories,
  pathwayBFactories,
  registerAllModules,
} from './modules.ts';
export * from './session/index.ts';
