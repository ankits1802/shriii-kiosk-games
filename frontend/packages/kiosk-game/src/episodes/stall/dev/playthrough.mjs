// Scripted browser playthrough of The Stall: a bot plays the whole episode with REAL pointer clicks
// (Playwright mouse -> DomInputService), then the run's events and trial params are exported as NDJSON
// for the Python scorer (`score_events.py`). Fails (exit 1) when the module does not complete, when any
// event was replaced by an `invalid` placeholder (strict contract validation in the dev logger), when
// `seq` has gaps, or when a trial lacks its trial_start / stimulus_onset / response / trial_end.
//
//   node src/episodes/stall/dev/playthrough.mjs <outdir> [WxH] [extra query]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [outdir, size = '1280x720', extra = 'tier=low'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const port = Number(process.env.STALL_PORT ?? 5347);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
await page.goto(`http://localhost:${port}/?seed=4242&level=L2&lang=hi-IN&nocap=1&${extra}`);

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
let answered = null;
let clicks = 0;
const t0 = Date.now();
for (;;) {
  const s = await page.evaluate(() => {
    const hh = globalThis.__stallHarness;
    return hh ? { d: hh.debug, ended: hh.ended } : null;
  });
  if (s?.ended) break;
  if (Date.now() - t0 > 900000) throw new Error('playthrough timed out');
  const d = s?.d;
  if (d && d.phase === 'stimulus' && d.trialId && d.trialId !== answered) {
    answered = d.trialId;
    const ids = Object.keys(d.targets);
    let id = null;
    if (d.expected === 'serve') id = rand() < 0.9 ? ids[0] : null;
    else if (d.expected === 'withhold') id = rand() < 0.2 ? ids[0] : null;
    else id = ids[Math.floor(rand() * ids.length)];
    if (id) {
      const c = d.targets[id];
      await page.waitForTimeout(d.expected === 'tone' ? 300 : 60);
      await page.mouse.click(c.x, c.y);
      clicks += 1;
      // An occasional extra tap (restraint indicators must see it).
      if (rand() < 0.1) await page.mouse.click(c.x, c.y);
    }
  }
  await page.waitForTimeout(30);
}
const result = await page.evaluate(() => globalThis.__stallHarness.result);
const events = await page.evaluate(() => globalThis.__stallHarness.events());
const params = await page.evaluate(() => globalThis.__stallHarness.trialParams());
const sessionId = await page.evaluate(() => globalThis.__stallHarness.sessionId);
await browser.close();

const problems = [];
if (result?.endedReason !== 'completed') problems.push(`module ended: ${JSON.stringify(result)}`);
const invalid = events.filter((e) => e.event_type === 'invalid');
if (invalid.length)
  problems.push(`${invalid.length} invalid events: ${JSON.stringify(invalid[0].payload)}`);
events.forEach((e, i) => {
  if (e.seq !== events[0].seq + i) problems.push(`seq gap at ${i}`);
});
const byTrial = new Map();
for (const e of events) {
  const id = e.task?.trial_id;
  if (id) byTrial.set(id, [...(byTrial.get(id) ?? []), e.event_type]);
}
for (const [id, types] of byTrial) {
  for (const need of ['trial_start', 'stimulus_onset', 'response', 'trial_end'])
    if (!types.includes(need)) problems.push(`${id} lacks ${need}`);
}
const taps = events.filter((e) => e.event_type === 'input.raw_tap');
writeFileSync(
  join(outdir, 'stall_events.ndjson'),
  `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
);
writeFileSync(join(outdir, 'stall_trial_params.json'), JSON.stringify({ [sessionId]: params }));
console.log(
  `events ${events.length}, trials ${byTrial.size}, raw taps ${taps.length}, clicks ${clicks}, result ${JSON.stringify(result)}`,
);
if (errors.length) problems.push(...errors.map((e) => `pageerror: ${e.split('\n')[0]}`));
if (problems.length) {
  console.log(`FAIL\n${problems.slice(0, 20).join('\n')}`);
  process.exit(1);
}
console.log('OK: browser playthrough completed with a valid, gapless event stream');
