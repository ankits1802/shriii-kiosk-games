/**
 * Dev registry of the set-1 micro-games (harness only; production registration is the
 * integrator's, see `requests_outside_scope`). Remembers the last instance so the bot scripts can
 * export `trial_id -> params` next to the events.
 */
import type { GameModule, ModuleRegistry } from '../../../../core/contracts.ts';
import { createBalloon } from '../../../balloon/BalloonModule.ts';
import { createCardSort } from '../../../card-sort/CardSortModule.ts';
import { createTower } from '../../../tower/TowerModule.ts';
import { createWaitOrNow } from '../../../wait-or-now/WaitOrNowModule.ts';
import { createDontTap } from '../../DontTapModule.ts';
import type { MicroGameOptions } from '../micro-game.ts';

interface ParamsSource {
  trialParams(): Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

let last: (GameModule & ParamsSource) | null = null;

function remember<T extends GameModule & ParamsSource>(m: T): T {
  last = m;
  return m;
}

/** Set-1 factories with options (bots/tests pick a persona). */
export const DEV_FACTORIES = {
  dont_tap: (o: MicroGameOptions = {}) => createDontTap(o),
  card_sort: (o: MicroGameOptions = {}) => createCardSort(o),
  tower: (o: MicroGameOptions = {}) => createTower(o),
  balloon: (o: MicroGameOptions = {}) => createBalloon(o),
  wait_or_now: (o: MicroGameOptions = {}) => createWaitOrNow(o),
} as const;

export const DEV_REGISTRY: ModuleRegistry = {
  dont_tap: () => remember(createDontTap()),
  card_sort: () => remember(createCardSort()),
  tower: () => remember(createTower()),
  balloon: () => remember(createBalloon()),
  wait_or_now: () => remember(createWaitOrNow()),
};

/** Trial params of the module instance that ran last. */
export function devTrialParams(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return last?.trialParams() ?? {};
}
