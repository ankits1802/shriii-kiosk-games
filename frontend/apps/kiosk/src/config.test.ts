import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

describe('readConfig', () => {
  it('defaults to an offline public kiosk with dev switches off in production', () => {
    const c = readConfig({ VITE_DEV_OVERLAY: 'true' } as ImportMetaEnv, false);
    expect(c).toMatchObject({
      apiBase: null,
      mode: 'public',
      siteMode: 'supervised',
      arm: 'B_fixed',
      devPin: '2468',
    });
    expect(c.dev).toEqual({ overlay: false, voicePlaceholder: false, headless: false });
  });

  it('reads the API base (with the legacy alias), modes, arm and density', () => {
    const c = readConfig(
      {
        VITE_API_BASE_URL: 'http://localhost:8000',
        VITE_KIOSK_MODE: 'pilot',
        VITE_SITE_MODE: 'open_public',
        VITE_ARM: 'randomised',
        VITE_PX_PER_MM: '4.2',
        VITE_DEV_PIN: '13579',
        VITE_DEV_OVERLAY: 'true',
      } as ImportMetaEnv,
      true,
    );
    expect(c).toMatchObject({
      apiBase: 'http://localhost:8000',
      mode: 'pilot',
      siteMode: 'open_public',
      arm: 'randomised',
      pxPerMm: 4.2,
      devPin: '13579',
    });
    expect(c.dev.overlay).toBe(true);
    expect(
      readConfig(
        { VITE_API_BASE: ' ', VITE_KIOSK_MODE: 'bogus', VITE_DEV_PIN: 'abc' } as ImportMetaEnv,
        true,
      ),
    ).toMatchObject({
      apiBase: null,
      mode: 'public',
      devPin: '2468',
    });
  });

  it('honours bridge overrides only in dev or VITE_E2E_BRIDGE builds', () => {
    const env = {
      VITE_KIOSK_ID: 'kiosk-001',
      VITE_DEVICE_TOKEN: 'tok',
    } as ImportMetaEnv;
    const prod = readConfig(env, false, '?arm=A_narrative');
    expect(prod).toMatchObject({ bridge: false, arm: 'B_fixed', kioskId: null, deviceToken: null });
    const e2e = readConfig({ ...env, VITE_E2E_BRIDGE: 'true' }, false, '?arm=A_narrative');
    expect(e2e).toMatchObject({
      bridge: true,
      arm: 'A_narrative',
      kioskId: 'kiosk-001',
      deviceToken: 'tok',
    });
  });
});
