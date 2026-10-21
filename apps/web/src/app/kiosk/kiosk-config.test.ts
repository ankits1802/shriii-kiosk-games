import { describe, expect, it } from 'vitest';
import { parseKioskConfig } from './kiosk-config';

describe('kiosk config', () => {
  it('uses safe defaults', () => {
    expect(parseKioskConfig({}, false)).toEqual({
      apiBase: null,
      mode: 'public',
      siteMode: 'supervised',
      arm: 'B_fixed',
      pxPerMm: undefined,
      devPin: '2468',
      dev: { overlay: false, voicePlaceholder: false, headless: false },
    });
  });

  it('reads valid values and rejects unknown ones', () => {
    const c = parseKioskConfig(
      {
        NEXT_PUBLIC_KIOSK_API_BASE: 'http://localhost:8000/',
        NEXT_PUBLIC_KIOSK_MODE: 'pilot',
        NEXT_PUBLIC_SITE_MODE: 'moon',
        NEXT_PUBLIC_KIOSK_ARM: 'A_narrative',
        NEXT_PUBLIC_PX_PER_MM: '4.2',
        NEXT_PUBLIC_DEV_PIN: '12',
      },
      true,
    );
    expect(c).toMatchObject({
      apiBase: 'http://localhost:8000',
      mode: 'pilot',
      siteMode: 'supervised',
      arm: 'A_narrative',
      pxPerMm: 4.2,
      devPin: '2468',
    });
  });

  it('forces dev switches off in production builds', () => {
    const env = { NEXT_PUBLIC_DEV_OVERLAY: 'true', NEXT_PUBLIC_DEV_VOICE_PLACEHOLDER: 'true' };
    expect(parseKioskConfig(env, false).dev).toEqual({
      overlay: false,
      voicePlaceholder: false,
      headless: false,
    });
    expect(parseKioskConfig(env, true).dev).toEqual({
      overlay: true,
      voicePlaceholder: true,
      headless: false,
    });
  });
});
