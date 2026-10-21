/** Onboarding (ONB-01..07): language faces, consent, picture bands, practice, survey, contact opt-in. */
export { OnboardingFlow, type OnboardingOutcome } from './OnboardingFlow.ts';
export { practiceConfigFromWarmup } from './practiceConfig.ts';
export { boundsOfButton, ScreenAbortedError, ScreenKit } from './ScreenKit.ts';
export { BAND_QUESTIONS, type BandsResult, runBands } from './screens/bands.ts';
export { CONSENT_SEGMENTS, type ConsentResult, runConsent } from './screens/consent.ts';
export { type LanguageSelectResult, langKey, runLanguageSelect } from './screens/languageSelect.ts';
export { runPractice } from './screens/practice.ts';
export {
  type ContactOptInResult,
  runContactOptIn,
  runSurvey,
  type SurveyResult,
} from './screens/survey.ts';
export {
  DEFAULT_ONBOARDING_CONFIG,
  type OnboardingArt,
  type OnboardingConfig,
  type OnboardingServices,
  type RichBackdrop,
  type RichCharacter,
  type SizedButton,
} from './types.ts';
