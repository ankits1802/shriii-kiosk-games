/**
 * Factories for the Pathway B set-2 micro-games (Share-the-Pot, Steady Hands, Four Stalls, Private
 * Dice), ready for the module registry:
 *
 *   moduleRegistry.registerAll(set2ModuleFactories());
 *
 * Registration stays explicit (the package is `sideEffects: false`); the integrator decides where.
 */
import type { GameModule, GameModuleFactory, ModuleRegistry } from '../../core/contracts.ts';
import { createFourStalls } from '../four-stalls/FourStallsModule.ts';
import { createPrivateDice } from '../private-dice/PrivateDiceModule.ts';
import { createSharePot } from '../share-pot/SharePotModule.ts';
import { createSteadyHands } from '../steady-hands/SteadyHandsModule.ts';
import type { MicroGameHooks } from './kit/runtime.ts';

/** A set-2 module instance (exposes its trial params for export alongside the events). */
export interface Set2Module extends GameModule {
  trialParams(): Record<string, Record<string, unknown>>;
}

/** Registry record for the four set-2 modules. `onCreate` sees every new instance (dev tooling). */
export function set2ModuleFactories(
  hooks: MicroGameHooks = {},
  onCreate?: (module: Set2Module) => void,
): ModuleRegistry {
  const wrap =
    (make: (h: MicroGameHooks) => Set2Module): GameModuleFactory =>
    () => {
      const m = make(hooks);
      onCreate?.(m);
      return m;
    };
  return {
    share_pot: wrap(createSharePot),
    steady_hands: wrap(createSteadyHands),
    four_stalls: wrap(createFourStalls),
    private_dice: wrap(createPrivateDice),
  };
}
