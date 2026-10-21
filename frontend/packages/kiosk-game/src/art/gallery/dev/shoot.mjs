// Visual QA: screenshot gallery routes with Chromium (dev server must be running: `pnpm gallery`).
// Usage: node src/art/gallery/dev/shoot.mjs <outdir> <WxH> <route[@waitMs]> [...]
// Routes are written without the leading slash (Git Bash rewrites /paths), e.g. backdrop/attract/dusk.
import { chromium } from '@playwright/test';

const [outdir, size, ...routes] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
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
  await page.goto(`http://localhost:5199/?clean#${route}`);
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid=art-gallery]')?.getAttribute('data-status') ===
        'shown',
      null,
      { timeout: 60000 },
    )
    .catch(() => logs.push(`timeout ${route}`));
  await page.waitForTimeout(Number(waitMs ?? 600));
  const name = `${route.replace(/^\//, '').replace(/\//g, '__')}_${w}x${h}.png`;
  await page.screenshot({ path: `${outdir}/${name}` });
  console.log('shot', name);
}
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
