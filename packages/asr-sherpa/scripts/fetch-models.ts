/**
 * Download the small models used by the real-model smoke test and the bake-off into ./models
 * (git-ignored). Usage: `pnpm --filter @shriii/asr-sherpa fetch-models`.
 *
 * - sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 (English KWS, ~18 MB, Apache-2.0)
 * - silero_vad.onnx (Silero VAD v5, ~2 MB, MIT)
 *
 * No Indic KWS model is published upstream; Indic grammars need a fine-tuned KWS model or the
 * bake-off's constrained CTC route (see tools/asr-bakeoff/PROTOCOL.md).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

interface Asset {
  readonly name: string;
  readonly url: string;
  readonly extract: boolean;
  readonly check: string;
  /** Pinned digest of the downloaded file (supply-chain check). */
  readonly sha256: string;
}

const ASSETS: readonly Asset[] = [
  {
    name: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    extract: true,
    check: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/tokens.txt',
    sha256: 'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',
  },
  {
    name: 'silero_vad.onnx',
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
    extract: false,
    check: 'silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  },
];

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  mkdirSync(ROOT, { recursive: true });
  for (const a of ASSETS) {
    if (existsSync(join(ROOT, a.check))) {
      console.log(`ok       ${a.name}`);
      continue;
    }
    console.log(`fetch    ${a.url}`);
    const data = await download(a.url);
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== a.sha256)
      throw new Error(`${a.name}: sha256 ${sha} does not match the pinned ${a.sha256}`);
    if (a.extract) {
      const archive = join(ROOT, `${a.name}.tar.bz2`);
      writeFileSync(archive, data);
      // relative paths + cwd: GNU tar would read "C:\..." as a remote host
      const r = spawnSync('tar', ['-xjf', `${a.name}.tar.bz2`], { cwd: ROOT, stdio: 'inherit' });
      rmSync(archive);
      if (r.status !== 0) throw new Error(`tar failed for ${a.name}`);
    } else {
      writeFileSync(join(ROOT, a.name), data);
    }
    console.log(`saved    ${a.name} (sha256 ${sha})`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
