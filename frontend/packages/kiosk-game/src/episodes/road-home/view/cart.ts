/**
 * The travelling party on the journey road: the art kit's bullock cart with the player at the reins
 * (`steer_cart`) and the partner walking alongside on the near verge. The group rolls (wheels, the
 * bullock's walk, the partner's gait), bumps, climbs and celebrates; the partner carries the
 * emotional read of every beat (expressions and gestures, never a score).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import type { ProceduralCharacter } from '../../../art/characters/index.ts';
import { softShadow } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { BullockCart, createSack } from '../../../art/props/index.ts';
import type { EpisodeArt } from './art.ts';

export class JourneyCart {
  /** Positioned at the wheel contact point on the road. */
  readonly view = new Container();
  /** The cart itself (moves along branches/slopes relative to `view`). */
  readonly rig = new Container();
  readonly cart: BullockCart;
  readonly driver: ProceduralCharacter;
  readonly partner: ProceduralCharacter;
  private readonly dust = new Container();
  private readonly puffs: { g: Graphics; life: number; vx: number; vy: number }[] = [];
  private speed = 0;
  private walking = false;
  private puffAcc = 0;
  private seed = 1234567;
  private readonly tick = (): void => this.update(Math.min(0.05, this.art.ticker.deltaMS / 1000));
  /** Scale of the cart art relative to the screen unit. */
  readonly k: number;

  constructor(private readonly art: EpisodeArt) {
    this.view.label = 'journey-cart';
    this.view.eventMode = 'none';
    this.k = art.portrait ? 0.7 : 0.74;
    this.cart = new BullockCart();
    this.cart.bed.addChild(createSack({ open: false, height: 46 }));
    const sack = createSack({ open: true, contents: 'grain', height: 40 });
    sack.x = -50;
    this.cart.bed.addChild(sack);
    const pot = new Graphics();
    pot.ellipse(0, -22, 22, 20).fill(MELA.terracotta);
    pot.ellipse(0, -40, 12, 5).fill(0x7a3a24);
    pot.rect(-20, -26, 40, 4).fill({ color: MELA.cream, alpha: 0.7 });
    pot.x = 34;
    this.cart.bed.addChild(pot);
    this.cart.attach(art.ticker);
    this.driver = art.character({
      id: 'road_home.player',
      role: 'player',
      variant: 8,
      view: 'side',
      scale: 1 / art.unit,
    });
    this.driver.setIdleLife(false);
    this.driver.view.position.set(this.cart.seat.x, this.cart.seat.y);
    this.cart.driverLayer.addChild(this.driver.view);
    void this.driver.play('steer_cart');
    this.partner = art.character({
      id: 'road_home.partner',
      role: 'partner',
      view: 'side',
      variant: 9,
      scale: this.k * 0.97,
    });
    this.rig.addChild(this.cart.view);
    this.rig.scale.set(this.k * art.unit);
    const shadow = new Graphics();
    softShadow(shadow, 40 * art.unit, 0, 300 * this.k * art.unit, 14 * art.unit, MELA.ink, 0.25);
    this.view.addChild(shadow, this.dust, this.rig, this.partner.view);
    this.partner.view.position.set(-175 * art.unit * this.k, 34 * art.unit);
    art.ticker.add(this.tick);
  }

  /** Hand the partner to another scene layer (fodder stop) at stage-local `x, y` of `parent`. */
  lendPartner(parent: Container, x: number, y: number): void {
    void this.partner.stopLocomotion();
    this.walking = false;
    parent.addChild(this.partner.view);
    this.partner.view.position.set(x, y);
  }

  /** Bring the partner back beside the cart. */
  reclaimPartner(): void {
    this.view.addChild(this.partner.view);
    this.partner.view.position.set(-175 * this.art.unit * this.k, 34 * this.art.unit);
    this.partner.setFacing('right');
    this.partner.setView('side', true);
  }

  /** Front of the bullock in local px (where a fork junction should meet the cart). */
  get frontX(): number {
    return 470 * this.k * this.art.unit;
  }

  /** Visual width of the group (px). */
  get width(): number {
    return 760 * this.k * this.art.unit;
  }

  /** Ground speed in stage px/s: wheels, the bullock's walk and the partner's gait follow it. */
  roll(pxPerSecond: number): void {
    this.speed = pxPerSecond;
    // The cart prop works in rig units; convert from stage px.
    this.cart.setSpeed(pxPerSecond / (this.k * this.art.unit));
    const walk = Math.abs(pxPerSecond) > 4;
    if (walk !== this.walking) {
      this.walking = walk;
      if (walk) this.partner.setLocomotion('walk');
      else void this.partner.stopLocomotion();
    }
  }

  /** A soft bump (blocked road, dead end): squash, recoil and settle. */
  bump(): Promise<void> {
    return new Promise((resolve) => {
      const tl = gsap.timeline({ onComplete: resolve, onInterrupt: resolve });
      tl.to(this.rig, { x: -14 * this.art.unit, duration: 0.12, ease: 'power2.out' })
        .to(
          this.rig.scale,
          { x: this.k * this.art.unit * 1.03, y: this.k * this.art.unit * 0.96, duration: 0.1 },
          0,
        )
        .to(this.rig, { x: 0, duration: 0.35, ease: 'elastic.out(1, 0.45)' })
        .to(
          this.rig.scale,
          { x: this.k * this.art.unit, y: this.k * this.art.unit, duration: 0.3 },
          '<',
        );
    });
  }

  /** Little hop of joy on the cart (squash and stretch). */
  hop(): void {
    const s = this.k * this.art.unit;
    gsap
      .timeline()
      .to(this.rig.scale, { y: s * 0.94, x: s * 1.03, duration: 0.08 })
      .to(this.rig.scale, { y: s * 1.04, x: s * 0.98, duration: 0.12 })
      .to(this.rig.scale, { y: s, x: s, duration: 0.25, ease: 'back.out(2)' });
  }

  private update(dt: number): void {
    const u = this.art.unit;
    if (Math.abs(this.speed) > 30 && this.art.profile.particleScale > 0.2) {
      this.puffAcc += dt * Math.min(14, Math.abs(this.speed) / 40);
      while (this.puffAcc >= 1) {
        this.puffAcc -= 1;
        const g = new Graphics().circle(0, 0, 6 * u).fill({ color: 0xe8d2a8, alpha: 0.5 });
        this.seed = (this.seed * 16807) % 2147483647;
        g.position.set(-40 * u + (this.seed / 2147483647) * 30 * u, -4 * u);
        this.dust.addChild(g);
        this.puffs.push({ g, life: 0, vx: -this.speed * 0.25 - 20 * u, vy: -18 * u });
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i -= 1) {
      const p = this.puffs[i];
      if (!p) continue;
      p.life += dt;
      p.g.x += p.vx * dt;
      p.g.y += p.vy * dt;
      p.g.scale.set(1 + p.life * 2.2);
      p.g.alpha = Math.max(0, 0.5 - p.life * 0.55);
      if (p.life > 0.9) {
        p.g.destroy();
        this.puffs.splice(i, 1);
      }
    }
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    gsap.killTweensOf(this.rig);
    gsap.killTweensOf(this.rig.scale);
    this.driver.destroy();
    this.partner.destroy();
    this.cart.destroy();
    this.view.destroy({ children: true });
  }
}
