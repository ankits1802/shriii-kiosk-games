/**
 * ONB-04 Bands by picture: age (life-stage figures with spoken ranges), literacy, schooling, gender
 * (optional), smartphone use and "played before". Every question offers "prefer not to say" (a finger
 * on the lips). A picture is selected with one tap (its spoken label plays where one exists) and
 * committed with the tick; changes are counted.
 *
 * An under-18 selection ends the session politely and NOTHING is logged (zero persisted data); the flow
 * returns UNDER_AGE so the engine wipes. Otherwise `bands.answered` carries the answers, per-question
 * latency (from the end of the question audio to the committing tap) and the change count.
 */
import type {
  AgeBand,
  BandsAnsweredPayload,
  DeviceFamiliarity,
  EduBand,
  Gender,
  LiteracyBand,
  PlayedBefore,
} from '@shriii/contracts';
import { gsap } from 'gsap';
import { MELA } from '../../art/palettes.ts';
import type { LineId, SessionMachineEvent } from '../../core/contracts.ts';
import {
  agePictogram,
  devicePictogram,
  educationPictogram,
  genderPictogram,
  literacyPictogram,
  type Pictogram,
  playedBeforePictogram,
} from '../pictograms.ts';
import type { ScreenKit } from '../ScreenKit.ts';
import type { OnboardingArt, SizedButton, WithGlobe } from '../types.ts';

type BandKey = 'age' | 'literacy' | 'edu' | 'gender' | 'device_use' | 'played_before';
type BandValues = Omit<BandsAnsweredPayload, 'answer_latency_ms' | 'change_count'>;

interface Option {
  readonly code: string;
  readonly line: LineId | null;
  readonly picto: (art: OnboardingArt, px: number) => Pictogram;
  readonly accent?: number;
}

interface Question {
  readonly key: BandKey;
  readonly line: LineId;
  readonly options: readonly Option[];
}

const PREFER: Option = {
  code: 'prefer_not_to_say',
  line: 'bands.prefer_not_to_say',
  picto: (_a, px) => literacyPictogram('prefer_not_to_say', px),
  accent: MELA.smoke,
};

/** The six band questions in order (enums shared with norming via @shriii/contracts). */
export const BAND_QUESTIONS: readonly Question[] = [
  {
    key: 'age',
    line: 'bands.age.question',
    options: [
      ...(['under_18', '18_24', '25_34', '35_44', '45_59', '60_plus'] as const).map((b) => ({
        code: b,
        line: `bands.age.option.${b}`,
        picto: (art: OnboardingArt, px: number) => agePictogram(art, b, px),
      })),
      PREFER,
    ],
  },
  {
    key: 'literacy',
    line: 'bands.literacy.question',
    options: [
      ...(['easily', 'with_difficulty', 'not_at_all'] as const).map((b) => ({
        code: b,
        line: null,
        picto: (_a: OnboardingArt, px: number) => literacyPictogram(b, px),
      })),
      PREFER,
    ],
  },
  {
    key: 'edu',
    line: 'bands.education.question',
    options: [
      ...(['none', 'primary', 'secondary', 'higher_secondary', 'graduate_plus'] as const).map(
        (b) => ({
          code: b,
          line: null,
          picto: (_a: OnboardingArt, px: number) => educationPictogram(b, px),
        }),
      ),
      PREFER,
    ],
  },
  {
    key: 'gender',
    line: 'bands.gender.question',
    options: [
      ...(['woman', 'man', 'another'] as const).map((b) => ({
        code: b,
        line: null,
        picto: (art: OnboardingArt, px: number) => genderPictogram(art, b, px),
      })),
      PREFER,
    ],
  },
  {
    key: 'device_use',
    line: 'bands.device_use.question',
    options: [
      ...(['never', 'sometimes', 'daily'] as const).map((b) => ({
        code: b,
        line: null,
        picto: (_a: OnboardingArt, px: number) => devicePictogram(b, px),
      })),
      PREFER,
    ],
  },
  {
    key: 'played_before',
    line: 'bands.played_before.question',
    options: [
      ...(['yes', 'no', 'not_sure'] as const).map((b) => ({
        code: b,
        line: null,
        picto: (_a: OnboardingArt, px: number) => playedBeforePictogram(b, px),
      })),
      PREFER,
    ],
  },
];

export type BandsResult =
  | {
      readonly event: Extract<SessionMachineEvent, { type: 'BANDS_ANSWERED' }>;
      readonly payload: BandsAnsweredPayload;
    }
  | { readonly event: Extract<SessionMachineEvent, { type: 'UNDER_AGE' }> };

/** Run the six picture questions. */
export async function runBands(kit: ScreenKit): Promise<WithGlobe<BandsResult>> {
  const { services, config } = kit;
  kit.clearUi();
  kit.setScene('attract', 'golden_hour');
  const guide = kit.ensureGuide();
  guide.setExpression('calm');
  const area = kit.contentRect();
  const answers: Partial<Record<BandKey, string>> = {};
  const latency: Record<BandKey, number | null> = {
    age: null,
    literacy: null,
    edu: null,
    gender: null,
    device_use: null,
    played_before: null,
  };
  let changeCount = 0;

  for (const q of BAND_QUESTIONS) {
    kit.clearUi();
    kit.focusPanel();
    const globe = kit.iconButton(
      { id: 'bands.globe', iconId: 'globe', audioKey: 'onboarding.globe_hint', sizeMm: 22 },
      kit.globePos().x,
      kit.globePos().y,
    );
    const replay = kit.iconButton(
      { id: 'bands.replay', iconId: 'replay', audioKey: q.line, sizeMm: 24 },
      area.x + area.width - kit.mm(16),
      area.y + kit.mm(6),
    );
    // Grid of picture tiles.
    const n = q.options.length;
    const maxPerRow = kit.portrait ? 3 : n > 6 ? 4 : n;
    const rows = Math.ceil(n / maxPerRow);
    const gapMm = 10;
    const availW = area.width / kit.mm(1);
    const availH = area.height / kit.mm(1) - 44;
    const sizeMm = Math.max(
      26,
      Math.min(
        52,
        (availW - gapMm * (maxPerRow - 1)) / maxPerRow,
        (availH - gapMm * (rows - 1)) / rows,
      ),
    );
    const px = kit.mm(sizeMm);
    const gap = kit.mm(gapMm);
    const tiles: { option: Option; tile: SizedButton }[] = [];
    q.options.forEach((option, i) => {
      const row = Math.floor(i / maxPerRow);
      const col = i % maxPerRow;
      const inRow = Math.min(maxPerRow, n - row * maxPerRow);
      const x = area.x + area.width / 2 + (col - (inRow - 1) / 2) * (px + gap);
      const y = area.y + kit.mm(16) + px / 2 + row * (px + gap);
      const pic = option.picto(services.art, px);
      kit.adopt(pic.characters);
      const tile = kit.tile(
        `band.${q.key}.${option.code}`,
        pic.view,
        sizeMm,
        x,
        y,
        option.line ?? q.line,
        option.accent ?? MELA.saffron,
      );
      tile.view.alpha = 0;
      gsap.to(tile.view, { alpha: 1, duration: 0.3, delay: i * 0.06 * config.pacing });
      tiles.push({ option, tile });
    });
    const confirmY = Math.min(
      kit.height - kit.mm(22),
      area.y + kit.mm(16) + rows * (px + gap) + kit.mm(14),
    );
    let confirm: SizedButton | null = null;
    let selected: Option | null = null;
    let anchorMs = services.clock.now();
    void kit.say(q.line).then((r) => {
      if (r.status === 'completed') anchorMs = Math.max(anchorMs, r.endMs);
    });
    void guide.play('point');
    for (;;) {
      const targets = [...tiles.map((t) => t.tile), globe, replay, ...(confirm ? [confirm] : [])];
      const r = await kit.waitTap(targets);
      if (r.kind !== 'tap') throw new Error('bands aborted');
      const id = r.tap.targetId;
      if (id === globe.targetId) {
        services.voice.stop();
        return { type: 'GLOBE' };
      }
      if (id === replay.targetId) {
        kit.logger.log('ui.replay', { target_id: replay.targetId });
        void kit.say(q.line, { replay: true });
        continue;
      }
      if (confirm && id === confirm.targetId && selected) {
        // Latency from the end of the question audio (or from display on barge-in) to the commit.
        latency[q.key] = Math.max(0, Math.round(r.tap.tMs - anchorMs));
        services.voice.stop();
        services.audio.playSfx('confirm');
        break;
      }
      const hit = tiles.find((t) => t.tile.targetId === id);
      if (!hit) continue;
      if (selected && selected.code !== hit.option.code) changeCount++;
      selected = hit.option;
      services.audio.playSfx('tap');
      for (const t of tiles) t.tile.setSelected?.(t === hit);
      if (hit.option.line) void kit.say(hit.option.line);
      if (!confirm) {
        confirm = kit.button(
          {
            id: `band.${q.key}.confirm`,
            iconId: 'tick',
            audioKey: q.line,
            variant: 'confirm',
            sizeMm: 30,
          },
          area.x + area.width / 2,
          confirmY,
        );
      }
      confirm.pulse();
    }
    if (!selected) continue;
    if (q.key === 'age' && selected.code === 'under_18') {
      // Polite end; nothing is logged or kept (ONB-04 AC: zero persisted data).
      kit.clearUi();
      guide.setExpression('happy');
      void guide.play('wave');
      await kit.say('bands.under_18.goodbye');
      return { event: { type: 'UNDER_AGE' } };
    }
    answers[q.key] = selected.code;
    void guide.play('nod');
    await kit.pause(250);
  }

  kit.clearUi();
  const bands: BandValues = {
    age: (answers.age ?? 'prefer_not_to_say') as AgeBand,
    literacy: (answers.literacy ?? 'prefer_not_to_say') as LiteracyBand,
    edu: (answers.edu ?? 'prefer_not_to_say') as EduBand,
    gender: (answers.gender ?? 'prefer_not_to_say') as Gender,
    device_use: (answers.device_use ?? 'prefer_not_to_say') as DeviceFamiliarity,
    played_before: (answers.played_before ?? 'prefer_not_to_say') as PlayedBefore,
  };
  const payload: BandsAnsweredPayload = {
    ...bands,
    answer_latency_ms: latency,
    change_count: changeCount,
  };
  kit.logger.log('bands.answered', payload);
  return { event: { type: 'BANDS_ANSWERED', bands }, payload };
}
