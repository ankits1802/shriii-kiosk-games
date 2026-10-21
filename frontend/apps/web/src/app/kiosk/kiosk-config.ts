/**
 * Kiosk configuration for the `/kiosk` route, from build-time NEXT_PUBLIC_* values. Mirrors
 * frontend/apps/kiosk/src/config.ts (VITE_* there). Unknown values fall back to safe defaults and dev-only
 * switches are forced off in production builds.
 */
import type {
  BatteryArm,
  DevFlags,
  SessionMode,
  SiteMode,
} from '@shriii/kiosk-game/core/contracts';

const MODES: readonly SessionMode[] = ['public', 'pilot', 'think_aloud', 'retest', 'substudy'];
const SITE_MODES: readonly SiteMode[] = ['supervised', 'open_public'];

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export interface KioskEnv {
  readonly NEXT_PUBLIC_KIOSK_API_BASE?: string | undefined;
  readonly NEXT_PUBLIC_KIOSK_MODE?: string | undefined;
  readonly NEXT_PUBLIC_SITE_MODE?: string | undefined;
  readonly NEXT_PUBLIC_KIOSK_ARM?: string | undefined;
  readonly NEXT_PUBLIC_PX_PER_MM?: string | undefined;
  readonly NEXT_PUBLIC_DEV_PIN?: string | undefined;
  readonly NEXT_PUBLIC_DEV_OVERLAY?: string | undefined;
  readonly NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER?: string | undefined;
}

export interface KioskConfig {
  /** API origin for event upload; null = offline only (the outbox persists in IndexedDB). */
  readonly apiBase: string | null;
  readonly mode: SessionMode;
  readonly siteMode: SiteMode;
  readonly arm: BatteryArm | 'randomised';
  readonly pxPerMm: number | undefined;
  readonly devPin: string;
  readonly dev: DevFlags;
}

export function parseKioskConfig(env: KioskEnv, isDev: boolean): KioskConfig {
  const rawBase = (env.NEXT_PUBLIC_KIOSK_API_BASE ?? '').trim();
  const px = Number.parseFloat(env.NEXT_PUBLIC_PX_PER_MM ?? '');
  const arm =
    env.NEXT_PUBLIC_KIOSK_ARM === 'A_narrative' || env.NEXT_PUBLIC_KIOSK_ARM === 'randomised'
      ? env.NEXT_PUBLIC_KIOSK_ARM
      : 'B_fixed';
  return {
    apiBase: rawBase === '' ? null : rawBase.replace(/\/+$/, ''),
    mode: pick(env.NEXT_PUBLIC_KIOSK_MODE, MODES, 'public'),
    siteMode: pick(env.NEXT_PUBLIC_SITE_MODE, SITE_MODES, 'supervised'),
    arm,
    pxPerMm: Number.isFinite(px) && px > 0 ? px : undefined,
    devPin:
      env.NEXT_PUBLIC_DEV_PIN && /^\d{4,8}$/.test(env.NEXT_PUBLIC_DEV_PIN)
        ? env.NEXT_PUBLIC_DEV_PIN
        : '2468',
    dev: {
      overlay: isDev && env.NEXT_PUBLIC_DEV_OVERLAY === 'true',
      voicePlaceholder: isDev && env.NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER === 'true',
      headless: false,
    },
  };
}

/** `process.env.NEXT_PUBLIC_*` must be referenced literally so Next inlines them. */
export function readKioskConfig(): KioskConfig {
  return parseKioskConfig(
    {
      NEXT_PUBLIC_KIOSK_API_BASE: process.env.NEXT_PUBLIC_KIOSK_API_BASE,
      NEXT_PUBLIC_KIOSK_MODE: process.env.NEXT_PUBLIC_KIOSK_MODE,
      NEXT_PUBLIC_SITE_MODE: process.env.NEXT_PUBLIC_SITE_MODE,
      NEXT_PUBLIC_KIOSK_ARM: process.env.NEXT_PUBLIC_KIOSK_ARM,
      NEXT_PUBLIC_PX_PER_MM: process.env.NEXT_PUBLIC_PX_PER_MM,
      NEXT_PUBLIC_DEV_PIN: process.env.NEXT_PUBLIC_DEV_PIN,
      NEXT_PUBLIC_DEV_OVERLAY: process.env.NEXT_PUBLIC_DEV_OVERLAY,
      NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER: process.env.NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER,
    },
    process.env.NODE_ENV !== 'production',
  );
}
