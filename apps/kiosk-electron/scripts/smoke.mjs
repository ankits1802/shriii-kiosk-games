#!/usr/bin/env node
/**
 * End-to-end smoke test of the real Electron runtime (KSK-01 ACs): launches the app in self-test
 * mode with a fresh profile, a sealed (encrypted) outbox and the virtual printer, then checks the
 * JSON report written by `main/selftest.ts`.
 *
 *   node scripts/smoke.mjs                          # unpacked: electron . (needs `node scripts/build.mjs`)
 *   node scripts/smoke.mjs --exe "release/win-unpacked/SHRIII Kiosk.exe"   # packed app
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeArg = process.argv.indexOf('--exe');
const exe = exeArg > 0 ? path.resolve(root, process.argv[exeArg + 1]) : null;

const work = mkdtempSync(path.join(tmpdir(), 'kiosk-smoke-'));
const { publicKey } = generateKeyPairSync('x25519');
const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const keysFile = path.join(work, 'recipient-keys.json');
writeFileSync(
  keysFile,
  JSON.stringify([
    { kid: 'smoke-1', public_key: rawPub.toString('base64'), not_before: '2020-01-01T00:00:00Z' },
  ]),
);
const resultFile = path.join(work, 'result.json');
const prints = path.join(work, 'prints');

const env = {
  ...process.env,
  SHRIII_KIOSK_SELFTEST: resultFile,
  SHRIII_KIOSK_USER_DATA: path.join(work, 'user-data'),
  SHRIII_KIOSK_ID: 'kiosk-smoke-01',
  SHRIII_RECIPIENT_KEYS: keysFile,
  SHRIII_PRINTER: `virtual:${prints}`,
  ELECTRON_ENABLE_LOGGING: '0',
};
delete env.ELECTRON_RUN_AS_NODE;

const require = createRequire(import.meta.url);
const command = exe ?? require('electron');
// Extra Chromium switches after `--` (e.g. `-- --no-sandbox` inside containers).
const dashdash = process.argv.indexOf('--');
const extraArgs = dashdash > 0 ? process.argv.slice(dashdash + 1) : [];
const args = [...(exe ? [] : [root]), ...extraArgs];
const started = Date.now();
const run = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120_000 });
const elapsed = Date.now() - started;

let ok = false;
try {
  if (!existsSync(resultFile)) {
    console.error(run.stdout, run.stderr);
    throw new Error(`no self-test report (exit ${run.status}, signal ${run.signal})`);
  }
  const report = JSON.parse(readFileSync(resultFile, 'utf8'));
  for (const c of report.checks)
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`,
    );
  console.log(
    `electron ${report.electron} / node ${report.node}  packaged=${report.packaged}  outbox=${report.encryption}/${report.journal}  ${elapsed} ms`,
  );
  console.log(
    `renderer console errors over the whole run (CSP probes included): ${report.consoleErrorsTotal}`,
  );
  const pngs = existsSync(prints) ? readdirSync(prints).filter((f) => f.endsWith('.png')) : [];
  console.log(`virtual printer pages: ${pngs.length}`);
  const dbExists = existsSync(path.join(work, 'user-data', 'outbox.db'));
  ok =
    report.ok && run.status === 0 && pngs.length >= 1 && report.encryption === 'sealed' && dbExists;
} catch (err) {
  console.error(String(err));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
