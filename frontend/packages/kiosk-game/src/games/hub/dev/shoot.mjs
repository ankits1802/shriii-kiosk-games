// Visual QA + browser bot playthrough for the set-2 micro-games (dev server must be running:
// `npx vite --config src/games/hub/dev/vite.config.ts`).
//
// Usage: node src/games/hub/dev/shoot.mjs <outdir> <WxH> <query> [--phases a,b,c] [--every]
//          [--export <dir>] [--timeout <s>]
//   <query>     e.g. "module=share_pot&bot=1&seed=7"  (no leading ?)
//   --phases    phase names (suffix match on "<module>:<phase>") to capture once each; default: all
//   --every     capture every phase occurrence (not just the first)
//   --export    write events.ndjson + trial_params.json for the run into <dir>
// Prints phase timeline, the module result and console errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const [outdir, size, query] = args;
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const phases = (opt('--phases') ?? '').split(',').filter(Boolean);
const every = args.includes('--every');
const exportDir = opt('--export');
const timeoutS = Number(opt('--timeout') ?? 240);
const port = process.env.SET2_PORT ?? '5311';
const [w, h] = size.split('x').map(Number);
mkdirSync(outdir, { recursive: true });

// Hardware GL (ANGLE/D3D11) by default: software GL renders the full Mela scene at ~2 fps, which
// would distort onset timing in bot runs. SET2_GL=swiftshader forces the software path.
const browser = await chromium.launch({
  args:
    process.env.SET2_GL === 'swiftshader'
      ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack ?? e.message}`));
await page.goto(`http://localhost:${port}/?${query}`);
const tag = new URLSearchParams(query).get('module') ?? 'set2';
const seen = new Map();
const t0 = Date.now();
let last = '';
for (;;) {
  const st = await page.evaluate(() => {
    const s = globalThis.__set2;
    return s
      ? { state: s.state, phase: s.phase, error: s.error }
      : { state: 'loading', phase: 'loading', error: null };
  });
  if (st.phase !== last) {
    last = st.phase;
    const name = st.phase.split(':').pop();
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${st.phase}`);
    const wanted = phases.length === 0 || phases.some((p) => st.phase.endsWith(p));
    const n = seen.get(st.phase) ?? 0;
    if (wanted && (every || n === 0) && st.phase.includes(':')) {
      await page.waitForTimeout(Number(process.env.SHOT_DELAY ?? 450));
      const file = `${outdir}/${tag}__${name.replace(/\./g, '-')}${every ? `_${n}` : ''}_${w}x${h}.png`;
      await page.screenshot({ path: file });
    }
    seen.set(st.phase, n + 1);
  }
  if (st.state === 'ended' || st.state === 'error') {
    if (st.error) console.log(st.error);
    break;
  }
  if (Date.now() - t0 > timeoutS * 1000) {
    console.log('timeout');
    break;
  }
  await page.waitForTimeout(60);
}
const result = await page.evaluate(() => globalThis.__set2?.result ?? null);
console.log('result', JSON.stringify(result));
if (exportDir) {
  mkdirSync(exportDir, { recursive: true });
  const dump = await page.evaluate(async () => ({
    events: await globalThis.__set2.events(),
    params: globalThis.__set2.trialParams(),
    sessionId: globalThis.__set2.sessionId,
  }));
  writeFileSync(
    `${exportDir}/${tag}.events.ndjson`,
    `${dump.events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
  writeFileSync(
    `${exportDir}/${tag}.trial_params.json`,
    JSON.stringify({ [dump.sessionId]: dump.params }, null, 1),
  );
  console.log('exported', dump.events.length, 'events');
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
