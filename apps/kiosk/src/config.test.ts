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
});
