// Full scripted-bot playthrough of The Road Home in a real browser (Chromium), through the real
// module harness, Pixi view, input layer and strict event validation; exports the event stream and
// the plan's trial params for the Python scoring check (dev/score_events.py).
//
// Usage (dev server running): node src/episodes/road-home/dev/bot-run.mjs <exportDir> [WxH] [seed] [extra]
// Software GL is slow at high resolution, so the default viewport is modest and the low tier is used;
// timing flags in this run reflect the software renderer, not the kiosk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [outdir, size = '1280x720', seed = '123', extra = '&tier=low'] = process.argv.slice(2);
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
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[error] ${m.text()}`);
});
const t0 = Date.now();
await page.goto(
  `http://localhost:${port}/?module=road_home&level=L2&lang=en-IN&seed=${seed}&bot=1${extra}`,
);
await page.waitForFunction(() => globalThis.__shriiiHarness?.state === 'running', null, {
  timeout: 120000,
});
let last = '';
for (;;) {
  const s = await page.evaluate(async () => {
    const hnd = globalThis.__shriiiHarness;
    const ev = await hnd.events();
    const ts = ev.filter((e) => e.event_type === 'trial_start');
    return { state: hnd.state, n: ev.length, trial: ts.at(-1)?.task?.trial_id ?? null };
  });
  if (s.trial !== last) {
    last = s.trial;
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s.trial} (${s.n} events)`);
  }
  if (s.state === 'ended') break;
  if (Date.now() - t0 > 600000) {
    console.log('timeout');
    break;
  }
  await page.waitForTimeout(500);
}
const data = await page.evaluate(async () => {
  const hnd = globalThis.__shriiiHarness;
  return {
    result: hnd.result,
    events: await hnd.events(),
    sessionId: hnd.run.sessionId,
    params: globalThis.__roadHomePlanParams ?? null,
  };
});
writeFileSync(
  join(outdir, 'events.ndjson'),
  `${data.events.map((e) => JSON.stringify(e)).join('\n')}\n`,
);
writeFileSync(
  join(outdir, 'trial_params.json'),
  JSON.stringify({ [data.sessionId]: data.params }, null, 2),
);
const flags = {};
for (const e of data.events) flags[e.timing.timing_flag] = (flags[e.timing.timing_flag] ?? 0) + 1;
const invalid = data.events.filter((e) => e.event_type === 'invalid').length;
console.log('result', JSON.stringify(data.result));
console.log(
  'events',
  data.events.length,
  'invalid',
  invalid,
  'timing flags',
  JSON.stringify(flags),
);
console.log(errors.slice(0, 20).join('\n'));
await browser.close();
