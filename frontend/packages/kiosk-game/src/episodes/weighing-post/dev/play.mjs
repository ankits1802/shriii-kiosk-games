// Playwright player for The Weighing Post: plays the whole episode in a real Chromium through REAL
// pointer events (mouse clicks on the token rects), captures a screenshot of every phase, then exports
// the event stream as NDJSON plus the trial params for the scoring engine.
//
// Dev server first: npx vite --config src/episodes/weighing-post/dev/vite.config.ts
// Usage: node src/episodes/weighing-post/dev/play.mjs <outdir> <WxH> [--seed N] [--form form_2]
//          [--reduced] [--export <prefix>] [--no-shots] [--tag name]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const outdir = args[0];
const [w, h] = (args[1] ?? '1920x1080').split('x').map(Number);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const seed = opt('seed', '123');
const form = opt('form');
const reduced = flag('reduced');
const shots = !flag('no-shots');
const exportPrefix = opt('export');
const tag = opt('tag', reduced ? 'reduced' : '');
mkdirSync(outdir, { recursive: true });

// Hardware GPU through ANGLE when available (WP_GL overrides, e.g. the swiftshader flags in CI).
const browser = await chromium.launch({
  args: (
    process.env.WP_GL ??
    '--use-angle=d3d11,--enable-gpu,--ignore-gpu-blocklist,--autoplay-policy=no-user-gesture-required'
  ).split(','),
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
const q = new URLSearchParams({ seed, level: 'L2', lang: 'en-IN' });
if (form) q.set('form', form);
if (reduced) q.set('reduced', '1');
await page.goto(`http://localhost:5383/?${q}`);
await page.waitForFunction(() => globalThis.__wp?.state?.() === 'running', null, {
  timeout: 60000,
});
const t0 = Date.now();

const taken = new Set();
async function shot(name) {
  if (!shots || taken.has(name)) return;
  taken.add(name);
  const file = `${outdir}/${name}${tag ? `__${tag}` : ''}_${w}x${h}.png`;
  await page.screenshot({ path: file });
  console.log(`shot ${name} @${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function events() {
  return page.evaluate(async () =>
    (await globalThis.__wp.events()).map((e) => ({
      seq: e.seq,
      t: e.timing.t_mono_ms,
      type: e.event_type,
      trial: e.task?.trial_id ?? null,
      index: e.task?.trial_index ?? null,
      payload: e.event_type === 'trial_start' || e.event_type === 'response' ? e.payload : null,
    })),
  );
}
async function rects(kind, codes) {
  return page.evaluate(([k, c]) => globalThis.__wp.rects(k, c), [kind, codes]);
}
async function tap(r) {
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
}
const params = await page.evaluate(() => globalThis.__wp.trialParams());
const sessionParams = Object.values(params)[0] ?? {};
const rand = (() => {
  let s = (Number(seed) * 2654435761) % 4294967296;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
})();
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const CODES = {
  weigh_decision: ['approve', 'warn', 'fine'],
  bribe: ['accept', 'decline'],
  overpayment: ['return', 'keep'],
  assistant_mistake: ['self', 'assistant', 'shared', 'chance'],
  fraud_found: ['self', 'assistant', 'shared'],
  gamble_inspection: ['inspect', 'gamble'],
  luck_token: ['face_1', 'face_2', 'face_3', 'face_4', 'face_5', 'face_6'],
  probe: ['safe', 'risky'],
};
const KIND = {
  weigh_decision: 'weigh',
  bribe: 'bribe',
  overpayment: 'overpayment',
  assistant_mistake: 'assistant_mistake',
  fraud_found: 'fraud_found',
  gamble_inspection: 'gamble',
  luck_token: 'luck',
  probe: 'probe',
};

const handled = new Set();
let lastEndAt = 0;
let lastType = null;
let sawShift = false;
let introLate = false;
for (;;) {
  const state = await page.evaluate(() => globalThis.__wp.state());
  const elapsed = Date.now() - t0;
  if (elapsed > 900 && elapsed < 2200) await shot('01-intro-tilt');
  if (!introLate && elapsed > 4300) {
    introLate = true;
    await shot('02-intro-guide');
  }
  if (state === 'ended') break;
  const ev = await events();
  const starts = ev.filter((e) => e.type === 'trial_start');
  const cur = starts.at(-1);
  const ended = new Set(ev.filter((e) => e.type === 'trial_end').map((e) => e.trial));
  if (ev.some((e) => e.type === 'context_shift')) sawShift = true;
  // Between trials: the announcement and the outro.
  if (cur && ended.has(cur.trial)) {
    if (lastType === 'luck_token' && !sawShift && Date.now() - lastEndAt > 2700)
      await shot('12-new-rule');
    if (lastType === 'probe' && Date.now() - lastEndAt > 1800) await shot('15-outro');
    await sleep(120);
    continue;
  }
  if (!cur || handled.has(cur.trial)) {
    await sleep(80);
    continue;
  }
  const onset = ev.find((e) => e.trial === cur.trial && e.type === 'stimulus_onset');
  if (!onset) {
    await sleep(50);
    continue;
  }
  handled.add(cur.trial);
  const type = cur.payload.trial_type;
  const kind = KIND[type];
  const codes = CODES[type];
  const p = sessionParams[cur.trial] ?? {};
  const practice = cur.index === 0;
  const r = await rects(kind, codes);
  const slot = (code) => r.slots.find((s) => s.code === code).rect;
  if (type === 'weigh_decision') {
    await sleep(1350); // needle settles (level table needle_settle_ms = 1200 at L2)
    const post = sawShift;
    if (practice) await shot('03-practice-hint');
    else if (!post) await shot('04-weigh-decision');
    else await shot('13-weigh-new-rule');
    if (p.ambiguous) {
      if (!taken.has('05-weigh-ambiguous')) await shot('05-weigh-ambiguous');
      await tap(r.controls.inspect);
      await sleep(1700);
    }
    const choice = rand() < 0.85 ? cur.payload.expected_response : pick(codes);
    if (rand() < 0.2) {
      await tap(slot(pick(codes.filter((c) => c !== choice))));
      await sleep(350);
    }
    await tap(slot(choice));
    await sleep(380);
    if (!practice) await shot('06-weigh-selected');
    await tap(r.confirm[choice]);
    await sleep(260);
    if (!practice) await shot('07-weigh-stamp');
  } else if (type === 'probe') {
    await sleep(120);
    await shot('14-probe');
    await tap(slot(pick(codes)));
  } else if (type === 'luck_token') {
    await sleep(500);
    await shot('11-luck-token');
    await tap(slot(pick(codes)));
  } else {
    await sleep(600);
    const name = {
      bribe: '08-bribe',
      overpayment: '09-overpayment',
      assistant_mistake: '10a-assistant-mistake',
      fraud_found: '10b-fraud-found',
      gamble_inspection: '10c-gamble',
    }[type];
    await shot(name);
    const choice = pick(codes);
    await tap(slot(choice));
    await sleep(300);
    await tap(r.confirm[choice]);
    await sleep(500);
    if (type === 'fraud_found') await shot('10b-fraud-found-outcome');
  }
  lastType = type;
  // Wait for the trial to end.
  for (let i = 0; i < 200; i++) {
    const e2 = await events();
    if (e2.some((e) => e.type === 'trial_end' && e.trial === cur.trial)) break;
    await sleep(80);
  }
  lastEndAt = Date.now();
}
const result = await page.evaluate(() => globalThis.__wp.result());
console.log('result', JSON.stringify(result));
if (exportPrefix) {
  const all = await page.evaluate(async () => globalThis.__wp.events());
  writeFileSync(`${exportPrefix}.ndjson`, `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);
  writeFileSync(
    `${exportPrefix}.params.json`,
    JSON.stringify(await page.evaluate(() => globalThis.__wp.trialParams())),
  );
  console.log(`exported ${all.length} events to ${exportPrefix}.ndjson`);
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
