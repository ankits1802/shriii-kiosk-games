/**
 * Builds the {@link OnboardingConfig} for a session from the signed packs: languages, language-pack
 * and consent versions from the device config, and the practice rules (ONB-05) from the warm-up game
 * config via `practiceConfigFromWarmup` — never hand-copied numbers.
 */
import type { CalibrationLevel, Pathway } from '@shriii/contracts';
import type { GameContent } from '../engine/content.ts';
import { isModuleId } from '../engine/content.ts';
import { practiceConfigFromWarmup } from '../onboarding/practiceConfig.ts';
import { DEFAULT_ONBOARDING_CONFIG, type OnboardingConfig } from '../onboarding/types.ts';
import type { KioskDeviceConfig } from './device.ts';

export interface OnboardingConfigOptions {
  /** Pathway whose warm-up drives practice (both pathways share `warmup` in the pilot plan). */
  readonly pathway?: Pathway;
  /** Warm-up level whose timing table practice uses (the warm-up runs before calibration: L2). */
  readonly level?: CalibrationLevel;
  /** UX overrides (pacing, greeting cadence, timeouts). Practice cannot be overridden here. */
  readonly overrides?: Partial<Omit<OnboardingConfig, 'practice'>>;
}

/**
 * The onboarding config for this kiosk and content bundle.
 * @throws Error when the warm-up config lacks the timing or practice blocks practice needs.
 */
export function onboardingConfigFor(
  device: KioskDeviceConfig,
  content: GameContent,
  options: OnboardingConfigOptions = {},
): OnboardingConfig {
  const warmupId = content.plan.pathways[options.pathway ?? 'B'].warmup;
  if (!isModuleId(warmupId) || !content.has(warmupId)) {
    throw new Error(`session plan warm-up '${warmupId}' has no config in the content bundle`);
  }
  const practice = practiceConfigFromWarmup(content.get(warmupId), options.level ?? 'L2');
  return {
    ...DEFAULT_ONBOARDING_CONFIG,
    languages: device.languages,
    packVersion: device.languagePack.version,
    manifestHash: device.languagePack.manifestHash,
    consentScriptId: device.consent.scriptId,
    consentVersionHash: device.consent.versionHash,
    policyVersion: device.consent.policyVersion,
    ...options.overrides,
    practice,
  };
}
