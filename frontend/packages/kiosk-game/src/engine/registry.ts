/**
 * Module registry (ENG-05, MG-10, EPI-04): episodes (Pathway A) and micro-games (Pathway B) register
 * a factory under their module id; the session's `play` state runs the planned order through the
 * module host, which resolves each id here. The generic placeholder module is used only as a
 * fallback when no factory is registered for an id (or the registered factory is broken).
 *
 * Order comes from `content/games/session-plan.json`, never from code:
 * - Pathway A: `pathways.A.order` (stall -> weighing_post -> road_home);
 * - Pathway B: `pathways.B.core_order` (5 fixed core modules) + the session's seeded slot form.
 *
 * Registration is explicit (no import side effects, the package is `sideEffects: false`): the
 * integrator calls `registerModules({...})` on {@link moduleRegistry} (or passes its own registry).
 */
import type { Pathway, SessionPlan, SlotForm } from '@shriii/contracts';
import type {
  GameModule,
  GameModuleFactory,
  ModuleFactoryLookup,
  ModuleId,
  ModuleRegistry,
  Unsubscribe,
} from '../core/contracts.ts';
import { isModuleId } from './content.ts';

/** Where a resolved module came from. */
export type ModuleSource = 'registered' | 'fallback';

/** A resolved module instance plus its provenance. */
export interface ResolvedModule {
  readonly module: GameModule;
  readonly source: ModuleSource;
}

/** Thrown on invalid registrations (unknown id, duplicate without `replace`). */
export class ModuleRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRegistrationError';
  }
}

/** Options for {@link GameModuleRegistry.register}. */
export interface RegisterOptions {
  /** Replace an existing registration instead of throwing (hot reload, tests). */
  readonly replace?: boolean;
}

/** Mutable registry of module factories keyed by {@link ModuleId}. */
export class GameModuleRegistry implements ModuleFactoryLookup {
  private readonly factories = new Map<ModuleId, GameModuleFactory>();
  private readonly listeners = new Set<(ids: readonly ModuleId[]) => void>();

  constructor(initial: ModuleRegistry = {}) {
    this.registerAll(initial);
  }

  /**
   * Register a factory for `id`. Returns a function that removes exactly this registration.
   * @throws ModuleRegistrationError for unknown ids or duplicates (unless `replace`).
   */
  register(id: ModuleId, factory: GameModuleFactory, options: RegisterOptions = {}): Unsubscribe {
    if (!isModuleId(id)) throw new ModuleRegistrationError(`unknown module id '${String(id)}'`);
    if (typeof factory !== 'function') {
      throw new ModuleRegistrationError(`factory for '${id}' is not a function`);
    }
    if (this.factories.has(id) && options.replace !== true) {
      throw new ModuleRegistrationError(`module '${id}' is already registered`);
    }
    this.factories.set(id, factory);
    this.emit();
    return () => {
      if (this.factories.get(id) === factory) {
        this.factories.delete(id);
        this.emit();
      }
    };
  }

  /** Register several factories at once (same rules as {@link register}). */
  registerAll(record: ModuleRegistry, options: RegisterOptions = {}): Unsubscribe {
    const undo: Unsubscribe[] = [];
    for (const [id, factory] of Object.entries(record) as [ModuleId, GameModuleFactory][]) {
      if (factory) undo.push(this.register(id, factory, options));
    }
    return () => {
      for (const u of undo) u();
    };
  }

  /** Remove the registration for `id` (no-op when absent). */
  unregister(id: ModuleId): void {
    if (this.factories.delete(id)) this.emit();
  }

  has(id: ModuleId): boolean {
    return this.factories.has(id);
  }

  get(id: ModuleId): GameModuleFactory | undefined {
    return this.factories.get(id);
  }

  /** Registered ids in registration order. */
  ids(): ModuleId[] {
    return [...this.factories.keys()];
  }

  /** Plain-record snapshot (for code that wants the contract's {@link ModuleRegistry} shape). */
  toRecord(): ModuleRegistry {
    return Object.fromEntries(this.factories) as ModuleRegistry;
  }

  /** Notified with the registered ids after every change. */
  onChange(listener: (ids: readonly ModuleId[]) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove every registration. */
  clear(): void {
    if (this.factories.size === 0) return;
    this.factories.clear();
    this.emit();
  }

  private emit(): void {
    const ids = this.ids();
    for (const l of this.listeners) l(ids);
  }
}

/** The default registry the kiosk runtime and the module dev harness read from. */
export const moduleRegistry = new GameModuleRegistry();

/** Register factories into the default {@link moduleRegistry}. */
export function registerModules(record: ModuleRegistry, options?: RegisterOptions): Unsubscribe {
  return moduleRegistry.registerAll(record, options);
}

/** Look up a factory in either registry form. */
export function lookupFactory(
  registry: ModuleRegistry | ModuleFactoryLookup,
  id: ModuleId,
): GameModuleFactory | undefined {
  if (typeof (registry as ModuleFactoryLookup).get === 'function') {
    return (registry as ModuleFactoryLookup).get(id);
  }
  return (registry as ModuleRegistry)[id];
}

/**
 * Create the module instance for `id`: the registered factory when present and well-behaved
 * (returns a module whose `id` matches), else `fallback(id)`. Null when neither exists.
 */
export function resolveModule(
  registry: ModuleRegistry | ModuleFactoryLookup,
  id: ModuleId,
  fallback?: (id: ModuleId) => GameModule | null,
): ResolvedModule | null {
  const factory = lookupFactory(registry, id);
  if (factory) {
    try {
      const module = factory();
      if (module && module.id === id) return { module, source: 'registered' };
      console.error(
        `[registry] factory for '${id}' returned ${module ? `module '${module.id}'` : 'nothing'}; using fallback`,
      );
    } catch (err) {
      console.error(`[registry] factory for '${id}' threw; using fallback`, err);
    }
  }
  const fb = fallback?.(id) ?? null;
  return fb ? { module: fb, source: 'fallback' } : null;
}

/**
 * The planned module order for a session (from the session plan): Pathway A's three episodes, or
 * Pathway B's five core modules followed by the session's seeded slot module.
 * @throws RangeError when the plan names an unknown module id (content is validated at load, so
 * this indicates a plan/engine version mismatch).
 */
export function plannedModulesFor(
  plan: SessionPlan,
  pathway: Pathway,
  slot: SlotForm | null,
): ModuleId[] {
  const raw: readonly string[] =
    pathway === 'A'
      ? plan.pathways.A.order
      : [...plan.pathways.B.core_order, ...(slot !== null ? [slot] : [])];
  if (pathway === 'B' && slot !== null && !plan.pathways.B.slot_candidates.includes(slot)) {
    throw new RangeError(`slot '${slot}' is not a slot candidate in the session plan`);
  }
  return raw.map((id) => {
    if (!isModuleId(id)) throw new RangeError(`session plan names unknown module '${id}'`);
    return id;
  });
}

/** Which planned modules will run as placeholders (no registered factory). */
export function placeholderModules(
  registry: ModuleRegistry | ModuleFactoryLookup,
  planned: readonly ModuleId[],
): ModuleId[] {
  return planned.filter((id) => lookupFactory(registry, id) === undefined);
}
