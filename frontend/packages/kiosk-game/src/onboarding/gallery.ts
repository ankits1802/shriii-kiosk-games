/**
 * Gallery previews of the onboarding screens (dev/QA). Each route runs the real screen with dev
 * services; an autoplay script taps through earlier steps to reach the state being reviewed, then hands
 * over to pointer input. `?voiceSpeed=0.05` shortens the simulated voice lines.
 */
import type { Application } from 'pixi.js';
import { type RouteDef, registerRoutes } from '../art/gallery/routes.ts';
import { AttractLoop } from '../attract/AttractLoop.ts';
import { createDevServices, TimedSilentVoice } from './harness/devServices.ts';
import type { TapScript } from './harness/inputs.ts';
import { OnboardingFlow } from './OnboardingFlow.ts';
import { ScreenAbortedError, ScreenKit } from './ScreenKit.ts';
import { runBands } from './screens/bands.ts';
import { runConsent } from './screens/consent.ts';
import { runLanguageSelect } from './screens/languageSelect.ts';
import { runPractice } from './screens/practice.ts';
import { runContactOptIn, runSurvey } from './screens/survey.ts';

function voiceSpeed(): number {
  const v =
    typeof window !== 'undefined'
      ? Number(new URLSearchParams(window.location.search).get('voiceSpeed') ?? 1)
      : 1;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

type Runner = (kit: ScreenKit) => Promise<unknown>;

function screenRoute(
  pattern: RegExp,
  run: (params: readonly string[]) => {
    runner: Runner;
    autoplay?: TapScript | null;
    speed?: number;
  },
): RouteDef {
  return {
    pattern,
    mount(app: Application, params: readonly string[]) {
      const { runner, autoplay, speed } = run(params);
      const dev = createDevServices(app, { autoplay: autoplay ?? null });
      const voice = new TimedSilentVoice(
        'en-IN',
        () => dev.services.clock.now(),
        speed ?? voiceSpeed(),
      );
      const services = dev.services.voice.isDevPlaceholder
        ? dev.services
        : { ...dev.services, voice };
      const kit = new ScreenKit(services, dev.config);
      void runner(kit).catch((e: unknown) => {
        if (!(e instanceof ScreenAbortedError) && !kit.aborted) console.error('screen failed', e);
      });
      return () => {
        kit.destroy();
        dev.dispose();
      };
    },
  };
}

/** Script: answer the first `n` band questions with the first adult option, then wait. */
function bandsScript(n: number, selectOnly = false): TapScript {
  let confirmed = 0;
  let selected = false;
  return (ids) => {
    if (confirmed >= n) {
      if (selectOnly && !selected) {
        const t = ids.find(
          (id) =>
            id.startsWith('band.') &&
            !id.endsWith('.confirm') &&
            !id.includes('under_18') &&
            !id.includes('prefer'),
        );
        if (t) {
          selected = true;
          return (
            ids.find(
              (id) =>
                id.includes('25_34') ||
                id.includes('with_difficulty') ||
                id.includes('secondary') ||
                id.includes('woman') ||
                id.includes('sometimes') ||
                id.includes('not_sure'),
            ) ?? t
          );
        }
      }
      return null;
    }
    const confirm = ids.find((id) => id.endsWith('.confirm'));
    if (confirm) {
      confirmed++;
      return confirm;
    }
    return (
      ids.find(
        (id) => id.startsWith('band.') && !id.includes('under_18') && !id.includes('prefer'),
      ) ?? null
    );
  };
}

const ROUTES: RouteDef[] = [
  {
    pattern: /^\/onboarding\/attract$/,
    mount(app) {
      const dev = createDevServices(app);
      const loop = new AttractLoop(dev.services, dev.config);
      void loop.run().catch(() => undefined);
      return () => {
        loop.destroy();
        dev.dispose();
      };
    },
  },
  screenRoute(/^\/onboarding\/language$/, () => ({ runner: (k) => runLanguageSelect(k) })),
  screenRoute(/^\/onboarding\/language-confirm$/, () => {
    let done = false;
    return {
      runner: (k) => runLanguageSelect(k),
      autoplay: (ids) => {
        if (done) return null;
        const face = ids.find((id) => id === 'lang.hi_in');
        if (face) done = true;
        return face ?? null;
      },
    };
  }),
  screenRoute(/^\/onboarding\/consent\/(\d)$/, ([seg]) => ({
    runner: (k) => runConsent(k),
    // Fast-forward earlier segments, then normal speed for the reviewed one.
    speed: Number(seg ?? 1) <= 1 ? voiceSpeed() : 0.05,
    autoplay: () => null,
  })),
  screenRoute(/^\/onboarding\/consent-question$/, () => ({
    runner: (k) => runConsent(k),
    speed: 0.03,
    autoplay: () => null,
  })),
  screenRoute(/^\/onboarding\/archive$/, () => ({
    runner: (k) => runConsent(k),
    speed: 0.03,
    autoplay: (ids) => ids.find((id) => id === 'consent.yes') ?? null,
  })),
  screenRoute(/^\/onboarding\/bands\/(\d)$/, ([q]) => ({
    runner: (k) => runBands(k),
    autoplay: bandsScript(Number(q ?? 0)),
    speed: 0.2,
  })),
  screenRoute(/^\/onboarding\/bands-selected\/(\d)$/, ([q]) => ({
    runner: (k) => runBands(k),
    autoplay: bandsScript(Number(q ?? 0), true),
    speed: 0.2,
  })),
  screenRoute(/^\/onboarding\/under18$/, () => {
    let step = 0;
    return {
      runner: (k) => runBands(k),
      speed: 1,
      autoplay: (ids) => {
        if (step === 0 && ids.includes('band.age.under_18')) {
          step = 1;
          return 'band.age.under_18';
        }
        if (step === 1 && ids.includes('band.age.confirm')) {
          step = 2;
          return 'band.age.confirm';
        }
        return null;
      },
    };
  }),
  screenRoute(/^\/onboarding\/practice\/(tap|hold|choice)$/, ([skill]) => {
    let taps = 0;
    return {
      runner: (k) => runPractice(k),
      speed: 0.15,
      autoplay: (ids) => {
        if (skill === 'tap') return null;
        const tapIds = ids.filter((id) => id.startsWith('practice.tap.'));
        if (tapIds.length && taps < 2) {
          taps++;
          return tapIds[0] ?? null;
        }
        return null;
      },
    };
  }),
  screenRoute(/^\/onboarding\/survey$/, () => ({
    runner: (k) => runSurvey(k),
    autoplay: () => null,
  })),
  screenRoute(/^\/onboarding\/optin$/, () => ({
    runner: (k) => runContactOptIn(k),
    autoplay: () => null,
  })),
  {
    pattern: /^\/onboarding\/flow$/,
    mount(app) {
      const dev = createDevServices(app);
      const flow = new OnboardingFlow(dev.services, dev.config);
      void flow.runAll().catch(() => undefined);
      return () => {
        flow.destroy();
        dev.dispose();
      };
    },
  },
];

/** Register the onboarding previews with the gallery (idempotent). */
let registered = false;
export function registerOnboardingGalleryRoutes(): void {
  if (registered) return;
  registered = true;
  registerRoutes(ROUTES, {
    title: 'Onboarding',
    prefix: '/onboarding',
    items: [
      { path: '/onboarding/attract', label: 'attract loop' },
      { path: '/onboarding/language', label: 'language faces' },
      { path: '/onboarding/language-confirm', label: 'language confirm' },
      { path: '/onboarding/consent/1', label: 'consent · segment' },
      { path: '/onboarding/consent-question', label: 'consent · question' },
      { path: '/onboarding/archive', label: 'archive opt-in' },
      ...[0, 1, 2, 3, 4, 5].map((q) => ({
        path: `/onboarding/bands/${q}`,
        label: `bands · question ${q + 1}`,
      })),
      { path: '/onboarding/bands-selected/0', label: 'bands · selected' },
      { path: '/onboarding/under18', label: 'under-18 goodbye' },
      { path: '/onboarding/practice/tap', label: 'practice · tap' },
      { path: '/onboarding/practice/hold', label: 'practice · hold' },
      { path: '/onboarding/survey', label: 'survey' },
      { path: '/onboarding/optin', label: 'contact opt-in' },
      { path: '/onboarding/flow', label: 'full flow (interactive)' },
    ],
  });
}
