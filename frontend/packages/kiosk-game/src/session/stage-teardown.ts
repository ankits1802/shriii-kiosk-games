/**
 * Stage teardown: kill every GSAP tween that targets a display object (or its position, scale, pivot
 * or skew) in a container tree, then destroy the tree. A module's `destroy()` should stop its own
 * tweens, but a tween left running on a destroyed object throws on the next tick ("Cannot set
 * properties of null") and would end the session as a crash; the engine guarantees it cannot.
 */
import { gsap } from 'gsap';
import { Container, Ticker } from 'pixi.js';

export function killTweensInTree(root: Container): void {
  const stack: Container[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Container;
    if (node.destroyed) continue;
    const targets: object[] = [node];
    for (const key of ['position', 'scale', 'pivot', 'skew'] as const) {
      const p = (node as unknown as Record<string, unknown>)[key];
      if (p && typeof p === 'object') targets.push(p);
    }
    gsap.killTweensOf(targets);
    for (const child of node.children) stack.push(child);
  }
}

/** Kill the tree's tweens, detach it from its parent and destroy it with its children. */
export function destroyStage(stage: Container): void {
  if (stage.destroyed) return;
  killTweensInTree(stage);
  stage.parent?.removeChild(stage);
  stage.destroy({ children: true });
}

let installed = false;

/**
 * Make every `Container.destroy()` kill the GSAP tweens on that object first (idempotent). Pixi
 * destroys children through their own `destroy()`, so one patch covers whole trees, including objects
 * a module destroys itself before its stage is released. Tweens created on an already destroyed
 * object are killed when GSAP first renders them.
 */
export function installTweenSafeDestroy(): void {
  if (installed) return;
  installed = true;
  const proto = Container.prototype as unknown as {
    destroy(this: Container, options?: unknown): void;
  };
  const original = proto.destroy;
  proto.destroy = function destroyKillingTweens(this: Container, options?: unknown): void {
    if (!this.destroyed) {
      const targets: object[] = [this];
      for (const key of ['position', 'scale', 'pivot', 'skew'] as const) {
        const p = (this as unknown as Record<string, unknown>)[key];
        if (p && typeof p === 'object') targets.push(p);
      }
      gsap.killTweensOf(targets);
    }
    original.call(this, options);
  };
  // A tween created after its target was destroyed (e.g. a gesture step chained from a callback
  // during teardown) throws when GSAP initialises it on the next tick, and a delayed call can fire
  // after its scene was destroyed. Kill such tweens instead of crashing the session.
  const tweenProto = gsap.core.Tween.prototype as unknown as {
    render(this: gsap.core.Tween, ...args: unknown[]): unknown;
  };
  const render = tweenProto.render;
  tweenProto.render = function renderUnlessDestroyed(
    this: gsap.core.Tween,
    ...args: unknown[]
  ): unknown {
    try {
      return render.apply(this, args);
    } catch (err) {
      const targets = this.targets() as { destroyed?: boolean }[];
      if (targets.some((t) => t !== null && typeof t === 'object' && t.destroyed === true)) {
        this.kill();
        return this;
      }
      // A delayed call or tween callback that fires after its scene was torn down.
      if (isDestroyedAccess(err)) {
        this.kill();
        console.warn('[kiosk] animation callback stopped after touching a destroyed object', err);
        return this;
      }
      throw err;
    }
  };
  installSafeTickerListeners();
}

/** A TypeError from touching a destroyed Pixi object (its transform/position was nulled). */
function isDestroyedAccess(err: unknown): boolean {
  return err instanceof TypeError && /of null|of undefined/.test(err.message);
}

type TickerFn = (this: unknown, ticker: Ticker) => unknown;

/**
 * A ticker listener left running after its objects were destroyed throws on every frame and would
 * end the session as a crash. Such a listener is removed (with a warning) instead; any other error
 * still propagates. `remove()` keeps working with the original function.
 */
function installSafeTickerListeners(): void {
  const proto = Ticker.prototype as unknown as {
    add(fn: TickerFn, context?: unknown, priority?: number): Ticker;
    addOnce(fn: TickerFn, context?: unknown, priority?: number): Ticker;
    remove(fn: TickerFn, context?: unknown): Ticker;
  };
  const wrappers = new WeakMap<TickerFn, Map<unknown, TickerFn>>();
  const wrap = (ticker: Ticker, fn: TickerFn, context: unknown): TickerFn => {
    let byCtx = wrappers.get(fn);
    if (!byCtx) {
      byCtx = new Map();
      wrappers.set(fn, byCtx);
    }
    const existing = byCtx.get(context);
    if (existing) return existing;
    const safe: TickerFn = function safeTickerListener(this: unknown, t: Ticker): unknown {
      try {
        return fn.call(this, t);
      } catch (err) {
        if (!isDestroyedAccess(err)) throw err;
        ticker.remove(fn as never, context);
        console.warn('[kiosk] ticker listener removed after touching a destroyed object', err);
        return undefined;
      }
    };
    byCtx.set(context, safe);
    return safe;
  };
  const add = proto.add;
  const addOnce = proto.addOnce;
  const remove = proto.remove;
  proto.add = function (this: Ticker, fn, context, priority) {
    return add.call(this, wrap(this, fn, context), context, priority);
  };
  proto.addOnce = function (this: Ticker, fn, context, priority) {
    return addOnce.call(this, wrap(this, fn, context), context, priority);
  };
  proto.remove = function (this: Ticker, fn, context) {
    const safe = wrappers.get(fn)?.get(context);
    if (safe) remove.call(this, safe, context);
    return remove.call(this, fn, context);
  };
}
