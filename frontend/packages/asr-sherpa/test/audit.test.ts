/**
 * Static audit of the adapter sources (VOX-01, VOX-04, PRV-03): no TTS, no persistence or network
 * sinks for audio, and no top-k alternatives in the adapter's output.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Code only: block and line comments removed (doc comments may describe what is forbidden). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sources = files(SRC).map((p) => ({ p, text: stripComments(readFileSync(p, 'utf8')) }));

describe('source audit', () => {
  it.each([
    ['TTS', /OfflineTts|speechSynthesis|SpeechSynthesis/],
    ['file writes', /writeFile|createWriteStream|appendFile/],
    ['browser storage', /localStorage|sessionStorage|indexedDB/],
    ['network sinks', /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/],
    ['MediaRecorder', /MediaRecorder/],
    ['top-k alternatives', /alternatives|nbest|n_best|topK/i],
  ])('has no %s', (_label, pattern) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.p);
    expect(hits).toEqual([]);
  });
});
