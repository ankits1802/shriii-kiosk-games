/**
 * Squash-and-stretch and small reaction tweens for diegetic UI (coins, baskets, lamps, tiles).
 * All are fire-and-forget, reduced-motion aware (they collapse to a quick fade/scale) and never sit
 * on a timing path.
 */
import { gsap } from 'gsap';
import type { Container } from 'pixi.js';
import { motionSettings } from '../../../art/motion.ts';

function alive(v: Container): boolean {
  return !v.destroyed;
}

/**
 * Live transform state of a view, tweened instead of the view itself: GSAP writes the proxy and the
 * values reach the view only while it is alive, so a view destroyed mid-tween (a tile cleared, a scene
 * torn down) never receives a write.
 */
interface Pose {
  y: number;
  sx: number;
  sy: number;
}

const poses = new WeakMap<Container, Pose>();

function poseOf(view: Container): Pose {
  let p = poses.get(view);
  if (!p) {
    p = { y: view.y, sx: view.scale.x, sy: view.scale.y };
    poses.set(view, p);
  } else {
    p.y = view.y;
    p.sx = view.scale.x;
    p.sy = view.scale.y;
  }
  return p;
}

/** Write the animated channels (scale always; `y` only for helpers that move the view). */
function applyPose(view: Container, p: Pose, moveY = false): void {
  if (!alive(view)) return;
  view.scale.set(p.sx, p.sy);
  if (moveY) view.y = p.y;
}

/** Stop the motion helpers' tweens on a view (also kills direct tweens on it and its scale). */
function stopPose(view: Container): void {
  const p = poses.get(view);
  if (p) gsap.killTweensOf(p);
  gsap.killTweensOf(view.scale);
}

/** Pop a view in from nothing with an elastic overshoot. */
export function popIn(view: Container, delayS = 0, durationS = 0.55, to = 1): void {
  if (!alive(view)) return;
  stopPose(view);
  if (motionSettings.reducedMotion) {
    view.scale.set(to);
    view.alpha = 0;
    gsap.to(view, { alpha: 1, duration: 0.18, delay: delayS });
    return;
  }
  view.scale.set(0.01);
  const p = poseOf(view);
  gsap.to(p, {
    sx: to,
    sy: to,
    duration: durationS,
    delay: delayS,
    ease: 'elastic.out(1.1, 0.5)',
    onUpdate: () => applyPose(view, p),
  });
}

/** Shrink a view away and resolve (then the caller may destroy it). */
export function popOut(view: Container, durationS = 0.28): Promise<void> {
  if (!alive(view)) return Promise.resolve();
  stopPose(view);
  const p = poseOf(view);
  return new Promise((resolve) => {
    gsap.to(p, {
      sx: 0.01,
      sy: 0.01,
      duration: motionSettings.reducedMotion ? 0.12 : durationS,
      ease: 'back.in(2)',
      onUpdate: () => applyPose(view, p),
      onComplete: resolve,
      onInterrupt: resolve,
    });
  });
}

/** Squash-and-stretch "thump" (a tap landing on an object). */
export function squash(view: Container, amount = 0.18, base = 1): void {
  if (!alive(view)) return;
  stopPose(view);
  if (motionSettings.reducedMotion) {
    view.scale.set(base);
    return;
  }
  const p = poseOf(view);
  const upd = { onUpdate: () => applyPose(view, p) };
  gsap
    .timeline()
    .to(p, { sx: base * (1 + amount), sy: base * (1 - amount), duration: 0.07, ...upd })
    .to(p, { sx: base * (1 - amount * 0.6), sy: base * (1 + amount * 0.7), duration: 0.1, ...upd })
    .to(p, { sx: base, sy: base, duration: 0.45, ease: 'elastic.out(1.2, 0.35)', ...upd });
}

/** Hop: a little jump with stretch on take-off and squash on landing. */
export function hop(view: Container, heightPx: number, base = 1): void {
  if (!alive(view)) return;
  if (motionSettings.reducedMotion) return;
  stopPose(view);
  const p = poseOf(view);
  const y0 = p.y;
  const upd = { onUpdate: () => applyPose(view, p, true) };
  gsap
    .timeline()
    .to(p, { sx: base * 1.1, sy: base * 0.88, duration: 0.07, ...upd })
    .to(p, { y: y0 - heightPx, duration: 0.2, ease: 'power2.out', ...upd }, '>')
    .to(p, { sx: base * 0.92, sy: base * 1.1, duration: 0.2, ...upd }, '<')
    .to(p, { y: y0, duration: 0.18, ease: 'power2.in', ...upd })
    .to(p, { sx: base * 1.12, sy: base * 0.86, duration: 0.06, ...upd })
    .to(p, { sx: base, sy: base, duration: 0.35, ease: 'elastic.out(1.1, 0.4)', ...upd });
}

/** Gentle idle bob (loops until stopped with {@link still}). */
export function bob(view: Container, amplitudePx: number, periodS = 2.4): void {
  if (!alive(view) || motionSettings.reducedMotion) return;
  stopPose(view);
  const p = poseOf(view);
  gsap.to(p, {
    y: p.y - amplitudePx,
    duration: periodS / 2,
    ease: 'sine.inOut',
    yoyo: true,
    repeat: -1,
    onUpdate: () => applyPose(view, p, true),
  });
}

/** Arc a view from its position to `(x, y)` (a thrown coin), resolving on landing. */
export function arcTo(
  view: Container,
  x: number,
  y: number,
  options: { readonly lift?: number; readonly durationS?: number; readonly delayS?: number } = {},
): Promise<void> {
  if (!alive(view)) return Promise.resolve();
  const x0 = view.x;
  const y0 = view.y;
  const lift = options.lift ?? Math.max(40, Math.abs(x - x0) * 0.35);
  const d = motionSettings.reducedMotion ? 0.15 : (options.durationS ?? 0.55);
  const state = { t: 0 };
  return new Promise((resolve) => {
    gsap.to(state, {
      t: 1,
      duration: d,
      delay: options.delayS ?? 0,
      ease: 'sine.inOut',
      onUpdate: () => {
        if (!alive(view)) return;
        const t = state.t;
        view.x = x0 + (x - x0) * t;
        view.y = y0 + (y - y0) * t - Math.sin(Math.PI * t) * lift;
      },
      onComplete: resolve,
      onInterrupt: resolve,
    });
  });
}

/** Kill every tween on a view, its scale and its motion-helper pose. */
export function still(view: Container): void {
  gsap.killTweensOf(view);
  stopPose(view);
}
