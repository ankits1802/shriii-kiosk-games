// Visual QA for the character rig: screenshot gallery routes with Chromium and read rig timings.
// Start a gallery server first, e.g. `pnpm gallery -- --port 5299`, then:
//   node src/art/characters/dev/shoot-rig.mjs <outdir> <WxH> <route[@waitMs]> [...]
// Env: RIG_PORT (default 5199), RIG_QUERY (extra query string, e.g. "tier=medium").
// Routes are written without the leading slash (Git Bash rewrites /paths), e.g. rig/walk.
// For `rig/scene` the script also prints the per-frame CPU time of the 12-character rig.
import { chromium } from '@playwright/test';

const [outdir, size, ...routes] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const port = Number(process.env.RIG_PORT ?? 5199);
const extra = process.env.RIG_QUERY ? `&${process.env.RIG_QUERY}` : '';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
for (const r of routes) {
  const [raw, waitMs] = r.split('@');
  const route = `/${raw.replace(/^\/+/, '')}`;
  await page.goto(`http://localhost:${port}/?clean${extra}#${route}`);
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid=art-gallery]')?.getAttribute('data-status') ===
        'shown',
      null,
      { timeout: 90000 },
    )
    .catch(() => logs.push(`timeout ${route}`));
  await page.waitForTimeout(Number(waitMs ?? 800));
  const name = `${route.replace(/^\//, '').replace(/\//g, '__')}_${w}x${h}.png`;
  await page.screenshot({ path: `${outdir}/${name}`, timeout: 180000 });
  console.log('shot', name);
  if (route === '/rig/scene') {
    const perf = await page.evaluate(() => globalThis.__RIG_PERF__);
    console.log('rig perf (interleaved with software rendering)', JSON.stringify(perf));
    const bench = await page.evaluate(() => globalThis.__RIG_BENCH__?.(600));
    console.log('rig CPU per frame, 12 characters, no rendering in between (ms):', bench);
  }
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
