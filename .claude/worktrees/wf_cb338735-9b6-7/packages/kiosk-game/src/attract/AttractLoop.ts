/**
 * Attract loop (KSK-03): the mela at golden hour breathing on its own: drifting clouds and petals, the
 * giant wheel turning, bunting fluttering, a slow cinematic camera drift, and the guide with her lantern
 * waving now and then. A soft "touch here" glow pulses at the centre (pictorial, no text).
 *
 * - Greetings rotate through enabled languages, at most one per `greetingIntervalMs` (default 20 s),
 *   and never during quiet hours (local wall time).
 * - The microphone is never opened here (PRV-03): this screen has no speech-input dependency at all.
 * - A session starts only by touch: the whole screen is one large target. The first touch unlocks audio
 *   and resolves with `TOUCH_START` (target: onboarding within 300 ms).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { rgrad } from '../art/draw.ts';
import { MELA } from '../art/palettes.ts';
import { drawPointerHand } from '../art/ui/buttons.ts';
import type { LanguageTag, SessionMachineEvent } from '../core/contracts.ts';
import { ScreenAbortedError, ScreenKit } from '../onboarding/ScreenKit.ts';
import type { OnboardingConfig, OnboardingServices, SizedButton } from '../onboarding/types.ts';

/** True when `hour` (0-23) is inside [start, end) (wrapping past midnight). */
export function inQuietHours(hour: number, quiet: readonly [number, number] | null): boolean {
  if (!quiet) return false;
  const [s, e] = quiet;
  return s <= e ? hour >= s && hour < e : hour >= s || hour < e;
}

/** Local hour from an ISO-8601 wall-time string with offset (informational clock). */
export function hourOf(isoWallTime: string): number {
  const m = /T(\d{2}):/.exec(isoWallTime);
  return m ? Number(m[1]) : 12;
}

/** Full-screen invisible target the input service can hit-test. */
class StartTarget implements SizedButton {
  readonly view = new Container();
  readonly targetId = 'attract.start';
  constructor(readonly sizePx: number) {}
  setEnabled(): void {}
  pulse(): void {}
  destroy(): void {
    this.view.destroy();
  }
}

export interface AttractResult {
  readonly event: Extract<SessionMachineEvent, { type: 'TOUCH_START' }>;
  /** Session time of the starting touch. */
  readonly touchMs: number;
  /** Greetings spoken during this attract cycle (language, session ms). */
  readonly greetings: readonly { readonly language: LanguageTag; readonly atMs: number }[];
}

export class AttractLoop {
  private readonly kit: ScreenKit;
  private readonly glowLayer = new Container();
  private alive = true;
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  private waveTimer: ReturnType<typeof setInterval> | null = null;
  private langIndex = 0;
  private readonly greetings: { language: LanguageTag; atMs: number }[] = [];
  private lastGreetingMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly services: OnboardingServices,
    private readonly config: OnboardingConfig,
  ) {
    this.kit = new ScreenKit(services, config);
  }

  /** Run until the first touch. */
  async run(): Promise<AttractResult> {
    const { kit, services } = this;
    const backdrop = kit.setScene('attract', 'golden_hour');
    const guide = kit.ensureGuide();
    services.audio.playMusic('attract', { fadeMs: 2500 });
    services.audio.setAmbience('market_day', { fadeMs: 2500 });
    this.buildTouchGlow();
    // Cinematic idle: slow drift across the fair.
    void (async () => {
      let dir = 1;
      while (this.alive && backdrop.panTo) {
        const t0 = services.clock.now();
        await backdrop.panTo(0.7 * dir, 14000);
        dir = -dir;
        // Reduced motion (or no camera support) resolves instantly: no drift, and never spin.
        if (services.clock.now() - t0 < 500) break;
      }
    })();
    this.waveTimer = setInterval(() => {
      if (this.alive) void guide.play('wave');
    }, 9000);
    void guide.play('wave');
    this.scheduleGreeting(1500);

    const target = new StartTarget(Math.max(kit.width, kit.height));
    target.view.position.set(kit.width / 2, kit.height / 2);
    kit.ui.addChild(target.view);
    kit.registerTarget(target, 'attract.touch_to_start');
    const res = await kit.waitTap([target]);
    // Only a real touch starts a session; an abort (shutdown, teardown) never does.
    if (res.kind !== 'tap') throw new ScreenAbortedError();
    const touchMs = res.tap.tMs;
    this.alive = false;
    this.stopTimers();
    services.voice.stop();
    await services.audio.unlock();
    services.audio.playSfx('chime');
    void guide.play('celebrate');
    return { event: { type: 'TOUCH_START' }, touchMs, greetings: [...this.greetings] };
  }

  private buildTouchGlow(): void {
    const kit = this.kit;
    const cx = kit.width / 2;
    const cy = kit.portrait ? kit.height * 0.72 : kit.height * 0.74;
    const r = kit.mm(28);
    const halo = new Graphics();
    halo.circle(0, 0, r * 1.6).fill(
      rgrad([
        [0, '#fff2b0cc'],
        [0.5, '#ffd27a55'],
        [1, '#ffd27a00'],
      ]),
    );
    halo.blendMode = 'add';
    const rings: Graphics[] = [];
    for (let i = 0; i < 3; i++) {
      const ring = new Graphics();
      ring.circle(0, 0, r).stroke({ width: r * 0.08, color: MELA.cream });
      ring.alpha = 0;
      rings.push(ring);
    }
    const hand = drawPointerHand(r * 1.1);
    hand.position.set(r * 0.05, -r * 0.05);
    this.glowLayer.addChild(halo, ...rings, hand);
    this.glowLayer.position.set(cx, cy);
    kit.ui.addChild(this.glowLayer);
    // Slow pulse (0.8 Hz) and expanding ripples: inviting, never flashing.
    gsap.to(halo.scale, {
      x: 1.15,
      y: 1.15,
      duration: 0.65,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
    gsap.to(hand, {
      y: hand.y + r * 0.12,
      duration: 0.65,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
    rings.forEach((ring, i) => {
      gsap.fromTo(
        ring.scale,
        { x: 0.6, y: 0.6 },
        { x: 1.7, y: 1.7, duration: 2.4, repeat: -1, delay: i * 0.8, ease: 'sine.out' },
      );
      gsap.fromTo(
        ring,
        { alpha: 0.8 },
        { alpha: 0, duration: 2.4, repeat: -1, delay: i * 0.8, ease: 'sine.out' },
      );
    });
  }

  private scheduleGreeting(delayMs: number): void {
    if (!this.alive) return;
    this.greetTimer = setTimeout(() => void this.greet(), Math.max(0, delayMs));
  }

  private async greet(): Promise<void> {
    if (!this.alive) return;
    const { services, config } = this;
    const now = services.clock.now();
    const sinceLast = now - this.lastGreetingMs;
    if (sinceLast < config.greetingIntervalMs) {
      this.scheduleGreeting(config.greetingIntervalMs - sinceLast);
      return;
    }
    if (
      inQuietHours(hourOf(services.clock.wallTime()), config.quietHours) ||
      config.languages.length === 0
    ) {
      this.scheduleGreeting(config.greetingIntervalMs);
      return;
    }
    const lang = config.languages[this.langIndex % config.languages.length] ?? config.languages[0];
    this.langIndex++;
    if (!lang) return;
    this.lastGreetingMs = now;
    this.greetings.push({ language: lang, atMs: now });
    await services.voice.setLanguage(lang);
    if (!this.alive) return;
    void this.kit.guide?.play('wave');
    await this.kit.say('attract.greeting');
    this.scheduleGreeting(config.greetingIntervalMs);
  }

  private stopTimers(): void {
    if (this.greetTimer) clearTimeout(this.greetTimer);
    if (this.waveTimer) clearInterval(this.waveTimer);
    this.greetTimer = null;
    this.waveTimer = null;
  }

  /** The screen kit (the flow hands the stage to language selection without a cut). */
  get screen(): ScreenKit {
    return this.kit;
  }

  destroy(): void {
    this.alive = false;
    this.stopTimers();
    gsap.killTweensOf(this.glowLayer.children);
    for (const c of this.glowLayer.children) gsap.killTweensOf(c.scale);
    this.kit.destroy();
  }
}
