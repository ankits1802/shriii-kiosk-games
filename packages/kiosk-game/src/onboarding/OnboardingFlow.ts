/**
 * Onboarding flow: attract -> language (speaking faces) -> consent -> picture bands -> practice, with the
 * globe returning to language selection (switches after a first selection are logged as
 * `language_switched`). The session statechart (engine) calls these steps and maps the returned
 * {@link SessionMachineEvent}s onto its transitions; each step can also be run on its own.
 *
 * One {@link ScreenKit} persists across language -> practice so the fair, the guide and the music carry
 * on without cuts; cinematic light sweeps mark each step.
 */
import type { PracticeSummaryPayload } from '@shriii/contracts';
import { AttractLoop, type AttractResult } from '../attract/AttractLoop.ts';
import type { LanguageTag, SessionMachineEvent } from '../core/contracts.ts';
import { ScreenKit } from './ScreenKit.ts';
import { type BandsResult, runBands } from './screens/bands.ts';
import { type ConsentResult, runConsent } from './screens/consent.ts';
import { type LanguageSelectResult, runLanguageSelect } from './screens/languageSelect.ts';
import { runPractice } from './screens/practice.ts';
import {
  type ContactOptInResult,
  runContactOptIn,
  runSurvey,
  type SurveyResult,
} from './screens/survey.ts';
import type { OnboardingConfig, OnboardingServices } from './types.ts';

export interface OnboardingOutcome {
  readonly events: readonly SessionMachineEvent[];
  readonly language: LanguageTag | null;
  readonly practice: PracticeSummaryPayload | null;
  /** How onboarding ended: completed (ready to play), consent declined, or under age. */
  readonly ended: 'completed' | 'consent_declined' | 'under_age';
}

export class OnboardingFlow {
  private kit: ScreenKit | null = null;
  private language: LanguageTag | null = null;
  private consentGiven = false;

  constructor(
    private readonly services: OnboardingServices,
    private readonly config: OnboardingConfig,
  ) {}

  private screen(): ScreenKit {
    this.kit ??= new ScreenKit(this.services, this.config);
    return this.kit;
  }

  /** KSK-03 attract loop until the first touch. */
  async attract(): Promise<AttractResult> {
    const loop = new AttractLoop(this.services, this.config);
    try {
      return await loop.run();
    } finally {
      loop.destroy();
    }
  }

  /** ONB-01. Logs `language_switched` when this replaces an earlier choice. */
  async languageSelect(): Promise<LanguageSelectResult> {
    const kit = this.screen();
    const res = await runLanguageSelect(kit);
    if (this.language && this.language !== res.event.language) {
      kit.logger.log('language_switched', {
        from_language: this.language,
        to_language: res.event.language,
        after_consent: this.consentGiven,
      });
    }
    this.language = res.event.language;
    await this.services.voice.setLanguage(res.event.language);
    return res;
  }

  /** ONB-02 (loops through language selection when the globe is tapped). */
  async consent(): Promise<ConsentResult> {
    for (;;) {
      const r = await runConsent(this.screen());
      if ('type' in r) {
        await this.languageSelect();
        continue;
      }
      if (r.event.type === 'CONSENT_GRANTED') this.consentGiven = true;
      return r;
    }
  }

  /** ONB-04 (globe allowed; a switch after consent is logged). */
  async bands(): Promise<BandsResult> {
    for (;;) {
      const r = await runBands(this.screen());
      if ('type' in r) {
        await this.languageSelect();
        continue;
      }
      return r;
    }
  }

  /** ONB-05. */
  practice(): Promise<PracticeSummaryPayload> {
    return runPractice(this.screen());
  }

  /** ONB-07. */
  survey(): Promise<SurveyResult> {
    return runSurvey(this.screen());
  }

  /** ONB-03 (yes/no). */
  contactOptIn(): Promise<ContactOptInResult> {
    return runContactOptIn(this.screen());
  }

  /** Run attract -> practice in order (stops early on decline or under-age). */
  async runAll(): Promise<OnboardingOutcome> {
    const events: SessionMachineEvent[] = [];
    const a = await this.attract();
    events.push(a.event);
    this.services.audio.playMusic('onboarding', { fadeMs: 2000 });
    const l = await this.languageSelect();
    events.push(l.event);
    await this.services.art.lightSweep?.();
    const c = await this.consent();
    events.push(c.event);
    if (c.event.type === 'CONSENT_DECLINED')
      return { events, language: this.language, practice: null, ended: 'consent_declined' };
    await this.services.art.lightSweep?.();
    const b = await this.bands();
    events.push(b.event);
    if (b.event.type === 'UNDER_AGE')
      return { events, language: this.language, practice: null, ended: 'under_age' };
    await this.services.art.lightSweep?.();
    const p = await this.practice();
    return { events, language: this.language, practice: p, ended: 'completed' };
  }

  destroy(): void {
    this.kit?.destroy();
    this.kit = null;
  }
}
