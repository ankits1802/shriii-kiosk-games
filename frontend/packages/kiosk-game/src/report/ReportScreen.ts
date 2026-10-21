/**
 * REP-02 report-or-thank-you screen.
 *
 * - thank_you (the default and the fail-closed path): an elegant dusk celebration (sky lanterns, a
 *   rangoli ringed with diyas, drifting petals) with the guide thanking the player and explaining what
 *   the game is about. No trait information of any kind. Logs `report.withheld` with the reason.
 * - player_report / demo: 0-5 strengths-framed pictorial cards revealed one by one with a light sweep while
 *   the allowlisted phrase for each plays; the "snapshot, not a diagnosis" badge and line always follow.
 *   Demo mode adds the spoken and printed "example" label. Optional QR (opaque retrieval token URL) and a
 *   printed one-page picture summary (paper-out or no printer falls back to the QR). Logs
 *   `report.delivered`. A privacy button hides the cards; the screen clears itself after `autoClearMs`.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { glowDisc, marigold, rgrad } from '../art/draw.ts';
import { MELA } from '../art/palettes.ts';
import { drawIcon } from '../art/ui/icons.ts';
import type { ReportModel, ReportTrait, SessionMachineEvent } from '../core/contracts.ts';
import type { ScreenKit } from '../onboarding/ScreenKit.ts';
import type { SizedButton } from '../onboarding/types.ts';
import type { MonoBitmap } from './escpos.ts';
import { type DeliveryMode, type DisplayTrait, spokenLines } from './model.ts';
import { buildPrintSummary, rasterisePrintSummary } from './print.ts';
import { drawQr, encodeQr } from './qr.ts';
import { exampleStamp, snapshotBadge, traitCard } from './traitArt.ts';

export interface ReportScreenOptions {
  /** Opaque retrieval URL for the QR (72 h - 7 day page). Null hides the QR. */
  readonly retrievalUrl?: string | null;
  /** Thermal printer hook; resolves false on paper-out/failure (falls back to QR). */
  readonly printer?: (bitmap: MonoBitmap, escpos: Uint8Array) => Promise<boolean>;
  /** Clear the screen automatically after this long (privacy, KSK-12; default 60 s). */
  readonly autoClearMs?: number;
  /** How long to wait for the player before finishing once everything is spoken (default 12 s). */
  readonly lingerMs?: number;
}

export interface ReportScreenResult {
  readonly event: Extract<SessionMachineEvent, { type: 'REPORT_DONE' }>;
  readonly deliveredModes: readonly DeliveryMode[];
}

function asDisplay(t: ReportTrait): DisplayTrait {
  return 'style' in t ? (t as DisplayTrait) : { ...t, style: 'banded' };
}

export async function runReport(
  kit: ScreenKit,
  model: ReportModel,
  options: ReportScreenOptions = {},
): Promise<ReportScreenResult> {
  const { services } = kit;
  kit.clearUi();
  kit.setScene('report', 'dusk');
  const guide = kit.ensureGuide();
  services.audio.playMusic('report', { fadeMs: 2500 });
  services.audio.setAmbience('road_evening', { fadeMs: 2500 });

  if (model.mode === 'thank_you') {
    kit.logger.log('report.withheld', {
      report_mode: 'thank_you',
      release_pack_version: null,
      reason: model.reason,
    });
    guide.setExpression('happy');
    await kit.pause(300);
    kit.ensureActive();
    await services.art.lightSweep?.(1200);
    kit.ensureActive();
    const petals = services.art.createParticles({
      kind: 'petals',
      origin: { x: kit.width / 2, y: kit.height * 0.15 },
      count: 40,
      durationMs: 4000,
    });
    kit.ui.addChild(petals.view);
    // Hero medallion: glowing disc, brass ring garlanded with marigolds, folded hands in the centre.
    const area0 = kit.contentRect();
    const R = Math.min(kit.mm(46), area0.height * 0.32);
    const heart = new Container();
    const halo = new Graphics();
    glowDisc(halo, 0, 0, R * 2.1, 0xffc46a, 0.85);
    halo.blendMode = 'add';
    const disc = new Graphics();
    disc.circle(0, 0, R).fill(
      rgrad([
        [0, 0xfff4de],
        [0.75, 0xffd89a],
        [1, 0xf2a85a],
      ]),
    );
    disc.circle(0, 0, R).stroke({ width: R * 0.07, color: MELA.brass });
    disc.circle(0, 0, R * 1.08).stroke({ width: R * 0.025, color: MELA.brassLight });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      marigold(
        disc,
        Math.cos(a) * R * 1.12,
        Math.sin(a) * R * 1.12,
        R * 0.075,
        i % 2 === 0 ? MELA.marigold : MELA.vermilion,
      );
    }
    const hands = drawIcon('namaste', R * 1.35, MELA.cream);
    hands.position.set(0, R * 0.04);
    heart.addChild(halo, disc, hands);
    heart.position.set(area0.x + area0.width / 2, area0.y + area0.height * 0.42);
    heart.alpha = 0;
    heart.scale.set(0.6);
    kit.ui.addChild(heart);
    gsap.to(heart, { alpha: 1, duration: 0.8 });
    gsap.to(heart.scale, { x: 1, y: 1, duration: 1.2, ease: 'elastic.out(1, 0.5)' });
    gsap.to(halo.scale, {
      x: 1.08,
      y: 1.08,
      duration: 1.4,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
    void services.art.glow?.(heart.x, heart.y, R * 2.4);
    void guide.play('celebrate');
    await kit.saySequence(spokenLines(model));
    kit.ensureActive();
    void guide.play('wave');
    await kit.pause(1500);
    kit.ensureActive();
    petals.destroy();
    kit.clearUi();
    return { event: { type: 'REPORT_DONE' }, deliveredModes: ['spoken', 'screen'] };
  }

  // Player report or demo.
  const area = kit.contentRect();
  kit.focusPanel();
  const traits = model.traits.map((t) => asDisplay(t));
  const n = Math.max(1, traits.length);
  const perRow = kit.portrait ? Math.min(3, n) : Math.min(5, n);
  const rows = Math.ceil(n / perRow);
  const gap = kit.mm(8);
  const cardW = Math.min(
    kit.mm(54),
    (area.width - gap * (perRow - 1) - kit.mm(10)) / perRow,
    (area.height * 0.72 - gap * (rows - 1)) / rows / 1.32,
  );
  const cards = traits.map((t, i) => {
    const c = traitCard(t, cardW);
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    c.view.position.set(
      area.x + area.width / 2 + (col - (inRow - 1) / 2) * (cardW + gap),
      area.y + kit.mm(10) + (cardW * 1.32) / 2 + row * (cardW * 1.32 + gap),
    );
    c.view.alpha = 0;
    c.view.scale.set(0.7);
    kit.ui.addChild(c.view);
    return c;
  });
  const badge = snapshotBadge(kit.mm(18));
  badge.position.set(
    area.x + area.width / 2,
    Math.min(
      kit.height - kit.mm(24),
      area.y + kit.mm(10) + rows * (cardW * 1.32 + gap) + kit.mm(14),
    ),
  );
  badge.alpha = 0;
  kit.ui.addChild(badge);
  if (model.mode === 'demo') {
    const stamp = exampleStamp(kit.mm(14));
    stamp.position.set(area.x + kit.mm(24), area.y + kit.mm(16));
    kit.ui.addChild(stamp);
  }

  const delivered = new Set<DeliveryMode>(['screen']);
  // Spoken summary: each card glows while its phrase plays.
  guide.setExpression('happy');
  void guide.play('point');
  const lines = spokenLines(model);
  const preLines = model.mode === 'demo' ? 2 : 1;
  await kit.saySequence(lines.slice(0, preLines));
  kit.ensureActive();
  delivered.add('spoken');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c) continue;
    gsap.to(c.view, { alpha: 1, duration: 0.45 });
    gsap.to(c.view.scale, { x: 1, y: 1, duration: 0.7, ease: 'back.out(1.7)' });
    gsap.to(c.glow, { alpha: 1, duration: 0.4 });
    void services.art.glow?.(c.view.x, c.view.y, cardW);
    services.audio.playSfx('chime', { volume: 0.6 });
    await kit.say(traits[i]?.phraseKey ?? 'report.intro');
    kit.ensureActive();
    gsap.to(c.glow, { alpha: 0, duration: 0.6 });
  }
  gsap.to(badge, { alpha: 1, duration: 0.6 });
  await kit.say(model.disclaimerKey);
  kit.ensureActive();

  // QR + print + privacy controls.
  const controls: SizedButton[] = [];
  const hide = kit.iconButton(
    {
      id: 'report.hide',
      iconId: 'eye_closed',
      audioKey: 'report.show_privately',
      variant: 'secondary',
      sizeMm: 22,
    },
    area.x + area.width - kit.mm(16),
    area.y + kit.mm(6),
  );
  controls.push(hide);
  let qrShown = false;
  const showQr = (): void => {
    if (qrShown || !options.retrievalUrl) return;
    qrShown = true;
    const qr = drawQr(encodeQr(options.retrievalUrl), kit.mm(40));
    const holder = new Container();
    holder.addChild(qr);
    holder.position.set(
      area.x + area.width - kit.mm(30),
      Math.min(kit.height - kit.mm(30), badge.y),
    );
    kit.ui.addChild(holder);
    delivered.add('qr');
  };
  if (options.retrievalUrl) {
    void kit.say('report.qr_offer');
    showQr();
  }
  if (options.printer) {
    const summary = buildPrintSummary(model, options.retrievalUrl ?? null);
    const raster = rasterisePrintSummary(services.app, summary);
    summary.destroy({ children: true });
    let printed = false;
    if (raster) {
      try {
        printed = await options.printer(raster.bitmap, raster.escpos);
      } catch {
        printed = false;
      }
    }
    kit.ensureActive();
    if (printed) delivered.add('printed');
    else showQr();
  }
  kit.logger.log('report.delivered', {
    report_mode: model.mode,
    release_pack_version: model.mode === 'player_report' ? model.releasePackVersion : null,
    delivery_modes: [...delivered] as [DeliveryMode, ...DeliveryMode[]],
    traits_shown_count: traits.length,
  });

  // Linger for the player; the hand icon hides the cards ("show privately"), auto-clear after the limit.
  const linger = options.lingerMs ?? 12_000;
  const autoClear = options.autoClearMs ?? 60_000;
  const deadline = services.clock.now() + Math.min(linger, autoClear);
  for (;;) {
    const remaining = deadline - services.clock.now();
    if (remaining <= 0) break;
    const r = await kit.waitTap(controls, remaining);
    kit.ensureActive();
    if (r.kind !== 'tap') break;
    services.logger.log('onlooker_reported', { context_id: 'report' });
    for (const c of cards) gsap.to(c.view, { alpha: 0, duration: 0.3 });
    break;
  }
  kit.clearUi();
  return { event: { type: 'REPORT_DONE' }, deliveredModes: [...delivered] };
}
