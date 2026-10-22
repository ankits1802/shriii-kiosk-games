// Dev diagnostics: record main-thread frame stalls (> 50 ms) with the module phase they hit.
import { chromium } from '@playwright/test';

const [q, waitS] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(() => {
  const gaps = [];
  globalThis.__gaps = gaps;
  let last = 0;
  const f = (t) => {
    if (last && t - last > 50)
      gaps.push({ t: Math.round(t), gap: Math.round(t - last), phase: globalThis.__set2?.phase });
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
});
await page.goto(`http://localhost:5311/?${q}`);
const t0 = Date.now();
while (Date.now() - t0 < Number(waitS) * 1000) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => globalThis.__set2?.state);
  if (st === 'ended' || st === 'error') break;
}
const gaps = await page.evaluate(() => globalThis.__gaps);
console.log(gaps.map((g) => `${g.t} ${g.gap}ms ${g.phase}`).join('\n'));
await browser.close();
