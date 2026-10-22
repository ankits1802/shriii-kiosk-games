/**
 * The luck-token corner: an embroidered cloth screen on a bamboo frame rises on the counter, a carved
 * wooden cup shakes and a die tumbles into a little tray on the player's side of the screen.
 *
 * Privacy (dice mode a, non-negotiable 6): {@link LuckStation.showFace} draws the face straight into a
 * Graphics and keeps no number, label or other trace of it; {@link LuckStation.clear} wipes the drawing.
 * Before the reveal the tumbling die shows no pips (nothing that could be mistaken for the roll).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { lgrad, marigold, rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { motionSettings } from '../../../art/motion.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';

const DIE = 64;

function drawDieBody(g: Graphics): void {
  g.roundRect(-DIE / 2, -DIE / 2, DIE, DIE, 14).fill(
    rgrad(
      [
        [0, 0xf6e2b8],
        [0.7, 0xd9ac6c],
        [1, 0xa8773c],
      ],
      { x: 0.35, y: 0.3 },
      0.9,
    ),
  );
  g.roundRect(-DIE / 2, -DIE / 2, DIE, DIE, 14).stroke({ width: 3, color: MELA.wood });
  g.moveTo(-DIE * 0.3, -DIE * 0.36)
    .quadraticCurveTo(0, -DIE * 0.42, DIE * 0.3, -DIE * 0.36)
    .stroke({
      width: 3,
      color: 0xffffff,
      alpha: 0.35,
      cap: 'round',
    });
}

export class LuckStation {
  readonly view = new Container();
  private readonly screen = new Container();
  private readonly tray = new Container();
  private readonly cup = new Container();
  private readonly die = new Container();
  private readonly pips = new Graphics();
  private readonly tokens = new Container();
  private readonly u: number;
  private readonly bowl: { x: number; y: number };
  private readonly rnd = new ArtRandom(808);
  private tl: gsap.core.Timeline | null = null;

  constructor(
    centre: { x: number; y: number },
    width: number,
    height: number,
    u: number,
    bowl: { x: number; y: number },
  ) {
    this.u = u;
    this.bowl = bowl;
    this.view.label = 'luck-station';
    this.view.eventMode = 'none';
    this.view.position.set(centre.x, centre.y);
    // Screen: bamboo frame + embroidered cloth with mirror work.
    const s = new Graphics();
    const w = width;
    const h = height;
    softShadow(s, 0, 4 * u, w * 0.55, 14 * u, MELA.ink, 0.4);
    s.rect(-w / 2, -h, w, h).fill(
      vgrad([
        [0, lighten(MELA.peacockDeep, 0.1)],
        [1, darken(MELA.peacockDeep, 0.25)],
      ]),
    );
    const rnd = new ArtRandom(61);
    for (let y = -h + 30 * u; y < -16 * u; y += 46 * u) {
      for (
        let x = -w / 2 + 26 * u + ((y / (46 * u)) % 2) * 22 * u;
        x < w / 2 - 12 * u;
        x += 52 * u
      ) {
        s.circle(x, y, 9 * u).fill(MELA.marigold);
        s.circle(x, y, 5.5 * u).fill(
          rgrad(
            [
              [0, 0xffffff],
              [1, 0xbfd7e0],
            ],
            { x: 0.35, y: 0.3 },
            0.8,
          ),
        );
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + rnd.range(-0.1, 0.1);
          s.circle(x + Math.cos(a) * 14 * u, y + Math.sin(a) * 14 * u, 2 * u).fill(MELA.rose);
        }
      }
    }
    s.rect(-w / 2, -h, w, 12 * u).fill(MELA.vermilion);
    s.rect(-w / 2, -16 * u, w, 12 * u).fill(MELA.vermilion);
    for (let x = -w / 2 + 8 * u; x < w / 2; x += 18 * u)
      marigold(s, x, -h + 6 * u, 5 * u, MELA.marigold);
    for (const x of [-w / 2, w / 2]) {
      s.roundRect(x - 8 * u, -h - 14 * u, 16 * u, h + 18 * u, 6 * u).fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, 0xb89a4a],
          [0.5, 0xe8d08a],
          [1, 0x9a7c34],
        ]),
      );
      for (let k = 1; k < 5; k++) s.rect(x - 9 * u, -h + (k * h) / 5, 18 * u, 4 * u).fill(0x8a6a2a);
    }
    this.screen.addChild(s);
    // Tray in front of the screen (the player's side).
    const t = new Graphics();
    softShadow(t, 0, 10 * u, 130 * u, 14 * u, MELA.ink, 0.35);
    t.roundRect(-120 * u, -18 * u, 240 * u, 30 * u, 10 * u).fill(darken(MELA.wood, 0.3));
    t.roundRect(-112 * u, -14 * u, 224 * u, 20 * u, 8 * u).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, darken(MELA.wood, 0.1)],
        [1, darken(MELA.wood, 0.45)],
      ]),
    );
    this.tray.addChild(t);
    this.tray.position.set(0, 30 * u);
    // Carved cup.
    const c = new Graphics();
    c.moveTo(-34 * u, -70 * u)
      .lineTo(-26 * u, 0)
      .lineTo(26 * u, 0)
      .lineTo(34 * u, -70 * u)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.wood, 0.4)],
          [0.4, lighten(MELA.wood, 0.25)],
          [1, darken(MELA.wood, 0.5)],
        ]),
      );
    c.ellipse(0, -70 * u, 34 * u, 9 * u).fill(MELA.woodDark);
    for (const y of [-56, -30]) c.rect(-31 * u, y * u, 62 * u, 5 * u).fill(MELA.brass);
    this.cup.addChild(c);
    this.cup.position.set(-150 * u, 18 * u);
    // Die.
    const body = new Graphics();
    drawDieBody(body);
    this.die.addChild(body, this.pips);
    this.die.scale.set(u);
    this.die.visible = false;
    this.view.addChild(this.screen, this.tray, this.cup, this.die);
    this.tokens.label = 'luck-tokens';
    this.view.visible = false;
  }

  /** Container for the luck tokens collected in the bowl (stage coordinates). */
  get tokenLayer(): Container {
    return this.tokens;
  }

  raise(): void {
    this.view.visible = true;
    const reduced = motionSettings.reducedMotion;
    this.screen.y = reduced ? 0 : 220 * this.u;
    this.screen.alpha = reduced ? 1 : 0;
    gsap.to(this.screen, { y: 0, alpha: 1, duration: reduced ? 0.01 : 0.7, ease: 'back.out(1.4)' });
    this.cup.alpha = 0;
    this.tray.alpha = 0;
    gsap.to([this.cup, this.tray], { alpha: 1, duration: 0.4, delay: reduced ? 0 : 0.35 });
  }

  lower(): void {
    const reduced = motionSettings.reducedMotion;
    gsap.to(this.screen, {
      y: reduced ? 0 : 240 * this.u,
      alpha: 0,
      duration: reduced ? 0.15 : 0.45,
      ease: 'power2.in',
      onComplete: () => {
        this.view.visible = false;
      },
    });
    gsap.to([this.cup, this.tray, this.die], { alpha: 0, duration: 0.3 });
  }

  /** Cup shakes, tips, and the die tumbles into the tray (no pips shown while tumbling). */
  roll(durationMs: number): void {
    this.pips.clear();
    const u = this.u;
    const d = durationMs / 1000;
    const reduced = motionSettings.reducedMotion;
    gsap.killTweensOf(this.cup);
    gsap.killTweensOf(this.die);
    gsap.killTweensOf(this.die.scale);
    this.die.visible = true;
    this.die.alpha = 1;
    const endX = this.rnd.range(-30, 40) * u;
    const endY = 30 * u - 4 * u;
    if (reduced) {
      this.die.position.set(endX, endY);
      this.die.rotation = 0;
      return;
    }
    this.cup.rotation = 0;
    this.tl?.kill();
    const tl = gsap.timeline();
    this.tl = tl;
    tl.to(this.cup, {
      rotation: 0.18,
      duration: d * 0.1,
      yoyo: true,
      repeat: 3,
      ease: 'sine.inOut',
    })
      .to(this.cup, { rotation: 1.2, duration: d * 0.18, ease: 'power2.in' })
      .to(this.cup, { rotation: 0, duration: d * 0.25, ease: 'back.out(1.5)' }, `>+${d * 0.05}`);
    this.die.position.set(-140 * u, -40 * u);
    this.die.rotation = 0;
    gsap.to(this.die, { x: endX, duration: d * 0.55, delay: d * 0.4, ease: 'power1.out' });
    gsap.to(this.die, {
      rotation: Math.PI * 4 + this.rnd.range(-0.15, 0.15),
      duration: d * 0.55,
      delay: d * 0.4,
      ease: 'power2.out',
    });
    gsap.fromTo(
      this.die,
      { y: -40 * u },
      { y: endY, duration: d * 0.55, delay: d * 0.4, ease: 'bounce.out' },
    );
  }

  /** Draw the private face. Keeps no trace of `face`. */
  showFace(face: number): void {
    gsap.killTweensOf(this.die);
    this.die.rotation = 0;
    const g = this.pips;
    g.clear();
    const o = DIE * 0.27;
    const at = (x: number, y: number): void => {
      g.circle(x, y, 6.2).fill(MELA.woodDark);
      g.circle(x - 1.5, y - 1.5, 2).fill({ color: 0xffffff, alpha: 0.25 });
    };
    if (face % 2 === 1) at(0, 0);
    if (face >= 2) {
      at(-o, -o);
      at(o, o);
    }
    if (face >= 4) {
      at(o, -o);
      at(-o, o);
    }
    if (face === 6) {
      at(-o, 0);
      at(o, 0);
    }
  }

  /** Wipe the face drawing (right after the report). */
  clear(): void {
    this.pips.clear();
    gsap.to(this.die, { alpha: 0, duration: 0.25 });
  }

  /** Pictured luck tokens (marigolds) for the reported value drop into the bowl. */
  award(count: number): void {
    const u = this.u;
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      marigold(g, 0, 0, 13 * u, i % 2 ? MELA.marigold : MELA.marigoldDeep);
      const tx = this.bowl.x + this.rnd.range(-30, 30) * u;
      const ty = this.bowl.y - 12 * u - this.rnd.range(0, 10) * u;
      g.position.set(this.view.x + this.die.x, this.view.y + this.die.y);
      this.tokens.addChild(g);
      if (motionSettings.reducedMotion) {
        g.position.set(tx, ty);
        continue;
      }
      gsap.to(g, { x: tx, duration: 0.42, delay: i * 0.05, ease: 'power1.inOut' });
      gsap.to(g, { y: ty, duration: 0.42, delay: i * 0.05, ease: 'back.in(1.2)' });
      gsap.fromTo(g.scale, { x: 0.4, y: 0.4 }, { x: 1, y: 1, duration: 0.3, delay: i * 0.05 });
    }
    // Keep the bowl tidy: only the latest handful stay visible.
    while (this.tokens.children.length > 18) this.tokens.children[0]?.destroy();
  }

  destroy(): void {
    this.tl?.kill();
    for (const o of [this.screen, this.cup, this.tray, this.die, this.die.scale])
      gsap.killTweensOf(o);
    for (const ch of this.tokens.children) gsap.killTweensOf(ch);
    this.tokens.destroy({ children: true });
    this.view.destroy({ children: true });
  }
}
