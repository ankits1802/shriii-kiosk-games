// Visual QA for The Stall: run the dev route with autoplay and capture every phase.
// Start the dev route first (`npx vite --config src/episodes/stall/dev/vite.config.ts`), then:
//   node src/episodes/stall/dev/shoot.mjs <outdir> <WxH> [extra query, e.g. tier=medium] [segments]
// Each segment starts at a block (`start=`, dev only) with the caps lifted (`nocap=1`: headless software
// rendering is far slower than the kiosk GPU) and shots are taken when the episode's debug state reaches
// each beat. `segments` is an optional comma list of segment indexes (0-9). Page errors are printed.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [outdir, size = '1920x1080', extra = '', only = ''] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const port = Number(process.env.STALL_PORT ?? 5347);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const logs = [];

/** [segment start block | '', [[name, predicate, delayMs], ...], extra segment query?] */
const segments = [
  ['', [['01_intro', (d) => d.phase === 'intro', 2600]]],
  [
    'practice',
    [
      [
        '02_practice_serve',
        (d) => d.blockId === 'practice' && d.phase === 'stimulus' && d.expected === 'serve',
        150,
      ],
    ],
    'think=4',
  ],
  [
    'practice',
    [
      [
        '03_practice_spoiled',
        (d) => d.blockId === 'practice' && d.phase === 'stimulus' && d.expected === 'withhold',
        200,
      ],
    ],
  ],
  [
    'service',
    [
      [
        '04_service_bubble',
        (d) => d.blockId === 'service' && d.phase === 'stimulus' && d.expected === 'serve',
        80,
      ],
      [
        '05_service_spoiled',
        (d) => d.blockId === 'service' && d.phase === 'stimulus' && d.expected === 'withhold',
        200,
      ],
      [
        '06_service_served',
        (d) =>
          d.blockId === 'service' &&
          d.phase === 'stimulus' &&
          d.expected === 'serve' &&
          d.trialsCompleted >= 6,
        1650,
      ],
    ],
  ],
  [
    'tone_calm',
    [
      ['07_tone_teach', (d) => d.blockId === 'tone_calm' && d.phase === 'handover', 2300],
      ['08_tone_calm', (d) => d.blockId === 'tone_calm' && d.phase === 'stimulus', 700],
      [
        '09_tone_chosen',
        (d) => d.blockId === 'tone_calm' && d.phase === 'stimulus' && d.trialsCompleted >= 1,
        2400,
      ],
    ],
  ],
  [
    'timed_rush',
    [
      ['10_rush_cue', (d) => d.blockId === 'timed_rush' && d.phase === 'handover', 1600],
      [
        '11_rush_trial',
        (d) => d.blockId === 'timed_rush' && d.phase === 'stimulus' && d.trialsCompleted >= 1,
        450,
      ],
    ],
  ],
  [
    'rude_run',
    [
      ['12_rude_first', (d) => d.blockId === 'rude_run' && d.phase === 'stimulus', 900],
      [
        '13_rude_late',
        (d) => d.blockId === 'rude_run' && d.phase === 'stimulus' && d.trialsCompleted >= 3,
        900,
      ],
      [
        '14_rude_chosen',
        (d) => d.blockId === 'rude_run' && d.phase === 'stimulus' && d.trialsCompleted >= 4,
        2600,
      ],
    ],
  ],
  ['probe', [['15_probe_preview', (d) => d.blockId === 'probe' && d.phase === 'handover', 1700]]],
  ['probe', [['16_probe', (d) => d.blockId === 'probe' && d.phase === 'stimulus', 400]], 'think=8'],
  ['probe', [['17_outro', (d) => d.phase === 'outro', 1500]], 'keep=1'],
];

const wanted = only ? new Set(only.split(',').map(Number)) : null;
for (const [i, [start, shots, segQuery = '']] of segments.entries()) {
  if (wanted && !wanted.has(i)) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('Deprecat'))
      logs.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
  const q = `seed=123&level=L2&lang=en-IN&autoplay=1&nocap=1${start ? `&start=${start}` : ''}${segQuery ? `&${segQuery}` : ''}${extra ? `&${extra}` : ''}`;
  await page.goto(`http://localhost:${port}/?${q}`);
  for (const [name, pred, delay] of shots) {
    const fn = `(() => { const d = globalThis.__stallHarness?.debug; return !!d && (${pred.toString()})(d); })()`;
    try {
      await page.waitForFunction(fn, null, { timeout: 300000, polling: 100 });
      await page.waitForTimeout(delay);
      await page.screenshot({ path: `${outdir}/stall__${name}_${w}x${h}.png`, timeout: 120000 });
      console.log('shot', name);
    } catch (e) {
      console.log('missed', name, String(e).split('\n')[0]);
    }
  }
  await page.close();
}
console.log([...new Set(logs)].slice(0, 30).join('\n'));
await browser.close();
