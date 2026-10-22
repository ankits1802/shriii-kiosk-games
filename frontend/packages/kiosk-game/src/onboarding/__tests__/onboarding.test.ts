/**
 * Onboarding event emission (ONB-01/02/03/04/05/07, KSK-03): each screen logs exactly the contract events
 * with the right payloads, never scorable, and fails safe on decline / under-age / timeouts.
 */
import './canvasStub.ts';
import { describe, expect, it } from 'vitest';
import { AttractLoop, hourOf, inQuietHours } from '../../attract/AttractLoop.ts';
import { ScreenKit } from '../ScreenKit.ts';
import { BAND_QUESTIONS, runBands } from '../screens/bands.ts';
import { CONSENT_SEGMENTS, runConsent } from '../screens/consent.ts';
import { langKey, runLanguageSelect } from '../screens/languageSelect.ts';
import { runPractice } from '../screens/practice.ts';
import { runContactOptIn, runSurvey } from '../screens/survey.ts';
import { makeRig } from './fakes.ts';

describe('attract loop (KSK-03)', () => {
  it('starts only on a touch of the full-screen target and logs nothing', async () => {
    const rig = makeRig((ids) => (ids.includes('attract.start') ? 'attract.start' : null), {
      greetingIntervalMs: 20_000,
    });
    const loop = new AttractLoop(rig.services, rig.config);
    const res = await loop.run();
    loop.destroy();
    expect(res.event).toEqual({ type: 'TOUCH_START' });
    expect(rig.logger.events).toHaveLength(0);
  });

  it('honours quiet hours, including ranges that wrap midnight', () => {
    expect(inQuietHours(23, [22, 6])).toBe(true);
    expect(inQuietHours(5, [22, 6])).toBe(true);
    expect(inQuietHours(12, [22, 6])).toBe(false);
    expect(inQuietHours(13, [12, 14])).toBe(true);
    expect(inQuietHours(14, [12, 14])).toBe(false);
    expect(inQuietHours(3, null)).toBe(false);
    expect(hourOf('2026-10-21T07:15:00+05:30')).toBe(7);
  });
});

describe('language selection (ONB-01)', () => {
  it('logs language_selected with the seeded face order, pack version, manifest hash and taps', async () => {
    const rig = makeRig((ids) =>
      ids.includes('lang.ta_in')
        ? 'lang.ta_in'
        : ids.includes('lang.confirm')
          ? 'lang.confirm'
          : null,
    );
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runLanguageSelect(kit);
    kit.destroy();
    expect(res.event).toEqual({ type: 'LANGUAGE_SELECTED', language: 'ta-IN' });
    const ev = rig.logger.ofType('language_selected');
    expect(ev).toHaveLength(1);
    const p = ev[0]?.payload;
    expect(p?.language).toBe('ta-IN');
    expect([...(p?.face_order ?? [])].sort()).toEqual([...rig.config.languages].sort());
    expect(p?.pack_version).toBe(rig.config.packVersion);
    expect(p?.manifest_hash).toBe(rig.config.manifestHash);
    expect(p?.taps).toBe(2);
    expect(ev[0]?.scope.scorable).toBe(false);
    expect(rig.voice.played).toContain(`onboarding.language_confirm.${langKey('ta-IN')}`);
  });

  it('a cross returns to the faces and counts every tap', async () => {
    let crossed = false;
    const rig = makeRig((ids) => {
      if (ids.includes('lang.cancel') && !crossed) {
        crossed = true;
        return 'lang.cancel';
      }
      if (ids.includes('lang.confirm')) return 'lang.confirm';
      return ids.includes('lang.hi_in') ? 'lang.hi_in' : null;
    });
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runLanguageSelect(kit);
    kit.destroy();
    expect(res.event.language).toBe('hi-IN');
    expect(rig.logger.ofType('language_selected')[0]?.payload.taps).toBe(4);
  });
});

describe('consent (ONB-02)', () => {
  it('grants only by tap: consent.granted then a separate optin.archive (default no on timeout)', async () => {
    const rig = makeRig((ids) => (ids.includes('consent.yes') ? 'consent.yes' : null));
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runConsent(kit);
    kit.destroy();
    expect('event' in res && res.event).toEqual({
      type: 'CONSENT_GRANTED',
      tapConfirmed: true,
      archiveOptIn: false,
    });
    const granted = rig.logger.ofType('consent.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]?.payload).toMatchObject({
      consent_kind: 'core',
      tap_confirmed: true,
      consent_script_id: rig.config.consentScriptId,
      consent_version_hash: rig.config.consentVersionHash,
      policy_version: rig.config.policyVersion,
    });
    expect(granted[0]?.payload.replay_counts).toHaveLength(CONSENT_SEGMENTS.length);
    expect(rig.logger.ofType('optin.archive')[0]?.payload).toEqual({ granted: false });
    expect(rig.logger.ofType('consent.declined')).toHaveLength(0);
    for (const s of CONSENT_SEGMENTS.keys())
      expect(rig.voice.played).toContain(`consent.core.segment_${s + 1}`);
  });

  it('records the archive opt-in yes separately', async () => {
    const rig = makeRig((ids) =>
      ids.includes('consent.yes')
        ? 'consent.yes'
        : ids.includes('archive.yes')
          ? 'archive.yes'
          : null,
    );
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runConsent(kit);
    kit.destroy();
    expect('event' in res && res.event.type === 'CONSENT_GRANTED' && res.event.archiveOptIn).toBe(
      true,
    );
    expect(rig.logger.ofType('optin.archive')[0]?.payload.granted).toBe(true);
  });

  it('declining logs consent.declined only and thanks the player', async () => {
    const rig = makeRig((ids) => (ids.includes('consent.no') ? 'consent.no' : null));
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runConsent(kit);
    kit.destroy();
    expect('event' in res && res.event.type).toBe('CONSENT_DECLINED');
    expect(rig.logger.ofType('consent.declined')).toHaveLength(1);
    expect(rig.logger.ofType('consent.granted')).toHaveLength(0);
    expect(rig.logger.ofType('optin.archive')).toHaveLength(0);
    expect(rig.voice.played).toContain('consent.declined_thanks');
  });

  it('counts segment replays', async () => {
    let replays = 0;
    const rig = makeRig((ids) => {
      if (ids.includes('consent.replay') && !ids.includes('consent.yes') && replays < 2) {
        replays++;
        return 'consent.replay';
      }
      return ids.includes('consent.yes') ? 'consent.yes' : null;
    });
    rig.voice.delayMs = 25; // segments take time, so a replay tap can land while one plays
    const kit = new ScreenKit(rig.services, rig.config);
    await runConsent(kit);
    kit.destroy();
    const counts = rig.logger.ofType('consent.granted')[0]?.payload.replay_counts ?? [];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(rig.logger.ofType('ui.replay')).toHaveLength(2);
  });

  it('the globe leaves consent without logging consent', async () => {
    const rig = makeRig((ids) => (ids.includes('consent.globe') ? 'consent.globe' : null));
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runConsent(kit);
    kit.destroy();
    expect(res).toEqual({ type: 'GLOBE' });
    expect(rig.logger.events.filter((e) => e.type.startsWith('consent'))).toHaveLength(0);
  });
});

describe('picture bands (ONB-04)', () => {
  it('logs bands.answered with all six answers, latencies and change count', async () => {
    const answers: Record<string, string> = {
      literacy: 'with_difficulty',
      edu: 'secondary',
      gender: 'woman',
      device_use: 'daily',
      played_before: 'no',
    };
    let ageStep = 0;
    const rig = makeRig((ids) => {
      const q = BAND_QUESTIONS.find((qq) =>
        ids.some((id) => id.startsWith(`band.${qq.key}.`) && !id.endsWith('.confirm')),
      );
      if (!q) return null;
      const confirm = ids.find((id) => id === `band.${q.key}.confirm`);
      if (q.key === 'age') {
        // Select 60+, change to 25-34 (one change), then confirm.
        if (ageStep === 0) {
          ageStep = 1;
          return 'band.age.60_plus';
        }
        if (ageStep === 1) {
          ageStep = 2;
          return 'band.age.25_34';
        }
        return confirm ?? null;
      }
      return confirm ?? `band.${q.key}.${answers[q.key] ?? 'prefer_not_to_say'}`;
    });
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runBands(kit);
    kit.destroy();
    expect('event' in res && res.event.type).toBe('BANDS_ANSWERED');
    const ev = rig.logger.ofType('bands.answered');
    expect(ev).toHaveLength(1);
    const p = ev[0]?.payload;
    expect(p).toMatchObject({
      age: '25_34',
      literacy: 'with_difficulty',
      edu: 'secondary',
      gender: 'woman',
      device_use: 'daily',
      played_before: 'no',
    });
    expect(p?.change_count).toBe(1);
    for (const k of ['age', 'literacy', 'edu', 'gender', 'device_use', 'played_before'] as const) {
      expect(p?.answer_latency_ms[k]).not.toBeNull();
      expect(p?.answer_latency_ms[k]).toBeGreaterThanOrEqual(0);
    }
    expect(ev[0]?.scope.scorable).toBe(false);
  });

  it('under-18 ends politely and persists nothing', async () => {
    const rig = makeRig((ids) =>
      ids.includes('band.age.confirm')
        ? 'band.age.confirm'
        : ids.includes('band.age.under_18')
          ? 'band.age.under_18'
          : null,
    );
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runBands(kit);
    kit.destroy();
    expect('event' in res && res.event).toEqual({ type: 'UNDER_AGE' });
    expect(rig.logger.events.filter((e) => e.type !== 'ui.replay')).toHaveLength(0);
    expect(rig.voice.played).toContain('bands.under_18.goodbye');
  });

  it('every question offers prefer-not-to-say', () => {
    for (const q of BAND_QUESTIONS)
      expect(q.options.some((o) => o.code === 'prefer_not_to_say')).toBe(true);
  });
});

describe('practice (ONB-05)', () => {
  it('logs a non-scorable practice.summary with passes per skill', async () => {
    const rig = makeRig(
      (ids) =>
        ids.find((id) => id.startsWith('practice.tap.')) ??
        ids.find((id) => id.endsWith('.mango')) ??
        null,
      {
        practice: { tapWindowMs: 200, holdRequiredMs: 50, passesRequired: 2, maxAttempts: 4 },
      },
    );
    const kit = new ScreenKit(rig.services, rig.config);
    const summary = await runPractice(kit);
    kit.destroy();
    expect(summary.practice_struggle).toBe(false);
    expect(summary.skills.map((s) => [s.skill, s.passes, s.completed])).toEqual([
      ['tap', 2, true],
      ['hold', 2, true],
      ['choice', 2, true],
    ]);
    const ev = rig.logger.ofType('practice.summary');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.scope.scorable).toBe(false);
    expect(ev[0]?.options.scorable).toBe(false);
  });

  it('hitting the attempt cap sets practice_struggle', async () => {
    const rig = makeRig((ids) => ids.find((id) => id.endsWith('.banana')) ?? null, {
      practice: { tapWindowMs: 5, holdRequiredMs: 50, passesRequired: 2, maxAttempts: 3 },
    });
    rig.input.holdOutcome = () => 10; // releases too early
    const kit = new ScreenKit(rig.services, rig.config);
    const summary = await runPractice(kit);
    kit.destroy();
    expect(summary.practice_struggle).toBe(true);
    expect(summary.skills.every((s) => s.attempts <= 3)).toBe(true);
    expect(summary.skills.find((s) => s.skill === 'tap')?.passes).toBe(0);
  });
});

describe('survey and contact opt-in (ONB-07, ONB-03)', () => {
  it('logs survey.enjoy and survey.play_again', async () => {
    const rig = makeRig((ids) =>
      ids.includes('survey.enjoy.happy')
        ? 'survey.enjoy.happy'
        : ids.includes('survey.again.yes')
          ? 'survey.again.yes'
          : null,
    );
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runSurvey(kit);
    kit.destroy();
    expect(res).toMatchObject({ enjoy: 'happy', playAgain: 'yes' });
    expect(rig.logger.ofType('survey.enjoy')[0]?.payload).toEqual({ face: 'happy' });
    expect(rig.logger.ofType('survey.play_again')[0]?.payload).toEqual({ answer: 'yes' });
  });

  it('timeouts count as skipped', async () => {
    const rig = makeRig(() => null);
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runSurvey(kit);
    kit.destroy();
    expect(res).toMatchObject({ enjoy: 'skipped', playAgain: 'skipped' });
  });

  it('contact opt-in timeout counts as no and logs a boolean only', async () => {
    const rig = makeRig(() => null);
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runContactOptIn(kit);
    kit.destroy();
    expect(res.event).toEqual({ type: 'OPTIN_DONE', contactOptIn: false });
    expect(rig.logger.ofType('optin.contact')[0]?.payload).toEqual({ granted: false });
  });
});

describe('scoping', () => {
  it('every onboarding event is session-level and never scorable', async () => {
    const rig = makeRig((ids) => (ids.includes('consent.yes') ? 'consent.yes' : null));
    const kit = new ScreenKit(rig.services, rig.config);
    await runConsent(kit);
    kit.destroy();
    for (const e of rig.logger.events) {
      expect(e.scope.scorable).toBe(false);
      expect(e.scope.task).toBeNull();
    }
  });
});
