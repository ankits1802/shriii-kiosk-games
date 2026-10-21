/**
 * GSAP helpers with reduced-motion awareness. Every tween promise resolves (never hangs) when the target
 * is destroyed or the motion is skipped, so scene scripts can `await` them safely.
 */
import { gsap } from 'gsap';

/** Global motion settings (set by the art kit from the quality profile). */
export const motionSettings = {
  /** Multiplier on durations; 0 makes every tween instant (tests, reduced motion transitions). */
  timeScale: 1,
  reducedMotion: false,
};

/** Tween and await completion. `vars.duration` is in seconds (GSAP convention). */
export function tweenTo(target: object, vars: gsap.TweenVars): Promise<void> {
  return new Promise((resolve) => {
    const duration = typeof vars.duration === 'number' ? vars.duration : 0.5;
    if (motionSettings.timeScale <= 0) {
      gsap.set(target, { ...vars, duration: 0, delay: 0 });
      resolve();
      return;
    }
    gsap.to(target, {
      ...vars,
      duration: duration * motionSettings.timeScale,
      delay: typeof vars.delay === 'number' ? vars.delay * motionSettings.timeScale : 0,
      onComplete: () => resolve(),
      onInterrupt: () => resolve(),
    });
  });
}

/** Await a timeline (resolves on completion or kill). */
export function playTimeline(tl: gsap.core.Timeline): Promise<void> {
  return new Promise((resolve) => {
    if (motionSettings.timeScale <= 0) {
      tl.progress(1);
      resolve();
      return;
    }
    tl.timeScale(1 / motionSettings.timeScale);
    tl.eventCallback('onComplete', () => resolve());
    tl.eventCallback('onInterrupt', () => resolve());
    tl.play();
  });
}

/** Wait in real time (scaled by the motion timescale). Rejects nothing; resolves early on abort. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (motionSettings.timeScale <= 0 || ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(done, ms * motionSettings.timeScale);
    function done(): void {
      signal?.removeEventListener('abort', done);
      clearTimeout(id);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Kill all tweens of the given targets (on destroy). */
export function killTweens(...targets: object[]): void {
  for (const t of targets) gsap.killTweensOf(t);
}

/** Kill tweens on a display object and all descendants (and their transform sub-objects). */
export function killTweensDeep(root: { children?: readonly unknown[] } | null | undefined): void {
  if (!root) return;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const o = stack.pop() as
      | {
          children?: readonly unknown[];
          scale?: object;
          position?: object;
          skew?: object;
          pivot?: object;
          destroyed?: boolean;
        }
      | undefined;
    if (!o || o.destroyed) continue;
    gsap.killTweensOf(o);
    for (const sub of [o.scale, o.position, o.skew, o.pivot]) if (sub) gsap.killTweensOf(sub);
    if (o.children) stack.push(...o.children);
  }
}
