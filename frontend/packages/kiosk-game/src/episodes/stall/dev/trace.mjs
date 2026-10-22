// Dev QA: trace the episode's debug state transitions in a real browser.
//   node src/episodes/stall/dev/trace.mjs [extra query e.g. start=probe] [timeoutMs]
import { chromium } from '@playwright/test';

const [extra = '', timeout = '240000'] = process.argv.slice(2);
const port = Number(process.env.STALL_PORT ?? 5347);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.stack ?? e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[error]', m.text().slice(0, 400));
});
await page.goto(
  `http://localhost:${port}/?seed=123&level=L2&lang=en-IN&autoplay=1&nocap=1${extra ? `&${extra}` : ''}`,
);
let last = '';
const t0 = Date.now();
while (Date.now() - t0 < Number(timeout)) {
  const s = await page.evaluate(() => {
    const h = globalThis.__stallHarness;
    const d = h?.debug;
    return d
      ? `${d.phase}|${d.blockId}|${d.trialsCompleted}|${d.expected}|ended=${h.ended}`
      : 'none';
  });
  if (s !== last) {
    console.log(((Date.now() - t0) / 1000).toFixed(1), s);
    last = s;
  }
  if (s.includes('ended=true')) {
    console.log(JSON.stringify(await page.evaluate(() => globalThis.__stallHarness.result)));
    break;
  }
  await page.waitForTimeout(150);
}
await browser.close();
