/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL for event upload (POST {base}/api/v1/events/batch). Empty = offline only. */
  readonly VITE_API_BASE?: string;
  /** Legacy alias of VITE_API_BASE. */
  readonly VITE_API_BASE_URL?: string;
  /** Dev-only Web Speech placeholder voice ("DEV VOICE" banner); never honoured in production builds. */
  readonly VITE_DEV_VOICE_PLACEHOLDER?: string;
  /** Dev-only debug overlay (seed, trial, condition, frame timing). */
  readonly VITE_DEV_OVERLAY?: string;
  /** Dev panel PIN (dev builds only; default 2468). */
  readonly VITE_DEV_PIN?: string;
  /** Stage px per mm of glass for this SKU (default 96 dpi CSS reference). */
  readonly VITE_PX_PER_MM?: string;
  /** Session mode: public | pilot | think_aloud | retest | substudy (default public). */
  readonly VITE_KIOSK_MODE?: string;
  /** Site mode: supervised | open_public (default supervised). */
  readonly VITE_SITE_MODE?: string;
  /** Battery arm: B_fixed | A_narrative | randomised (default B_fixed). */
  readonly VITE_ARM?: string;
  /** Test bridge in a non-dev build (CI bot playthroughs only): see KioskConfig.bridge. */
  readonly VITE_E2E_BRIDGE?: string;
  /** Kiosk id (bridge builds only). */
  readonly VITE_KIOSK_ID?: string;
  /** Kiosk device token for event upload (bridge builds only). */
  readonly VITE_DEVICE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Minimal typed bridge exposed by the Electron preload (absent in the browser build). */
interface Window {
  readonly shriiiKiosk?: {
    readonly platform: 'electron';
    getAppVersion(): Promise<string>;
    relaunchToAttract(): void;
    onPowerEvent(listener: (event: 'suspend' | 'resume') => void): () => void;
  };
}
