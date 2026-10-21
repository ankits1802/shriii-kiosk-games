// @vitest-environment node
/**
 * The dev placeholder voice must be compiled out of production builds (BUILD_DECISIONS: no runtime TTS
 * in production). This test runs real Vite builds of the voice service with
 * VITE_DEV_VOICE_PLACEHOLDER=true:
 * - production mode: no speech-synthesis code, no "DEV VOICE" badge, no reference text, no placeholder chunk;
 * - development mode (positive control): the placeholder is present, proving the probe can see it.
 */
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('./VoiceService.ts', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

async function bundle(mode: 'production' | 'development'): Promise<string> {
  const out = await build({
    root,
    mode,
    configFile: false,
    logLevel: 'silent',
    envDir: false,
    define: { 'import.meta.env.VITE_DEV_VOICE_PLACEHOLDER': JSON.stringify('true') },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: 'voice' },
      rollupOptions: { external: [/^@shriii\//] },
    },
  });
  const results = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  return results
    .flatMap((r) => r.output)
    .map((o) => (o.type === 'chunk' ? `/*chunk:${o.fileName}*/\n${o.code}` : ''))
    .join('\n');
}

describe('dev voice placeholder stripping', () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.NODE_ENV;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  });

  it('is absent from a production build even with VITE_DEV_VOICE_PLACEHOLDER=true', async () => {
    process.env.NODE_ENV = 'production';
    const code = await bundle('production');
    expect(code).toContain('ManifestVoiceService');
    expect(code).not.toMatch(/speechSynthesis/);
    expect(code).not.toMatch(/SpeechSynthesisUtterance/);
    expect(code).not.toContain('DEV VOICE');
    expect(code).not.toContain('Touch the screen to begin.');
    expect(code).not.toMatch(/chunk:[^*]*devPlaceholder/);
  }, 60_000);

  it('is present in a development build (positive control)', async () => {
    process.env.NODE_ENV = 'development';
    const code = await bundle('development');
    expect(code).toMatch(/speechSynthesis/);
    expect(code).toContain('DEV VOICE');
  }, 60_000);
});
