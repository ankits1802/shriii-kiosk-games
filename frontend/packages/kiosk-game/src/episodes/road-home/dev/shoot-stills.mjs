// Screenshot every Road Home still (deterministic phases) at a viewport size.
// Usage: node src/episodes/road-home/dev/shoot-stills.mjs <outdir> <WxH> [still1,still2,...] [extra=&tier=high]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ALL = [
  'intro_fair',
  'intro_road',
  'practice_map',
  'practice_fork',
  'errand_map',
  'errand_map_progress',
  'errand_map_night',
  'optional_stranded_traveller',
  'optional_shrine_lamp',
  'optional_spilled_mangoes',
  'optional_thirsty_calf',
  'optional_fallen_signpost',
  'optional_helped',
  'fork_sunset',
  'fork_dusk',
  'fork_night',
  'fork_outcome_correct',
  'fork_outcome_dead_end',
  'blocked_tree',
  'blocked_tree_bump',
  'blocked_flood',
  'blocked_flood_ferry',
  'fodder_stop',
  'fodder_reveal',
  'fodder_free_rider',
  'fodder_partner_spill',
  'uphill',
  'uphill_push',
  'uphill_crest',
  'probe_crossing',
  'outro_home',
];
const [outdir, size = '1920x1080', list, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((r) => r.split('=')));
const names = list && list !== 'all' ? list.split(',') : ALL;
const [w, h] = size.split('x').map(Number);
const port = process.env.ROAD_HOME_PORT ?? '5377';
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
for (const name of names) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[error] ${m.text()}`);
  });
  const t0 = Date.now();
  await page.goto(
    `http://localhost:${port}/?module=road_home&level=L2&lang=en-IN&seed=${opts.seed ?? '123'}&still=${name}${opts.extra ?? ''}`,
  );
  try {
    await page.waitForFunction(
      () => document.getElementById('host')?.dataset.still === 'ready',
      null,
      { timeout: 180000 },
    );
    await page.screenshot({ path: join(outdir, `${name}_${w}x${h}.png`), timeout: 180000 });
    console.log(`shot ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`FAILED ${name}: ${e.message.split('\n')[0]}`);
  }
  if (logs.length) console.log(logs.slice(0, 6).join('\n'));
  await page.close();
}
await browser.close();
