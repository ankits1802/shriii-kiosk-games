/**
 * ONB-05 Practice: tap, hold and say-or-touch, taught with an animated hand.
 *
 * Each skill needs `passesRequired` passes (default 2) within `maxAttempts` (default 4). Hitting the cap
 * sets `practice_struggle` (the engine then locks L1, flagged). Timing comes from the warm-up level table
 * (`tap_window_ms`, `hold_required_ms`); nothing is hard-coded. Feedback is gentle and never punitive.
 * Emits `practice.summary` (scorable = false) with motor covariates (mean tap RT, hold accuracy).
 */
import type { PracticeSummaryPayload } from '@shriii/contracts';
import { gsap } from 'gsap';
import { Container } from 'pixi.js';
import { MELA } from '../../art/palettes.ts';
import { drawIcon } from '../../art/ui/icons.ts';
import { diyaTarget, marigoldTarget } from '../pictograms.ts';
import type { ScreenKit } from '../ScreenKit.ts';
import type { SizedButton } from '../types.ts';

type Skill = PracticeSummaryPayload['skills'][number];

/** Picture tile helper for the choice practice. */
function iconTile(
  kit: ScreenKit,
  id: string,
  icon: string,
  sizeMm: number,
  x: number,
  y: number,
): SizedButton {
  const pic = new Container();
  pic.addChild(drawIcon(icon, kit.mm(sizeMm) * 0.7, MELA.ink));
  return kit.tile(id, pic, sizeMm, x, y, 'warmup.choice');
}

export async function runPractice(kit: ScreenKit): Promise<PracticeSummaryPayload> {
  const { services, config } = kit;
  const p = config.practice;
  kit.clearUi();
  kit.setScene('attract', 'golden_hour');
  const guide = kit.ensureGuide();
  guide.setExpression('happy');
  const area = kit.contentRect();
  const rng = services.rng.stream('practice');
  await kit.say('warmup.intro');

  /* ---------------- tap ---------------- */
  const tapRts: number[] = [];
  const tap: { attempts: number; passes: number } = { attempts: 0, passes: 0 };
  void kit.say('warmup.tap');
  while (tap.passes < p.passesRequired && tap.attempts < p.maxAttempts) {
    tap.attempts++;
    const x = area.x + area.width * rng.next() * 0.6 + area.width * 0.2;
    const y = area.y + area.height * (0.35 + rng.next() * 0.35);
    const pic = marigoldTarget(kit.mm(34));
    const btn = kit.tile(
      `practice.tap.${tap.attempts}`,
      pic,
      34,
      x,
      y,
      'warmup.tap',
      MELA.marigold,
    );
    btn.view.scale.set(0.2);
    gsap.to(btn.view.scale, {
      x: 1,
      y: 1,
      duration: 0.4 * Math.max(0.01, config.pacing),
      ease: 'back.out(2)',
    });
    kit.refreshTargets();
    if (tap.attempts === 1) kit.showHint('tap', { x, y });
    const shownAt = services.clock.now();
    const r = await kit.waitTap([btn], p.tapWindowMs);
    kit.ensureActive();
    kit.hideHint();
    if (r.kind === 'tap') {
      tap.passes++;
      tapRts.push(Math.max(0, r.tap.tMs - shownAt));
      services.audio.playSfx('correct');
      const fx = services.art.createParticles({ kind: 'petals', origin: { x, y }, count: 18 });
      kit.ui.addChild(fx.view);
      setTimeout(() => fx.destroy(), 3000);
    } else {
      services.audio.playSfx('incorrect');
      void kit.say('feedback.try_again');
    }
    kit.removeButton(btn);
    await kit.pause(350);
  }

  /* ---------------- hold ---------------- */
  const hold: { attempts: number; passes: number } = { attempts: 0, passes: 0 };
  void kit.say('warmup.hold');
  const hx = area.x + area.width / 2;
  const hy = area.y + area.height * 0.5;
  const lamp = kit.tile(
    'practice.hold',
    diyaTarget(kit.mm(40)),
    40,
    hx,
    hy,
    'warmup.hold',
    MELA.terracotta,
  );
  kit.registerTarget(lamp, 'warmup.hold', 'hold');
  kit.showHint('hold', { x: hx, y: hy }, p.holdRequiredMs);
  while (hold.passes < p.passesRequired && hold.attempts < p.maxAttempts) {
    const signal = services.signal;
    const r = await services.input.waitForHold(lamp.targetId, {
      requiredMs: p.holdRequiredMs,
      windowMs: null,
      ...(signal ? { signal } : {}),
    });
    kit.ensureActive();
    if (r.kind !== 'hold') break;
    hold.attempts++;
    kit.hideHint();
    if (r.completed) {
      hold.passes++;
      services.audio.playSfx('chime');
      void services.art.glow?.(hx, hy, kit.mm(40));
    } else {
      services.audio.playSfx('incorrect');
      void kit.say('feedback.try_again');
      if (hold.attempts === 1) kit.showHint('hold', { x: hx, y: hy }, p.holdRequiredMs);
    }
    await kit.pause(300);
  }
  kit.removeButton(lamp);
  kit.hideHint();

  /* ---------------- say-or-touch (choice) ---------------- */
  const choice: { attempts: number; passes: number } = { attempts: 0, passes: 0 };
  const items = [
    { code: 'mango', icon: 'mango' },
    { code: 'banana', icon: 'banana' },
    { code: 'flower', icon: 'flower' },
  ] as const;
  while (choice.passes < p.passesRequired && choice.attempts < p.maxAttempts) {
    choice.attempts++;
    const order = rng.shuffle(items);
    const size = 36;
    const tiles = order.map((it, i) =>
      iconTile(
        kit,
        `practice.choice.${choice.attempts}.${it.code}`,
        it.icon,
        size,
        area.x + area.width / 2 + (i - 1) * (kit.mm(size) + kit.mm(12)),
        area.y + area.height * 0.5,
      ),
    );
    const mango = tiles[order.findIndex((o) => o.code === 'mango')];
    void kit.say('warmup.choice');
    if (choice.attempts === 1 && mango)
      kit.showHint('say_or_touch', { x: mango.view.x, y: mango.view.y });
    const r = await kit.waitTap(tiles, p.tapWindowMs * 2);
    kit.ensureActive();
    kit.hideHint();
    const correct = r.kind === 'tap' && r.tap.targetId === mango?.targetId;
    if (correct) {
      choice.passes++;
      mango?.setSelected?.(true);
      services.audio.playSfx('correct');
      void kit.say('feedback.well_done');
    } else {
      services.audio.playSfx('incorrect');
      void kit.say('feedback.try_again');
    }
    await kit.pause(600);
    for (const t of tiles) kit.removeButton(t);
  }

  const skills: [Skill, ...Skill[]] = [
    {
      skill: 'tap',
      attempts: tap.attempts,
      passes: tap.passes,
      completed: tap.passes >= p.passesRequired,
    },
    {
      skill: 'hold',
      attempts: hold.attempts,
      passes: hold.passes,
      completed: hold.passes >= p.passesRequired,
    },
    {
      skill: 'choice',
      attempts: choice.attempts,
      passes: choice.passes,
      completed: choice.passes >= p.passesRequired,
    },
  ];
  const summary: PracticeSummaryPayload = {
    skills,
    practice_struggle: skills.some((s) => !s.completed),
    mean_tap_rt_ms: tapRts.length
      ? Math.round(tapRts.reduce((a, b) => a + b, 0) / tapRts.length)
      : null,
    hold_accuracy: hold.attempts > 0 ? hold.passes / hold.attempts : null,
  };
  kit.ensureActive();
  kit.logger.log('practice.summary', summary, { scorable: false });
  kit.clearUi();
  guide.setExpression('happy');
  void guide.play('celebrate');
  await kit.say('warmup.done');
  return summary;
}
