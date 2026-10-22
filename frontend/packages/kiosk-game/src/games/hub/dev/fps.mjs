// Measure rendering frame rate of a dev URL under different Chromium GL backends (dev diagnostics).
import { chromium } from '@playwright/test';

const [q, backend] = process.argv.slice(2);
const args =
  backend === 'gpu'
    ? [
        '--use-angle=d3d11',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
      ]
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://localhost:5311/?${q}`);
await page.waitForTimeout(8000);
const r = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t = performance.now();
      const f = () => {
        n++;
        if (performance.now() - t > 3000) res(n / 3);
        else requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    }),
);
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const d = c?.getExtension('WEBGL_debug_renderer_info');
  return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a';
});
console.log(backend, 'fps', r, gl);
await browser.close();
