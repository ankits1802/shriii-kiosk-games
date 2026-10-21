/**
 * Build-time kiosk configuration from VITE_* variables (compiled into the bundle). Unknown values fall
 * back to safe defaults; dev-only switches are forced off in production builds.
 */
import type { BatteryArm, DevFlags, SessionMode, SiteMode } from '@shriii/kiosk-game';

const MODES: readonly SessionMode[] = ['public', 'pilot', 'think_aloud', 'retest', 'substudy'];
const SITE_MODES: readonly SiteMode[] = ['supervised', 'open_public'];

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export interface KioskConfig {
  readonly apiBase: string | null;
  readonly mode: SessionMode;
  readonly siteMode: SiteMode;
  readonly arm: BatteryArm | 'randomised';
  readonly pxPerMm: number | undefined;
  readonly devPin: string;
  readonly dev: DevFlags;
}

export function readConfig(env: ImportMetaEnv, isDev: boolean): KioskConfig {
  const apiBase = (env.VITE_API_BASE ?? env.VITE_API_BASE_URL ?? '').trim();
  const px = Number.parseFloat(env.VITE_PX_PER_MM ?? '');
  const arm =
    env.VITE_ARM === 'A_narrative' || env.VITE_ARM === 'randomised' ? env.VITE_ARM : 'B_fixed';
  return {
    apiBase: apiBase === '' ? null : apiBase,
    mode: pick(env.VITE_KIOSK_MODE, MODES, 'public'),
    siteMode: pick(env.VITE_SITE_MODE, SITE_MODES, 'supervised'),
    arm,
    pxPerMm: Number.isFinite(px) && px > 0 ? px : undefined,
    devPin: env.VITE_DEV_PIN && /^\d{4,8}$/.test(env.VITE_DEV_PIN) ? env.VITE_DEV_PIN : '2468',
    dev: {
      overlay: isDev && env.VITE_DEV_OVERLAY === 'true',
      voicePlaceholder: isDev && env.VITE_DEV_VOICE_PLACEHOLDER === 'true',
      headless: false,
    },
  };
}
