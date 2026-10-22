/**
 * Headless views. Module views expose only `void | Promise<void>` methods (geometry comes from pure
 * layout functions shared with the logic), so a headless run can substitute a view whose every method
 * is a resolved no-op. Used by node tests, the bot export tool and `dev.headless` without a renderer.
 */

/** Any object whose methods return nothing (or a promise of nothing). */
export type ViewSurface<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? R extends void | Promise<void>
      ? (...args: A) => R
      : never
    : never;
};

/** A view whose every method resolves immediately. */
export function createNullView<T extends object>(): T {
  const noop = (): Promise<void> => Promise.resolve();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Never look like a thenable (awaiting the view itself must not hang).
        if (prop === 'then') return undefined;
        return noop;
      },
    },
  ) as T;
}

/** True when the module context has a real Pixi renderer to draw with. */
export function hasRenderer(app: unknown): boolean {
  if (app === null || typeof app !== 'object') return false;
  const r = (app as { renderer?: unknown }).renderer;
  return r !== null && typeof r === 'object';
}
