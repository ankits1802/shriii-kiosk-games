/**
 * Kiosk device configuration: identity, site, policy versions and the version tuple stamped on every
 * event (PLT-03). Persistent values (kiosk id, kiosk seed) are created once and kept in the
 * kiosk's key/value store; in production they come from provisioning (KSK-10).
 */
import type { EventVersions, LanguageTag, SessionMode, SiteMode } from '@shriii/contracts';
import type { KeyValueStore } from '../engine/assignment.ts';
import { randomSeedHex } from '../logging/uuid.ts';

export interface KioskDeviceConfig {
  readonly kioskId: string;
  /** Persistent 64-bit hex seed for kiosk-level randomisation (slot/arm permuted blocks). */
  readonly kioskSeedHex: string;
  readonly siteId: string;
  readonly siteMode: SiteMode;
  readonly mode: SessionMode;
  /** Enabled languages (faces shown on the language screen, in seeded random order). */
  readonly languages: readonly [LanguageTag, ...LanguageTag[]];
  /** Version tuple without the parts the engine fills (`bundle_hash`, `timing_profile_version`). */
  readonly versions: Omit<EventVersions, 'bundle_hash' | 'timing_profile_version'>;
  readonly device: {
    readonly model: string;
    readonly firmware: string;
    readonly hardware_sku: string;
  };
  readonly consent: {
    readonly scriptId: string;
    /** sha256 of the consent audio actually played (resolved from the audio manifest). */
    readonly versionHash: string;
    readonly policyVersion: string;
  };
  readonly languagePack: { readonly version: string; readonly manifestHash: string };
  /** True for simulator/bot sessions (kept out of real tables). */
  readonly synthetic: boolean;
}

const ZERO_HASH = '0'.repeat(64);

/** Development defaults; persistent ids are created in `store` on first use. */
export function developmentDeviceConfig(
  store: KeyValueStore,
  overrides: Partial<KioskDeviceConfig> = {},
): KioskDeviceConfig {
  let kioskId = store.get('kiosk_id');
  if (!kioskId) {
    kioskId = `kiosk-dev-${randomSeedHex().slice(0, 8)}`;
    store.set('kiosk_id', kioskId);
  }
  let kioskSeedHex = store.get('kiosk_seed');
  if (!kioskSeedHex || !/^[0-9a-f]{16}$/.test(kioskSeedHex)) {
    kioskSeedHex = randomSeedHex();
    store.set('kiosk_seed', kioskSeedHex);
  }
  return {
    kioskId,
    kioskSeedHex,
    siteId: 'site-dev',
    siteMode: 'supervised',
    mode: 'public',
    languages: ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'],
    versions: {
      app_version: '0.1.0',
      audio_manifest_hash: null,
      variant_pack_id: null,
      scoring_dict_version: '0.1.0',
      indicator_set_version: '0.1.0',
      protocol_version: null,
      policy_version: '1.0.0',
      release_pack_version: null,
      device_profile_id: 'dev-browser',
      hardware_sku: 'dev-browser',
    },
    device: { model: 'browser', firmware: 'n/a', hardware_sku: 'dev-browser' },
    consent: { scriptId: 'consent.core.v1', versionHash: ZERO_HASH, policyVersion: '1.0.0' },
    languagePack: { version: '0.1.0', manifestHash: ZERO_HASH },
    synthetic: false,
    ...overrides,
  };
}
