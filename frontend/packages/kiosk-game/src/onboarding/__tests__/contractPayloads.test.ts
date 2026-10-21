/**
 * Every event the onboarding and report screens emit must pass the canonical event-envelope schema and
 * the kiosk semantic invariants. The engine's session logger replaces an invalid event with an `invalid`
 * placeholder, so a malformed payload here (e.g. consent.granted) would silently lose the record.
 */
import './canvasStub.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEventInvariants, type EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { describe, expect, it } from 'vitest';
import {
  buildDemoReportModel,
  buildPlayerReportModel,
  EXAMPLE_DEMO_PROFILE,
} from '../../report/model.ts';
import { runReport } from '../../report/ReportScreen.ts';
import { NO_PACK } from '../../report/releasePack.ts';
import type { RecordedEvent } from '../harness/basics.ts';
import { ScreenKit } from '../ScreenKit.ts';
import { BAND_QUESTIONS, runBands } from '../screens/bands.ts';
import { runConsent } from '../screens/consent.ts';
import { runLanguageSelect } from '../screens/languageSelect.ts';
import { runPractice } from '../screens/practice.ts';
import { runContactOptIn, runSurvey } from '../screens/survey.ts';
import { makeRig, type TestRig } from './fakes.ts';

const TEMPLATE = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../contracts/fixtures/valid/event-envelope/consent_declined.json'),
    'utf8',
  ),
) as EventEnvelope;

function problems(events: readonly RecordedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const envelope = {
      ...TEMPLATE,
      event_type: e.type,
      seq: e.seq,
      timing: { ...TEMPLATE.timing, t_mono_ms: e.tMonoMs, scorable: false },
      payload: e.payload,
    } as unknown as EventEnvelope;
    if (!validateEventEnvelope(envelope)) {
      const err = validateEventEnvelope.errors?.[0];
      out.push(`${e.type}: ${err?.instancePath ?? ''} ${err?.message ?? 'invalid'}`);
      continue;
    }
    for (const v of checkEventInvariants(envelope, 'kiosk'))
      out.push(`${e.type}: ${v.path} ${v.message}`);
  }
  return out;
}

async function run(rig: TestRig, screen: (kit: ScreenKit) => Promise<unknown>): Promise<void> {
  const kit = new ScreenKit(rig.services, rig.config);
  await screen(kit);
  kit.destroy();
}

describe('onboarding and report events satisfy the event-envelope contract', () => {
  it('language selection', async () => {
    const rig = makeRig((ids) =>
      ids.includes('lang.hi-IN')
        ? 'lang.hi-IN'
        : ids.includes('lang.confirm')
          ? 'lang.confirm'
          : null,
    );
    await run(rig, runLanguageSelect);
    expect(rig.logger.events.length).toBeGreaterThan(0);
    expect(problems(rig.logger.events)).toEqual([]);
  });

  it('consent granted (with replays) and declined', async () => {
    let replays = 0;
    const grant = makeRig((ids) => {
      if (ids.includes('consent.replay') && !ids.includes('consent.yes') && replays < 1) {
        replays++;
        return 'consent.replay';
      }
      return ids.includes('consent.yes')
        ? 'consent.yes'
        : ids.includes('archive.yes')
          ? 'archive.yes'
          : null;
    });
    grant.voice.delayMs = 25;
    await run(grant, runConsent);
    expect(grant.logger.ofType('consent.granted')).toHaveLength(1);
    expect(problems(grant.logger.events)).toEqual([]);

    const decline = makeRig((ids) => (ids.includes('consent.no') ? 'consent.no' : null));
    await run(decline, runConsent);
    expect(problems(decline.logger.events)).toEqual([]);
  });

  it('bands, practice, survey and contact opt-in', async () => {
    const bands = makeRig((ids) => {
      const q = BAND_QUESTIONS.find((qq) => ids.some((id) => id.startsWith(`band.${qq.key}.`)));
      if (!q) return null;
      return ids.includes(`band.${q.key}.confirm`)
        ? `band.${q.key}.confirm`
        : q.key === 'age'
          ? 'band.age.35_44'
          : `band.${q.key}.prefer_not_to_say`;
    });
    await run(bands, runBands);
    expect(bands.logger.ofType('bands.answered')).toHaveLength(1);
    expect(problems(bands.logger.events)).toEqual([]);

    const practice = makeRig(
      (ids) =>
        ids.find((id) => id.startsWith('practice.tap.')) ??
        ids.find((id) => id.endsWith('.mango')) ??
        null,
      { practice: { tapWindowMs: 200, holdRequiredMs: 50, passesRequired: 2, maxAttempts: 4 } },
    );
    await run(practice, runPractice);
    expect(practice.logger.ofType('practice.summary')).toHaveLength(1);
    expect(problems(practice.logger.events)).toEqual([]);

    const survey = makeRig((ids) =>
      ids.includes('survey.enjoy.neutral')
        ? 'survey.enjoy.neutral'
        : ids.includes('survey.again.no')
          ? 'survey.again.no'
          : ids.includes('optin.contact.yes')
            ? 'optin.contact.yes'
            : null,
    );
    await run(survey, async (kit) => {
      await runSurvey(kit);
      await runContactOptIn(kit);
    });
    expect(problems(survey.logger.events)).toEqual([]);

    const skipped = makeRig(() => null);
    await run(skipped, async (kit) => {
      await runSurvey(kit);
      await runContactOptIn(kit);
    });
    expect(problems(skipped.logger.events)).toEqual([]);
  });

  it('report thank-you and demo', async () => {
    const rig = makeRig(() => null);
    await run(rig, async (kit) => {
      await runReport(
        kit,
        buildPlayerReportModel({
          language: 'hi-IN',
          pathway: 'B',
          siteMode: 'supervised',
          policyMode: 'player_report',
          sessionValidForReport: true,
          packReader: NO_PACK,
          bandFor: () => 'unavailable',
        }),
        { lingerMs: 10 },
      );
      await runReport(kit, buildDemoReportModel(EXAMPLE_DEMO_PROFILE, 'hi-IN'), {
        lingerMs: 10,
        retrievalUrl: 'https://r.example/t/abc',
      });
    });
    expect(rig.logger.events.length).toBeGreaterThanOrEqual(2);
    expect(problems(rig.logger.events)).toEqual([]);
  });
});

describe('practice config comes from the warm-up game config (ONB-05)', () => {
  it('reads tap window, hold threshold, passes and attempt cap from warmup.json', async () => {
    const { practiceConfigFromWarmup } = await import('../practiceConfig.ts');
    const warmup = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../content/games/shared/warmup.json'), 'utf8'),
    );
    const p = practiceConfigFromWarmup(warmup, 'L2');
    expect(p.tapWindowMs).toBe(warmup.levels.L2.timing.tap_window_ms);
    expect(p.holdRequiredMs).toBe(warmup.levels.L2.timing.hold_required_ms);
    // ONB-05: two passes per skill, capped at four attempts.
    expect(p.passesRequired).toBe(2);
    expect(p.maxAttempts).toBe(4);
  });
});
