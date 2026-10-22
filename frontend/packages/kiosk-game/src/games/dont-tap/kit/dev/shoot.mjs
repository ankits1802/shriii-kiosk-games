// Visual QA for the set-1 micro-games: run a module with the scripted bot in Chromium and screenshot
// named phases. The dev server must be running:
//   npx vite --config src/games/dont-tap/kit/dev/vite.config.ts
// Usage:
//   node src/games/dont-tap/kit/dev/shoot.mjs <outdir> <WxH> <module> <shot> [<shot> ...] [--q=extra&query]
// A shot is `<name>=<phase>[#<n>][~<stim>][@<ms>]`: wait until body[data-game-phase] == phase (and,
// with #n, until n trials of that phase have started; with ~stim, until body[data-game-stim] == stim),
// wait <ms>, save <outdir>/<module>__<name>_<WxH>.png.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const FLAT_BYTES = 700_000;
const extra = args.find((a) => a.startsWith('--q='))?.slice(4) ?? '';
const [outdir, size, moduleId, ...shots] = args.filter((a) => !a.startsWith('--q='));
const [w, h] = size.split('x').map(Number);
mkdirSync(outdir, { recursive: true });
// Hardware GPU through ANGLE/D3D11 by default (SwiftShader software rendering manages only a few
// frames per second at 1080p); SHOOT_GL=swiftshader forces the software path.
const gl =
  process.env.SHOOT_GL === 'swiftshader'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({
  args: [...gl, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
const url = `http://localhost:5310/?module=${moduleId}&level=L2&lang=en-IN&seed=123&bot=1${extra ? `&${extra}` : ''}`;
await page.goto(url);
for (const spec of shots) {
  const [name, rest] = spec.split('=');
  const [phasePart, ms] = rest.split('@');
  const [phaseNth, stim] = phasePart.split('~');
  const [phase, nth] = phaseNth.split('#');
  const want = Number(nth ?? 0);
  const ok = await page
    .waitForFunction(
      ([p, n, st]) => {
        const b = document.body.dataset;
        if (b.harnessResult) return 'ended';
        if (b.gamePhase !== p) return false;
        if (st && b.gameStim !== st) return false;
        if (n === 0) return true;
        const g = globalThis.__shriiiGame;
        globalThis.__shotSeen ??= {};
        const key = `${p}`;
        globalThis.__shotSeen[key] ??= new Set();
        const seen = globalThis.__shotSeen[key];
        if (g && g.trialIndex !== null) seen.add(g.trialIndex);
        return seen.size >= n;
      },
      [phase, want, stim ?? ''],
      { timeout: 180000, polling: 50 },
    )
    .catch(() => null);
  if (!ok || ok === 'ended') {
    logs.push(ok ? `module ended before ${phasePart}` : `timeout waiting for ${phasePart}`);
    continue;
  }
  await page.waitForTimeout(Number(ms ?? 300));
  const file = `${outdir}/${moduleId}__${name}_${w}x${h}.png`;
  try {
    // Render one complete frame synchronously with the ticker paused, so the capture never catches
    // a half-drawn software-rendered frame; the game clock keeps running.
    await page.evaluate(() => {
      const app = globalThis.__shriiiHarness?.app;
      app?.ticker.stop();
      app?.render();
    });
    let buf = await page.screenshot({ path: file, timeout: 90000 });
    await page.evaluate(() => globalThis.__shriiiHarness?.app?.ticker.start());
    // A flat single-colour frame (~260 kB) means the GPU canvas went bad (seen under heavy GPU load):
    // retry once with the live ticker, then report it so the caller can re-run that shot fresh.
    if (buf.length < FLAT_BYTES) {
      const lost = await page.evaluate(
        () => globalThis.__shriiiHarness?.app?.renderer?.gl?.isContextLost?.() ?? null,
      );
      await page.waitForTimeout(400);
      buf = await page.screenshot({ path: file, timeout: 90000 });
      if (buf.length < FLAT_BYTES) {
        logs.push(`flat frame ${name} (contextLost=${lost})`);
        console.log('flat', file);
        continue;
      }
    }
    console.log('shot', file);
  } catch (e) {
    logs.push(`screenshot failed ${name}: ${String(e).split(/\r?\n/)[0]}`);
  }
}
const unique = [...new Set(logs.map((l) => l.split('\n').slice(0, 4).join(' | ')))];
console.log(unique.slice(0, 40).join('\n'));
await browser.close();
