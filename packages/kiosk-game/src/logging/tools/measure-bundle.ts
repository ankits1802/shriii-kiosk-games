/**
 * Logger SDK bundle-size check (ENG-07 AC: "the SDK is under 25 kB gzipped").
 *
 * Bundles `sdk-entry.ts` with Vite (production mode, minified, tree-shaken, ES module) twice:
 * - `sdk`: the SDK's own code, with `dexie` external (Dexie is the IndexedDB storage engine the
 *   kiosk app ships anyway; it is shared, not part of the SDK);
 * - `sdk+dexie`: everything the SDK pulls in, Dexie included.
 * and reports raw/gzip sizes. Run: `node src/logging/tools/measure-bundle.ts` (exit 1 over budget).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** ENG-07 budget for the SDK's own code (gzip bytes). */
export const LOGGER_SDK_BUDGET_GZIP_BYTES = 25 * 1024;

export interface BundleSize {
  readonly label: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, 'sdk-entry.ts');

async function bundle(label: string, external: readonly string[]): Promise<BundleSize> {
  const { build } = await import('vite');
  const outDir = mkdtempSync(join(tmpdir(), 'shriii-sdk-size-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      mode: 'production',
      define: {
        'import.meta.env.DEV': 'false',
        'import.meta.env.PROD': 'true',
        'process.env.NODE_ENV': '"production"',
      },
      build: {
        outDir,
        emptyOutDir: true,
        write: true,
        minify: true,
        sourcemap: false,
        target: 'es2022',
        lib: { entry: ENTRY, formats: ['es'], fileName: () => 'sdk.js' },
        rollupOptions: { external: [...external] },
      },
    });
    let raw = Buffer.alloc(0);
    for (const f of readdirSync(outDir)) {
      if (f.endsWith('.js')) raw = Buffer.concat([raw, readFileSync(join(outDir, f))]);
    }
    return { label, rawBytes: raw.length, gzipBytes: gzipSync(raw, { level: 9 }).length };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Measure the SDK with and without Dexie. */
export async function measureLoggerBundle(): Promise<{
  readonly sdk: BundleSize;
  readonly withDexie: BundleSize;
}> {
  const sdk = await bundle('sdk', ['dexie']);
  const withDexie = await bundle('sdk+dexie', []);
  return { sdk, withDexie };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { sdk, withDexie } = await measureLoggerBundle();
  for (const s of [sdk, withDexie]) {
    console.log(`${s.label.padEnd(10)} raw ${kb(s.rawBytes).padStart(9)}  gzip ${kb(s.gzipBytes)}`);
  }
  const ok = sdk.gzipBytes <= LOGGER_SDK_BUDGET_GZIP_BYTES;
  console.log(
    `budget ${kb(LOGGER_SDK_BUDGET_GZIP_BYTES)} gzip (SDK code, dexie shared): ${ok ? 'OK' : 'OVER'}`,
  );
  if (!ok) process.exitCode = 1;
}
