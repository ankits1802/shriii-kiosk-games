/**
 * Pixi view factory for {@link RoadHomeEpisode}: the presenter plus the touch player bound to its
 * targets. Kept separate so headless builds and tests never load the rendering code.
 */
import type { ModuleContext } from '../../../core/contracts.ts';
import type { RoadHomePlan } from '../plan.ts';
import type { RoadHomeViewFactory } from '../RoadHomeEpisode.ts';
import { HumanPlayer } from './human.ts';
import { RoadHomeView } from './RoadHomeView.ts';

export { VIEW_BEATS } from './beats.ts';
export { RoadHomeView } from './RoadHomeView.ts';

/** Build the Pixi presenter and touch player for a module context. */
export const roadHomeView: RoadHomeViewFactory = (ctx: ModuleContext, plan: RoadHomePlan) => {
  void plan;
  const view = new RoadHomeView(ctx);
  const input = ctx.input as { setLogger?: unknown };
  return {
    presenter: view,
    human: new HumanPlayer(ctx, view),
    inputLogsHolds: typeof input.setLogger === 'function',
  };
};
