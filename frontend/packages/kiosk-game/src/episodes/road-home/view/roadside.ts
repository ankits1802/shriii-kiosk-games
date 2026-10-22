/**
 * Optional roadside opportunities (initiative, EPI-03): a stranded traveller with a wheel off his
 * hand cart, an unlit shrine lamp, a spilled basket of mangoes, a thirsty calf at an empty trough and
 * a fallen signpost. They are visible and tappable but NEVER prompted: no voice, no hand hint, no
 * pulsing beyond the soft "touchable" glow every tappable thing in the episode wears. Helping plays a
 * warm little resolution; passing by is met with a friendly wave (never a reproach).
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { drawDiya } from '../../../art/backdrop/props.ts';
import type { ProceduralCharacter } from '../../../art/characters/index.ts';
import { CHILD_VARIANT } from '../../../art/characters/index.ts';
import { darken, lighten } from '../../../art/color.ts';
import { softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { createBasket, createGood, HandCart } from '../../../art/props/index.ts';
import type { Rect } from '../../../core/contracts.ts';
import type { OptionalKind } from '../settings.ts';
import { type EpisodeArt, splitLit } from './art.ts';
import type { GroundMetrics } from './landscape.ts';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RoadsidePiece {
  readonly view = new Container();
  private readonly glow: Sprite;
  private person: ProceduralCharacter | null = null;
  private readonly depth: number;
  private readonly baseY: number;
  private t = 0;
  private revealed = false;
  /** Parts animated by the resolution. */
  private parts: Record<string, Container> = {};
  private flame: Graphics | null = null;
  private lampGlow: Sprite | null = null;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private readonly tick = (): void => {
    const dt = Math.min(0.05, this.art.ticker.deltaMS / 1000);
    this.t += dt;
    if (this.revealed) this.glow.alpha = 0.5 + 0.14 * Math.sin(this.t * 2.1) * this.art.motion;
    if (this.flame) this.flame.scale.y = 1 + 0.1 * Math.sin(this.t * 13) * this.art.motion;
  };

  constructor(
    private readonly art: EpisodeArt,
    private readonly m: GroundMetrics,
    readonly kind: OptionalKind,
  ) {
    this.view.label = `roadside:${kind}`;
    this.view.eventMode = 'none';
    const far = kind === 'stranded_traveller' || kind === 'shrine_lamp' || kind === 'thirsty_calf';
    this.depth = far ? 1.05 : 1.2;
    this.baseY = far ? m.roadY - m.roadH * 0.68 : m.roadY + m.roadH * 1.15;
    this.view.y = this.baseY;
    this.glow = art.glow(150 * art.unit * this.depth, 0xfff0c0, 0);
    this.glow.y = -60 * art.unit * this.depth;
    this.view.addChild(this.glow);
    switch (kind) {
      case 'stranded_traveller':
        this.buildTraveller();
        break;
      case 'shrine_lamp':
        this.buildShrine();
        break;
      case 'spilled_mangoes':
        this.buildMangoes();
        break;
      case 'thirsty_calf':
        this.buildCalf();
        break;
      case 'fallen_signpost':
        this.buildSignpost();
        break;
    }
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  private get s(): number {
    return this.art.unit * this.depth;
  }

  private personAt(x: number, variant: number, scale = 0.56): ProceduralCharacter {
    const p = this.art.character({
      id: `road_home.roadside.${this.kind}`,
      role: 'vendor',
      variant,
      view: 'three_quarter',
      facing: 'left',
      scale: scale * this.depth,
    });
    p.view.x = x * this.s;
    this.view.addChild(p.view);
    this.person = p;
    return p;
  }

  private buildTraveller(): void {
    const s = this.s;
    const cart = new HandCart(MELA.peacock, 0.62 * this.depth * this.art.unit);
    cart.tray.addChild(createBasket({ contents: 'onion', count: 5, width: 60 }));
    cart.view.rotation = -0.16;
    cart.view.position.set(40 * s, 6 * s);
    this.view.addChild(cart.view);
    this.parts.cart = cart.view;
    const wheel = new Graphics();
    wheel.circle(0, 0, 15 * s).stroke({ width: 4 * s, color: MELA.woodDark });
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      wheel
        .moveTo(0, 0)
        .lineTo(Math.cos(a) * 15 * s, Math.sin(a) * 15 * s)
        .stroke({ width: 2 * s, color: MELA.wood });
    }
    wheel.circle(0, 0, 3 * s).fill(MELA.brass);
    wheel.scale.y = 0.45;
    wheel.position.set(-48 * s, 4 * s);
    this.view.addChild(wheel);
    this.parts.wheel = wheel;
    const p = this.personAt(-10, 0);
    p.setExpression('thinking');
  }

  private buildShrine(): void {
    const s = this.s;
    const g = new Graphics();
    softShadow(g, 0, 0, 62 * s, 10 * s, MELA.ink, 0.35);
    g.roundRect(-46 * s, -24 * s, 92 * s, 24 * s, 4 * s).fill(
      vgrad([
        [0, 0xe6d6b8],
        [1, 0xb8a382],
      ]),
    );
    g.moveTo(-36 * s, -24 * s)
      .lineTo(-36 * s, -96 * s)
      .quadraticCurveTo(0, -150 * s, 36 * s, -96 * s)
      .lineTo(36 * s, -24 * s)
      .closePath()
      .fill(
        vgrad([
          [0, 0xf2e6cc],
          [1, 0xcdb48c],
        ]),
      );
    g.moveTo(-22 * s, -30 * s)
      .lineTo(-22 * s, -86 * s)
      .quadraticCurveTo(0, -118 * s, 22 * s, -86 * s)
      .lineTo(22 * s, -30 * s)
      .closePath()
      .fill(0x5a3a2a);
    // A vermilion-smeared stone with marigolds (a village deity stone, no figure).
    g.ellipse(0, -44 * s, 11 * s, 15 * s).fill(MELA.vermilion);
    g.ellipse(-3 * s, -50 * s, 4 * s, 5 * s).fill({
      color: lighten(MELA.vermilion, 0.3),
      alpha: 0.7,
    });
    for (let k = 0; k < 9; k += 1) {
      const a = Math.PI + (k / 8) * Math.PI;
      g.circle(Math.cos(a) * 20 * s, -40 * s + Math.sin(a) * 26 * s, 3.4 * s).fill(
        k % 2 ? MELA.marigold : MELA.saffron,
      );
    }
    g.moveTo(-3 * s, -150 * s)
      .lineTo(-3 * s, -190 * s)
      .stroke({ width: 2 * s, color: 0x6a4a22 });
    g.poly([-3 * s, -190 * s, 28 * s, -180 * s, -3 * s, -170 * s]).fill(MELA.saffron);
    this.view.addChild(g);
    const diya = drawDiya(s * 1.1);
    const holder = new Container();
    holder.addChild(diya.bowl);
    holder.position.set(30 * s, -26 * s);
    holder.label = 'lit';
    this.view.addChild(holder);
    diya.flame.scale.set(0);
    holder.addChild(diya.flame);
    this.flame = diya.flame;
    const lg = this.art.glow(80 * s, 0xffa347, 0);
    lg.position.set(diya.light.x, diya.light.y);
    holder.addChild(lg);
    this.lampGlow = lg;
    this.parts.diya = holder;
  }

  private buildMangoes(): void {
    const s = this.s;
    const basket = createBasket({ contents: 'mango', count: 3, width: 64 });
    basket.scale.set(s);
    basket.rotation = 1.2;
    basket.position.set(36 * s, -8 * s);
    this.view.addChild(basket);
    this.parts.basket = basket;
    for (let i = 0; i < 5; i += 1) {
      const m = createGood('mango', s * 1.1);
      m.position.set((70 + i * 22) * s, (-2 + (i % 2) * 8) * s);
      m.rotation = i * 0.7;
      this.view.addChild(m);
      this.parts[`mango${i}`] = m;
    }
    const p = this.personAt(-30, 2, 0.6);
    p.setExpression('surprised');
  }

  private buildCalf(): void {
    const s = this.s;
    const g = new Graphics();
    softShadow(g, 30 * s, 0, 70 * s, 9 * s, MELA.ink, 0.3);
    // Hand pump and an empty stone trough.
    g.rect(-70 * s, -70 * s, 9 * s, 70 * s).fill(0x5b6670);
    g.rect(-76 * s, -78 * s, 22 * s, 10 * s).fill(0x6b7680);
    g.moveTo(-62 * s, -74 * s)
      .lineTo(-34 * s, -92 * s)
      .stroke({ width: 4 * s, color: 0x4a545c, cap: 'round' });
    g.moveTo(-70 * s, -52 * s)
      .lineTo(-52 * s, -52 * s)
      .stroke({ width: 5 * s, color: 0x4a545c });
    g.roundRect(-50 * s, -22 * s, 76 * s, 22 * s, 5 * s).fill(
      vgrad([
        [0, 0xb8b0a0],
        [1, 0x8a8274],
      ]),
    );
    g.roundRect(-46 * s, -19 * s, 68 * s, 12 * s, 4 * s).fill(0x6a6458);
    this.view.addChild(g);
    const water = new Graphics()
      .roundRect(-46 * s, -19 * s, 68 * s, 12 * s, 4 * s)
      .fill({ color: 0x5aa0d0, alpha: 0.9 });
    water.scale.y = 0;
    water.pivot.y = -7 * s;
    water.y = -7 * s;
    this.view.addChild(water);
    this.parts.water = water;
    const calf = new Container();
    const c = new Graphics();
    const hide = 0xf2ead8;
    c.roundRect(-30 * s, -52 * s, 60 * s, 30 * s, 14 * s).fill(hide);
    c.ellipse(-8 * s, -42 * s, 10 * s, 7 * s).fill(0xb08a6a);
    for (const x of [-22, -12, 14, 24])
      c.roundRect(x * s, -26 * s, 6 * s, 26 * s, 3 * s).fill(darken(hide, 0.1));
    c.moveTo(-30 * s, -46 * s)
      .quadraticCurveTo(-42 * s, -40 * s, -38 * s, -24 * s)
      .stroke({ width: 2.5 * s, color: darken(hide, 0.3) });
    calf.addChild(c);
    const head = new Graphics();
    head.ellipse(0, 0, 13 * s, 10 * s).fill(hide);
    head.ellipse(-9 * s, 5 * s, 6 * s, 5 * s).fill(0xd8b0a0);
    head.circle(-3 * s, -3 * s, 2.2 * s).fill(0x1a1210);
    head.ellipse(6 * s, -9 * s, 6 * s, 3 * s).fill(darken(hide, 0.15));
    head.position.set(-34 * s, -52 * s);
    head.pivot.set(8 * s, 6 * s);
    calf.addChild(head);
    calf.position.set(70 * s, 0);
    this.view.addChild(calf);
    this.parts.calfHead = head;
  }

  private buildSignpost(): void {
    const s = this.s;
    const post = new Container();
    const g = new Graphics();
    g.rect(-5 * s, -130 * s, 10 * s, 130 * s).fill(
      vgrad([
        [0, 0xa07a4a],
        [1, 0x6a4a22],
      ]),
    );
    // Pictured direction boards: a house and a temple (no lettering).
    g.poly([
      -6 * s,
      -124 * s,
      64 * s,
      -124 * s,
      78 * s,
      -110 * s,
      64 * s,
      -96 * s,
      -6 * s,
      -96 * s,
    ]).fill(0xd8b07a);
    g.poly([10 * s, -102 * s, 26 * s, -116 * s, 42 * s, -102 * s]).fill(MELA.terracotta);
    g.rect(14 * s, -102 * s, 24 * s, 4 * s).fill(0xf0dcc0);
    g.poly([
      6 * s,
      -88 * s,
      -64 * s,
      -88 * s,
      -78 * s,
      -74 * s,
      -64 * s,
      -60 * s,
      6 * s,
      -60 * s,
    ]).fill(0xc89a64);
    g.poly([-30 * s, -66 * s, -22 * s, -84 * s, -14 * s, -66 * s]).fill(MELA.sandstone);
    g.poly([-24 * s, -84 * s, -18 * s, -84 * s, -22 * s, -90 * s]).fill(MELA.saffron);
    post.addChild(g);
    post.rotation = -1.42;
    post.position.set(40 * s, -6 * s);
    const sh = new Graphics();
    softShadow(sh, 40 * s, 0, 80 * s, 8 * s, MELA.ink, 0.3);
    this.view.addChild(sh, post);
    this.parts.post = post;
    const p = this.art.character({
      id: 'road_home.roadside.child',
      role: 'customer',
      variant: CHILD_VARIANT,
      view: 'three_quarter',
      facing: 'left',
      scale: 0.45 * this.depth,
    });
    p.view.x = -40 * s;
    this.view.addChild(p.view);
    this.person = p;
    p.setExpression('thinking');
  }

  /** Show the soft touchable glow; the person glances at the cart. */
  reveal(cartScreen: { x: number; y: number }): void {
    this.revealed = true;
    this.person?.lookAt(cartScreen);
  }

  /** Stage-space target around the vignette (>= 20 mm). */
  target(screenX: number): Rect {
    const s = this.s;
    const w = Math.max(this.art.mm(34), 230 * s);
    const h = Math.max(this.art.mm(30), 200 * s);
    const cx = screenX + 20 * s;
    const top = this.baseY - h * 0.82;
    return {
      x: cx - w / 2,
      y: Math.max(this.m.horizonY - 10, top),
      width: w,
      height: Math.min(h, this.art.h - top - this.art.mm(3)),
    };
  }

  /** Local anchor of the vignette's centre (for sparkles and ripples). */
  get centre(): { x: number; y: number } {
    return { x: 20 * this.s, y: -60 * this.s };
  }

  /** Resolution beat. Resolves after `ms`. */
  async resolve(taken: boolean, ms: number): Promise<void> {
    this.revealed = false;
    gsap.to(this.glow, { alpha: 0, duration: 0.2 });
    const s = this.s;
    const p = this.person;
    if (!taken) {
      if (p) void p.play('wave');
      await wait(ms);
      return;
    }
    const sec = ms / 1000;
    const sparkle = (): void => this.art.burst(this.view, 'sparkle', this.centre, 16);
    switch (this.kind) {
      case 'stranded_traveller': {
        const wheel = this.parts.wheel;
        const cart = this.parts.cart;
        if (wheel && cart) {
          gsap
            .timeline()
            .to(wheel, { x: 4 * s, y: -26 * s, duration: sec * 0.3, ease: 'power2.out' })
            .to(wheel.scale, { y: 1, duration: sec * 0.3 }, '<')
            .to(wheel, { x: 20 * s, y: 2 * s, alpha: 0, duration: sec * 0.25, ease: 'power2.in' })
            .to(cart, { rotation: 0, duration: sec * 0.3, ease: 'back.out(2)' }, '<');
        }
        p?.react('delighted', 1.4);
        if (p) void p.play('namaste');
        break;
      }
      case 'shrine_lamp': {
        if (this.flame)
          gsap.to(this.flame.scale, { x: 1, y: 1, duration: sec * 0.35, ease: 'back.out(3)' });
        if (this.lampGlow) gsap.to(this.lampGlow, { alpha: 1, duration: sec * 0.5 });
        this.art.burst(this.view, 'petals', { x: 0, y: -120 * s }, 18);
        break;
      }
      case 'spilled_mangoes': {
        const basket = this.parts.basket;
        if (basket) gsap.to(basket, { rotation: 0, duration: sec * 0.3, ease: 'back.out(2)' });
        for (let i = 0; i < 5; i += 1) {
          const mgo = this.parts[`mango${i}`];
          if (!mgo) continue;
          gsap
            .timeline({ delay: sec * (0.15 + i * 0.07) })
            .to(mgo, {
              x: 36 * s,
              y: -46 * s,
              rotation: 0,
              duration: sec * 0.25,
              ease: 'power2.out',
            })
            .to(mgo, { y: -24 * s, alpha: 0, duration: sec * 0.15, ease: 'power2.in' });
        }
        p?.react('delighted', 1.4);
        if (p) void p.play('namaste');
        break;
      }
      case 'thirsty_calf': {
        const water = this.parts.water;
        const head = this.parts.calfHead;
        if (water) gsap.to(water.scale, { y: 1, duration: sec * 0.4, ease: 'power2.out' });
        if (head)
          gsap
            .timeline({ delay: sec * 0.35 })
            .to(head, { rotation: -0.5, duration: sec * 0.2 })
            .to(head, { rotation: -0.35, duration: sec * 0.15, yoyo: true, repeat: 1 });
        break;
      }
      case 'fallen_signpost': {
        const post = this.parts.post;
        if (post) gsap.to(post, { rotation: 0, duration: sec * 0.45, ease: 'elastic.out(1, 0.5)' });
        p?.react('delighted', 1.4);
        if (p) void p.play('celebrate');
        break;
      }
    }
    sparkle();
    await wait(ms);
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    gsap.killTweensOf(this.glow);
    for (const c of Object.values(this.parts)) {
      gsap.killTweensOf(c);
      gsap.killTweensOf(c.scale);
    }
    if (this.flame) gsap.killTweensOf(this.flame.scale);
    this.person?.destroy();
    this.view.destroy({ children: true });
  }
}
