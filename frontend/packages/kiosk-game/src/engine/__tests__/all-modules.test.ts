import { describe, expect, it } from 'vitest';
import { allModuleFactories, registerAllModules } from '../../modules.ts';
import { loadGameContent } from '../content.ts';
import { GameModuleRegistry, placeholderModules, plannedModulesFor } from '../registry.ts';

describe('registerAllModules', () => {
  const content = loadGameContent();
  const registry = new GameModuleRegistry();
  registerAllModules(registry);

  it('registers a bespoke module for every planned Pathway A and B module', () => {
    const plan = content.plan;
    const a = plannedModulesFor(plan, 'A', null);
    expect(placeholderModules(registry, a)).toEqual([]);
    for (const slot of plan.pathways.B.slot_candidates) {
      const b = plannedModulesFor(plan, 'B', slot as Parameters<typeof plannedModulesFor>[2]);
      expect(placeholderModules(registry, b)).toEqual([]);
    }
  });

  it('every factory returns a module with its own id', () => {
    for (const [id, factory] of Object.entries(allModuleFactories())) {
      expect(factory?.().id).toBe(id);
    }
  });

  it('is idempotent (replace)', () => {
    expect(() => registerAllModules(registry)).not.toThrow();
  });
});
