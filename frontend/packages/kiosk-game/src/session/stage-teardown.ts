/**
 * Stage teardown: kill every GSAP tween that targets a display object (or its position, scale, pivot
 * or skew) in a container tree, then destroy the tree. A module's `destroy()` should stop its own
 * tweens, but a tween left running on a destroyed object throws on the next tick ("Cannot set
 * properties of null") and would end the session as a crash; the engine guarantees it cannot.
 */
import { gsap } from 'gsap';
import { Container } from 'pixi.js';

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
  // during teardown) throws when GSAP initialises it on the next tick. Kill such tweens instead.
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
      throw err;
    }
  };
}
