import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  args: [
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(
  'http://localhost:5310/?module=' + process.argv[2] + '&level=L2&lang=en-IN&seed=123&bot=1',
);
await page.waitForFunction(() => document.body.dataset.harnessResult, null, { timeout: 300000 });
const r = await page.evaluate(async () => {
  const h = globalThis.__shriiiHarness;
  const ev = await h.events();
  const t0 = ev.find((e) => e.event_type === 'module_start').timing.t_mono_ms;
  const blocks = {};
  for (const e of ev)
    if (e.event_type === 'trial_start') {
      const b = e.task.block_id;
      blocks[b] ??= [Math.round(e.timing.t_mono_ms - t0)];
      blocks[b][1] = Math.round(e.timing.t_mono_ms - t0);
    }
  const end = ev.find((e) => e.event_type === 'module_end');
  return {
    result: document.body.dataset.harnessResult,
    blocks,
    end: end && [Math.round(end.timing.t_mono_ms - t0), end.payload],
  };
});
console.log(JSON.stringify(r));
await browser.close();
