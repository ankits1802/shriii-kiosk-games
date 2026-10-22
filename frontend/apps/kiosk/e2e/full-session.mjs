#!/usr/bin/env node
// Full-session bot playthrough of the kiosk in headless Chromium (GPU-less, SwiftShader).
//
// Plays one complete session — attract -> onboarding -> Pathway A or B -> report -> survey ->
// farewell — through the real kiosk build: real pointer events on the page, hit-tested by the
// engine's input layer exactly like a player's touches. The bot reads only the live input targets
// (the test bridge `window.__shriiiKiosk`, present in dev builds and VITE_E2E_BRIDGE=true builds) and
// taps one at random after a human-ish think time; hold targets are held. It never answers
// "decline", "under 18" or "exit", so the session runs to the end.
//
// Asserts: the session reaches farewell within the session cap (900 s), no page errors or console
// errors, every stored event passes the strict contract validator, no `invalid` placeholders, the seq
// is gapless from its first value and there is exactly one session_start and one session_end. Timing
// flags are recorded but expected (software rendering): they are reported, never asserted.
//
// Usage:
//   node frontend/apps/kiosk/e2e/full-session.mjs --url http://127.0.0.1:4173 --pathway A \
//     [--out e2e-artifacts/pathway-a] [--size 1280x720] [--seed 7] [--cap-s 900] [--api] [--partial-play]
// --api additionally waits until the outbox has uploaded everything (kiosk built with VITE_API_BASE).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const url = String(arg('url', 'http://127.0.0.1:5173'));
const pathway = String(arg('pathway', 'B')).toUpperCase();
const out = String(arg('out', `e2e-artifacts/pathway-${pathway.toLowerCase()}`));
const [W, H] = String(arg('size', '1280x720')).split('x').map(Number);
const capS = Number(arg('cap-s', 900));
const waitUpload = arg('api', false) === true;
const verbose = arg('verbose', false) === true;
const partialPlay = arg('partial-play', false) === true;
let seed = Number(arg('seed', 7)) >>> 0 || 7;
const rand = () => {
  // mulberry32: reproducible bot choices
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
mkdirSync(out, { recursive: true });

/** Targets the bot never taps (they end or detour the session). */
const AVOID =
  /(globe|replay|under_18|consent\.no|archive\.no|lang\.cancel|exit|delete|bin|help|skip)/i;
/** Fallback (React) screen buttons, in preference order. */
const PREFERRED_DOM = [
  'attract.touch',
  'language.',
  'consent.grant',
  'bands.adult',
  'report.done',
  'survey.happy',
  'survey.again_yes',
  'optin.no',
];

const arm = pathway === 'A' ? 'A_narrative' : 'B_fixed';
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
await page.goto(`${url.replace(/\/$/, '')}/?arm=${arm}`, { waitUntil: 'load', timeout: 120_000 });
await page.waitForFunction(() => globalThis.__shriiiKiosk?.controller, null, { timeout: 120_000 });

const states = [];
let sessionId = null;
let lastEvents = [];
let lastRead = 0;
let lastShot = 0;
let ended = null;

async function snapshot(withEvents = false) {
  return page.evaluate(
    async ([sid, wantEvents]) => {
      const k = globalThis.__shriiiKiosk;
      const v = k.controller.snapshot;
      const targets = k.input.liveTargets();
      const dom = [
        ...document.querySelectorAll('[data-testid="kiosk-runtime"] [id], [data-target]'),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.id || el.getAttribute('data-target'),
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
          };
        });
      const id = sid ?? (v.sessionId || null);
      const events = id && wantEvents ? await k.outbox.sessionEvents(id) : [];
      return {
        state: v.state,
        sessionId: v.sessionId || null,
        module: v.currentModule,
        walkaway: v.walkawayStage,
        targets,
        dom,
        events,
      };
    },
    [sessionId, withEvents],
  );
}

async function tap(x, y, holdMs) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

/** Keep clear of the persistent exit control (top-right). */
const nearExit = (x, y) => x > W - 140 && y < 140;

let lastModule = null;
for (;;) {
  if (elapsed() > capS + 60) {
    ended = 'bot_timeout';
    break;
  }
  // The outbox copy is read every 20 s (and at the end), not on every step.
  const s = await snapshot(Date.now() - lastRead > 20_000);
  if (s.events.length > 0) lastRead = Date.now();
  if (states.at(-1) !== s.state) {
    states.push(s.state);
    console.log(`${elapsed().toFixed(0)}s state=${s.state}`);
  }
  if (s.module !== lastModule) {
    lastModule = s.module;
    if (s.module) console.log(`${elapsed().toFixed(0)}s module=${s.module}`);
  }
  if (!sessionId && s.sessionId && s.state !== 'attract') sessionId = s.sessionId;
  if (sessionId && s.events.length > 0) lastEvents = s.events;
  if (Date.now() - lastShot > Number(arg('shot-s', 30)) * 1000) {
    lastShot = Date.now();
    await page
      .screenshot({
        path: join(out, `t${String(Math.round(elapsed())).padStart(4, '0')}-${s.state}.png`),
        timeout: 10_000,
      })
      .catch(() => undefined);
  }
  if (sessionId && (s.state === 'farewell' || s.state === 'wipe' || s.state === 'attract')) {
    ended = s.state;
    // session_end is written during the wipe (after the farewell screen): wait for the kiosk to be
    // back in attract, then read the stored session once more.
    const until = Date.now() + 60_000;
    let fin = s;
    while (fin.state !== 'attract' && Date.now() < until) {
      await page.waitForTimeout(1000);
      fin = await snapshot(true);
    }
    await page.waitForTimeout(1500);
    fin = await snapshot(true);
    ended = fin.state === 'attract' ? 'attract' : ended;
    if (fin.events.length > 0) lastEvents = fin.events;
    break;
  }
  // Fallback (React) screens: DOM buttons.
  const dom = s.dom.filter((d) => d.id && !AVOID.test(d.id));
  const preferred = PREFERRED_DOM.map((p) => dom.find((d) => d.id.startsWith(p))).find(Boolean);
  if (preferred) {
    await page.waitForTimeout(300 + rand() * 500);
    await tap(preferred.x, preferred.y, 80);
    continue;
  }
  // "Are you still there?": a present player touches the screen (any touch is activity). Long
  // non-interactive intros with the silent dev voice reach the walkaway prompt on slow renderers.
  if (s.walkaway) {
    await page.waitForTimeout(400 + rand() * 600);
    await tap(W / 2, 24, 60);
    continue;
  }
  const live = s.targets.filter((t) => !AVOID.test(t.id));
  if (live.length === 0) {
    await page.waitForTimeout(200);
    continue;
  }
  // A selection usually gets confirmed soon (confirm / tick buttons appear after a choice).
  const confirms = live.filter((c) => /(confirm|\.yes$|tick|done|next)/i.test(c.id));
  const t =
    confirms.length > 0 && rand() < 0.6
      ? confirms[Math.floor(rand() * confirms.length)]
      : live[Math.floor(rand() * live.length)];
  const b = t.bounds;
  const x = b.x + b.width * (0.3 + 0.4 * rand());
  const y = b.y + b.height * (0.3 + 0.4 * rand());
  if (nearExit(x, y) || x < 0 || y < 0 || x > W || y > H) {
    await page.waitForTimeout(150);
    continue;
  }
  const hold = t.kind === 'hold' ? 1500 + rand() * 3000 : rand() < 0.08 ? 900 : 60;
  await page.waitForTimeout(150 + rand() * 700);
  if (verbose)
    console.log(`  tap ${t.id} @${Math.round(x)},${Math.round(y)} hold ${Math.round(hold)}`);
  await tap(x, y, hold);
}

let uploaded = null;
if (waitUpload && sessionId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    uploaded = await page.evaluate(() => globalThis.__shriiiKiosk.outbox.pendingCount());
    if (uploaded === 0) break;
    await page.waitForTimeout(1000);
  }
}
await page.screenshot({ path: join(out, 'final.png'), timeout: 10_000 }).catch(() => undefined);
await browser.close();

// ------------------------------------------------------------------------------------- checks
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const events = lastEvents;
check(sessionId !== null, 'a session started');
check(ended === 'farewell' || ended === 'wipe' || ended === 'attract', `session ended (${ended})`);
check(states.includes('play'), 'the session reached play');
check(states.includes('report') || states.includes('survey'), 'the session reached the report');
check(errors.length === 0, `no page/console errors:\n  ${errors.slice(0, 10).join('\n  ')}`);
let invalid = 0;
const invalidSamples = [];
for (const e of events) {
  if (!validateEventEnvelope(e)) {
    invalid++;
    if (invalidSamples.length < 5)
      invalidSamples.push(
        `${e.event_type}#${e.seq}: ${JSON.stringify(validateEventEnvelope.errors?.slice(0, 2))}`,
      );
  }
}
check(invalid === 0, `every event valid (${invalid} invalid): ${invalidSamples.join('; ')}`);
const placeholders = events.filter((e) => e.event_type === 'invalid').length;
check(placeholders === 0, `no invalid placeholders (${placeholders})`);
const seqs = events.map((e) => e.seq);
const gapless = seqs.every((q, i) => i === 0 || q === seqs[i - 1] + 1);
check(gapless, 'seq is gapless');
const end = events.find((e) => e.event_type === 'session_end');
const sessionS = end?.payload?.duration_ms != null ? end.payload.duration_ms / 1000 : elapsed();
check(sessionS <= capS, `session completed within ${capS} s (${sessionS.toFixed(0)} s)`);
const count = (t) => events.filter((e) => e.event_type === t).length;
check(count('session_start') === 1, `one session_start (${count('session_start')})`);
check(count('session_end') === 1, `one session_end (${count('session_end')})`);
const modules = [
  ...new Set(events.filter((e) => e.event_type === 'trial_start').map((e) => e.task?.module_id)),
];
const flags = {};
for (const e of events) {
  const f = e.timing?.timing_flag ?? 'none';
  flags[f] = (flags[f] ?? 0) + 1;
}
check(
  end?.payload?.reason === 'completed',
  `session_end reason completed (${end?.payload?.reason})`,
);
const planned =
  pathway === 'A'
    ? ['stall', 'weighing_post', 'road_home']
    : ['dont_tap', 'card_sort', 'balloon', 'tower', 'share_pot'];
// --partial-play: the session must complete, but the play ceiling may end it before every module ran
// (kiosk -> API job: the API shares the runner's CPU with the software renderer).
if (!partialPlay) for (const m of planned) check(modules.includes(m), `module ${m} ran trials`);
else check(modules.includes(planned[0]), `module ${planned[0]} ran trials`);
const summary = {
  pathway,
  sessionId,
  ended,
  seconds: Math.round(elapsed()),
  sessionSeconds: Math.round(sessionS),
  states,
  events: events.length,
  modulesWithTrials: modules,
  sessionEndReason: end?.payload?.reason ?? null,
  timingFlags: flags,
  uploadPending: uploaded,
  errors: errors.slice(0, 20),
  failures,
};
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(out, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n'));
console.log(JSON.stringify({ ...summary, errors: summary.errors.length }, null, 2));
if (failures.length > 0) {
  console.error(`FAIL full-session pathway ${pathway}:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS full-session pathway ${pathway}`);
