import { chromium } from '@playwright/test';

const [q, waitS] = process.argv.slice(2);
// Dev trace: print the event stream of a dev URL after a run (hardware GL).
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
await page.goto(`http://localhost:5311/?${q}`);
const t0 = Date.now();
while (Date.now() - t0 < Number(waitS) * 1000) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => ({
    p: globalThis.__set2?.phase,
    st: globalThis.__set2?.state,
  }));
  if (s.st === 'ended' || s.st === 'error') break;
}
const ev = await page.evaluate(async () =>
  (await globalThis.__set2.events()).map(
    (e) =>
      `${e.seq} ${e.timing.t_mono_ms.toFixed(0)} ${e.event_type} ${JSON.stringify(e.payload).slice(0, 160)}`,
  ),
);
console.log(ev.join('\n'));
const fps = await page.evaluate(
  () =>
    new Promise((r) => {
      let n = 0;
      const t = performance.now();
      const f = () => {
        n++;
        if (performance.now() - t > 1000) r(n);
        else requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    }),
);
console.log('fps', fps);
await browser.close();
