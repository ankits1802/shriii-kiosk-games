// Dev diagnostics: CPU-profile a dev URL for a few seconds after `startS` and print the hottest functions.
import { chromium } from '@playwright/test';

const [q, startS, durS] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://localhost:5311/?${q}`);
await page.waitForTimeout(Number(startS) * 1000);
const client = await page.context().newCDPSession(page);
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 500 });
await client.send('Profiler.start');
await page.waitForTimeout(Number(durS) * 1000);
const { profile } = await client.send('Profiler.stop');
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
const counts = new Map();
profile.samples.forEach((id, i) => {
  counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0));
});
for (const [id, us] of counts) {
  const n = byId.get(id);
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + us);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(
  'total ms',
  Math.round(total / 1000),
  'phase',
  await page.evaluate(() => globalThis.__set2?.phase),
);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30))
  console.log((v / 1000).toFixed(0).padStart(6), k);
await browser.close();
