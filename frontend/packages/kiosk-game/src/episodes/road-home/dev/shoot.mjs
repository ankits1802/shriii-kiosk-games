// Visual QA for The Road Home: runs a full scripted-bot playthrough in Chromium and captures every
// phase (intro, practice, maps, roadside opportunities, forks before/after the reversal, the blocked
// roads, the fodder stop, the hills, the probes and the arrival home).
//
// Usage (dev server running: npx vite --config src/episodes/road-home/dev/vite.config.ts):
//   node src/episodes/road-home/dev/shoot.mjs <outdir> <WxH> [seed] [only=phase1,phase2] [export=<dir>]
// With export=<dir> the run's events and trial params are written for the Python scoring check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [outdir, size = '1920x1080', seed = '123', ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((r) => r.split('=')));
const only = opts.only ? new Set(opts.only.split(',')) : null;
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
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
const t0 = Date.now();
await page.goto(
  `http://localhost:${port}/?module=road_home&level=L2&lang=en-IN&seed=${seed}&bot=1${opts.extra ?? ''}`,
);
await page.waitForFunction(() => globalThis.__shriiiHarness?.state === 'running', null, {
  timeout: 60000,
});

const shots = new Set();
async function shot(name) {
  if (shots.has(name) || (only && !only.has(name))) return;
  shots.add(name);
  const file = `${name}_${w}x${h}.png`;
  const t = Date.now();
  await page.screenshot({ path: join(outdir, file), timeout: 120000 });
  if (Date.now() - t > 2000) console.log(`  (slow screenshot ${Date.now() - t} ms)`);
  console.log(`shot ${file} @${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const pending = [];
function schedule(name, ms) {
  if (shots.has(name) || pending.some((p) => p.name === name)) return;
  pending.push({ name, at: Date.now() + ms });
}

schedule('intro_fair', 1600);
schedule('intro_road', 5200);
let seen = 0;
const trialKind = new Map();
let lastType = null;
for (;;) {
  const state = await page.evaluate(async () => {
    const hnd = globalThis.__shriiiHarness;
    const ev = hnd ? await hnd.events() : [];
    return {
      state: hnd?.state,
      events: ev.map((e) => ({ t: e.event_type, id: e.task?.trial_id ?? null, p: e.payload })),
    };
  });
  const ev = state.events;
  for (; seen < ev.length; seen += 1) {
    const e = ev[seen];
    if (e.t === 'trial_start') trialKind.set(e.id, e.p.trial_type);
    const kind = trialKind.get(e.id);
    const block = e.id ? e.id.split('.')[1] : '';
    if (e.t === 'stimulus_onset') {
      if (block === 'practice') schedule('practice_map', 350);
      else if (kind === 'errand_map') {
        schedule('errand_map', 400);
      } else if (kind === 'optional_opportunity')
        schedule(`optional_${String(e.p.stimulus_id).split('.').pop()}`, 300);
      else if (kind === 'fork_choice' && block === 'errand_maps') schedule('fork_sunset', 250);
      else if (kind === 'fork_choice' && block === 'blocked_road') schedule('fork_dusk', 250);
      else if (kind === 'fork_choice' && block === 'reversal') schedule('fork_night', 250);
      else if (kind === 'blocked_route' && String(e.p.stimulus_id).includes('tree'))
        schedule('blocked_tree', 900);
      else if (kind === 'blocked_route') schedule('blocked_flood', 900);
      else if (kind === 'fuel_round') schedule('fodder_stop', 350);
      else if (kind === 'effort_hold') schedule('uphill', 250);
      else if (kind === 'probe') schedule('probe_crossing', 150);
    }
    if (e.t === 'route_step' && block === 'practice') schedule('practice_fork', 2600);
    if (e.t === 'route_step' && kind === 'errand_map' && e.p.step_index === 3)
      schedule('errand_map_progress', 300);
    if (e.t === 'response' && kind === 'fork_choice' && block !== 'practice') {
      schedule(e.p.correctness ? 'fork_outcome_correct' : 'fork_outcome_dead_end', 520);
    }
    if (e.t === 'response' && kind === 'optional_opportunity' && e.p.response_value === 'take')
      schedule('optional_helped', 800);
    if (e.t === 'response' && e.p.response_value === 'fallback')
      schedule('blocked_flood_ferry', 1200);
    if (e.t === 'response' && kind === 'fuel_round') schedule('fodder_choice', 0);
    if (e.t === 'partner_action')
      schedule(
        e.p.is_error
          ? 'fodder_partner_spill'
          : e.p.partner_type === 'free_rider'
            ? 'fodder_free_rider'
            : 'fodder_reveal',
        700,
      );
    if (e.t === 'input.hold') schedule('uphill_crest', 500);
    if (e.t === 'response' && kind === 'effort_hold') schedule('uphill_push', 0);
    if (e.t === 'trial_end' && kind === 'probe' && e.id.endsWith('.3')) {
      schedule('outro_home', 1700);
      schedule('outro_glow', 2900);
    }
    lastType = e.t;
  }
  const now = Date.now();
  pending.sort((a, b) => a.at - b.at);
  while (pending.length > 0 && pending[0].at <= now) {
    const p = pending.shift();
    await shot(p.name);
  }
  if (state.state === 'ended' && pending.length === 0) break;
  if (opts.until && shots.has(opts.until)) break;
  if (now - t0 > 420000) {
    console.log('timeout');
    break;
  }
  await page.waitForTimeout(60);
}
const result = await page.evaluate(() => globalThis.__shriiiHarness?.result);
console.log(
  'result',
  JSON.stringify(result),
  'last',
  lastType,
  `${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
if (opts.export) {
  mkdirSync(opts.export, { recursive: true });
  const data = await page.evaluate(async () => {
    const hnd = globalThis.__shriiiHarness;
    const ev = await hnd.events();
    return {
      events: ev,
      sessionId: hnd.run.sessionId,
      params: globalThis.__roadHomePlanParams ?? null,
    };
  });
  writeFileSync(
    join(opts.export, 'events.ndjson'),
    `${data.events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
  writeFileSync(
    join(opts.export, 'trial_params.json'),
    JSON.stringify({ [data.sessionId]: data.params }, null, 2),
  );
  console.log('exported', data.events.length, 'events');
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
