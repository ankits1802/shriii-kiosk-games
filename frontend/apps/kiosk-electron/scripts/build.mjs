#!/usr/bin/env node
/**
 * Build the kiosk runtime into dist/:
 *   dist/main/index.js       ESM bundle of the main process (workspace TS sources inlined)
 *   dist/preload/index.cjs   single-file CommonJS preload (sandboxed preloads cannot import)
 *   dist/renderer/           the built frontend/apps/kiosk renderer (or a placeholder when not built)
 *   dist/static/             shell pages (out-of-service)
 *   dist/config/             outbox policy YAML
 *   dist/build-info.json
 *
 *   node scripts/build.mjs [--with-renderer]   (--with-renderer runs the frontend/apps/kiosk Vite build first)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const kioskApp = path.resolve(root, '..', 'kiosk');
const withRenderer = process.argv.includes('--with-renderer');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (withRenderer) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  execFileSync(pnpm, ['--filter', '@shriii/kiosk', 'exec', 'vite', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(dist, 'main/index.js'),
  format: 'esm',
  external: ['electron', 'electron-updater'],
  // CommonJS dependencies (qrcode, yaml) may require Node builtins at runtime.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(dist, 'preload/index.cjs'),
  format: 'cjs',
  external: ['electron'],
});

// Renderer: the built kiosk app, or a placeholder page so the shell still boots and self-tests.
const rendererSrc = path.join(kioskApp, 'dist');
const rendererOut = path.join(dist, 'renderer');
let rendererSource = 'placeholder';
if (existsSync(path.join(rendererSrc, 'index.html'))) {
  cpSync(rendererSrc, rendererOut, { recursive: true, filter: (src) => !src.endsWith('.map') });
  rendererSource = 'frontend/apps/kiosk/dist';
} else {
  mkdirSync(rendererOut, { recursive: true });
  writeFileSync(
    path.join(rendererOut, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>SHRIII Kiosk</title></head><body style="background:#b8643c"></body></html>\n',
  );
  console.warn(
    '[build] frontend/apps/kiosk/dist not found: packaged a placeholder renderer (run with --with-renderer)',
  );
}

cpSync(path.join(root, 'static'), path.join(dist, 'static'), { recursive: true });
mkdirSync(path.join(dist, 'config'), { recursive: true });
cpSync(
  path.resolve(root, '..', '..', 'packages/outbox-sqlite/config/outbox-policy.yaml'),
  path.join(dist, 'config/outbox-policy.yaml'),
);

function hashDir(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    // Dirent types instead of stat-then-read on the same path; same (code-unit) order as before.
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else h.update(path.relative(dir, p).replaceAll('\\', '/')).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

let gitSha = null;
try {
  gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  gitSha = null;
}
writeFileSync(
  path.join(dist, 'build-info.json'),
  `${JSON.stringify({ version: pkg.version, gitSha, rendererSource, rendererHash: hashDir(rendererOut), builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`[build] dist ready (renderer: ${rendererSource})`);
