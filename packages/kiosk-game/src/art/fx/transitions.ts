/**
 * Cinematic full-stage transitions on a top overlay layer: fade (warm cream), iris (a golden-rimmed
 * circle closes on the centre and reopens), wipes (a paisley-edged saffron band with a light sweep),
 * curtain (velvet theatre curtains with gold trim). Under reduced motion every transition becomes a
 * short cross-fade. Transitions never flash.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import type { TransitionKind } from '../../core/contracts.ts';
import { drawPaisley } from '../backdrop/props.ts';
import { darken, lighten } from '../color.ts';
import { hgrad, rgrad, vgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';

export interface TransitionHost {
  readonly overlay: Container;
  width(): number;
  height(): number;
  readonly reducedMotion: boolean;
}

function animate(target: object, vars: gsap.TweenVars): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(target, { ...vars, onComplete: () => resolve(), onInterrupt: () => resolve() });
  });
}

/** Run a transition; `midpoint` runs while the stage is fully covered. */
export async function runTransition(
  host: TransitionHost,
  kind: TransitionKind,
  options: { readonly durationMs?: number; readonly midpoint?: () => void | Promise<void> } = {},
): Promise<void> {
  const W = host.width();
  const H = host.height();
  const total = (options.durationMs ?? 1100) / 1000;
  const half = total / 2;
  const layer = new Container();
  layer.label = `transition:${kind}`;
  layer.eventMode = 'static'; // swallow taps while covered
  host.overlay.addChild(layer);
  const effective: TransitionKind = host.reducedMotion ? 'fade' : kind;
  try {
    switch (effective) {
      case 'fade': {
        const g = new Graphics().rect(0, 0, W, H).fill(
          vgrad([
            [0, MELA.cream],
            [1, MELA.parchment],
          ]),
        );
        g.alpha = 0;
        layer.addChild(g);
        await animate(g, {
          alpha: 1,
          duration: host.reducedMotion ? 0.25 : half,
          ease: 'sine.inOut',
        });
        await options.midpoint?.();
        await animate(g, {
          alpha: 0,
          duration: host.reducedMotion ? 0.25 : half,
          ease: 'sine.inOut',
        });
        break;
      }
      case 'iris': {
        const R = Math.hypot(W, H) * 0.55;
        const cover = new Graphics();
        const rim = new Graphics();
        layer.addChild(cover, rim);
        const st = { r: R };
        const draw = (): void => {
          cover.clear();
          cover.rect(-10, -10, W + 20, H + 20).fill(MELA.indigoDeep);
          if (st.r > 1) cover.circle(W / 2, H / 2, st.r).cut();
          rim.clear();
          if (st.r > 1) {
            rim
              .circle(W / 2, H / 2, st.r)
              .stroke({ width: Math.max(6, H * 0.012), color: MELA.brass });
            rim
              .circle(W / 2, H / 2, st.r + H * 0.02)
              .stroke({ width: H * 0.006, color: MELA.marigold, alpha: 0.7 });
          }
        };
        draw();
        await animate(st, { r: 0, duration: half, ease: 'power2.in', onUpdate: draw });
        await options.midpoint?.();
        await animate(st, { r: R, duration: half, ease: 'power2.out', onUpdate: draw });
        break;
      }
      case 'wipe_left':
      case 'wipe_right': {
        const dir = effective === 'wipe_left' ? -1 : 1;
        const band = new Container();
        const g = new Graphics();
        const bw = W * 1.25;
        g.rect(0, 0, bw, H).fill(
          hgrad([
            [0, darken(MELA.saffron, 0.1)],
            [0.5, MELA.saffron],
            [1, darken(MELA.saffron, 0.15)],
          ]),
        );
        // Paisley-scalloped leading edges.
        const scallop = H / 9;
        for (let i = 0; i < 9; i++) {
          g.circle(bw, scallop * (i + 0.5), scallop * 0.55).fill(MELA.saffron);
          g.circle(0, scallop * (i + 0.5), scallop * 0.55).fill(darken(MELA.saffron, 0.1));
          drawPaisley(
            g,
            bw * 0.5 + ((i % 3) - 1) * bw * 0.25,
            scallop * (i + 0.5),
            scallop * 0.25,
            lighten(MELA.saffron, 0.35),
          );
        }
        g.rect(bw - scallop * 0.2, 0, scallop * 0.12, H).fill(MELA.brass);
        g.rect(scallop * 0.08, 0, scallop * 0.12, H).fill(MELA.brass);
        const sweep = new Graphics().rect(0, 0, W * 0.25, H).fill(
          hgrad([
            [0, '#ffffff00'],
            [0.5, '#ffffff55'],
            [1, '#ffffff00'],
          ]),
        );
        sweep.blendMode = 'add';
        band.addChild(g, sweep);
        layer.addChild(band);
        const startX = dir < 0 ? W + scallop : -bw - scallop;
        const coverX = (W - bw) / 2;
        const endX = dir < 0 ? -bw - scallop : W + scallop;
        band.x = startX;
        sweep.x = 0;
        gsap.to(sweep, { x: bw - W * 0.25, duration: total, ease: 'none' });
        await animate(band, { x: coverX, duration: half, ease: 'power2.in' });
        await options.midpoint?.();
        await animate(band, { x: endX, duration: half, ease: 'power2.out' });
        break;
      }
      case 'curtain': {
        const make = (side: -1 | 1): Container => {
          const c = new Container();
          const g = new Graphics();
          const cw = W * 0.56;
          g.rect(0, 0, cw, H).fill(
            hgrad([
              [0, darken(MELA.kumkum, 0.35)],
              [0.5, MELA.kumkum],
              [1, darken(MELA.kumkum, 0.4)],
            ]),
          );
          const folds = 7;
          for (let i = 0; i < folds; i++) {
            const x = (cw / folds) * (i + 0.5);
            g.rect(x - cw * 0.02, 0, cw * 0.04, H).fill({ color: 0xffffff, alpha: 0.07 });
            g.rect(x + cw * 0.03, 0, cw * 0.025, H).fill({ color: 0x000000, alpha: 0.12 });
          }
          g.rect(side === -1 ? cw - H * 0.02 : 0, 0, H * 0.02, H).fill(MELA.brass);
          for (let y = H * 0.04; y < H; y += H * 0.07)
            g.circle(side === -1 ? cw - H * 0.01 : H * 0.01, y, H * 0.012).fill(MELA.marigold);
          g.rect(0, H - H * 0.04, cw, H * 0.04).fill(MELA.brass);
          c.addChild(g);
          return c;
        };
        const left = make(-1);
        const right = make(1);
        const pelmet = new Graphics();
        pelmet.rect(0, 0, W, H * 0.09).fill(
          vgrad([
            [0, darken(MELA.kumkum, 0.4)],
            [1, MELA.kumkum],
          ]),
        );
        for (let i = 0; i < 12; i++)
          pelmet.circle((W / 12) * (i + 0.5), H * 0.09, W / 26).fill(MELA.kumkum);
        pelmet.rect(0, H * 0.085, W, H * 0.008).fill(MELA.brass);
        const cw = W * 0.56;
        left.x = -cw;
        right.x = W;
        pelmet.y = -H * 0.15;
        layer.addChild(left, right, pelmet);
        await Promise.all([
          animate(left, { x: 0, duration: half, ease: 'power2.inOut' }),
          animate(right, { x: W - cw, duration: half, ease: 'power2.inOut' }),
          animate(pelmet, { y: 0, duration: half * 0.7, ease: 'power2.out' }),
        ]);
        await options.midpoint?.();
        await Promise.all([
          animate(left, { x: -cw, duration: half, ease: 'power2.inOut' }),
          animate(right, { x: W, duration: half, ease: 'power2.inOut' }),
          animate(pelmet, { y: -H * 0.15, duration: half, ease: 'power2.in', delay: half * 0.3 }),
        ]);
        break;
      }
    }
  } finally {
    layer.destroy({ children: true });
  }
}

/** A diagonal light sweep across the stage (cinematic accent between beats). */
export async function lightSweep(host: TransitionHost, durationMs = 900): Promise<void> {
  if (host.reducedMotion) return;
  const W = host.width();
  const H = host.height();
  const g = new Graphics().rect(0, -H * 0.5, W * 0.35, H * 2).fill(
    hgrad([
      [0, '#fff4de00'],
      [0.5, '#fff4de66'],
      [1, '#fff4de00'],
    ]),
  );
  g.blendMode = 'add';
  g.rotation = 0.25;
  g.x = -W * 0.5;
  g.eventMode = 'none';
  host.overlay.addChild(g);
  await animate(g, { x: W * 1.2, duration: durationMs / 1000, ease: 'power1.inOut' });
  g.destroy();
}

/** Radial golden glow pulse at a point (celebration accent without flashing). */
export async function glowBloom(
  host: TransitionHost,
  x: number,
  y: number,
  radius: number,
): Promise<void> {
  const g = new Graphics().circle(0, 0, radius).fill(
    rgrad([
      [0, '#fff2b0cc'],
      [0.5, '#ffd27a44'],
      [1, '#ffd27a00'],
    ]),
  );
  g.blendMode = 'add';
  g.position.set(x, y);
  g.scale.set(0.3);
  g.alpha = 0;
  g.eventMode = 'none';
  host.overlay.addChild(g);
  await Promise.all([
    animate(g.scale, { x: 1.2, y: 1.2, duration: 0.9, ease: 'power2.out' }),
    animate(g, { alpha: 1, duration: 0.3, yoyo: true, repeat: 1, ease: 'sine.inOut' }),
  ]);
  g.destroy();
}
