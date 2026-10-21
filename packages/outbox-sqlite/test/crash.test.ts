/**
 * Crash safety (KSK-07 ACs): a writer process is killed (SIGKILL / TerminateProcess) mid-write many
 * times; after every kill the database passes `integrity_check`, every session's seqs are gapless,
 * every event the writer reported as committed is present, and all payloads decrypt.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKek,
  generateRecipientKeyPair,
  RecipientKeyRing,
  toHex,
} from '@shriii/session-crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { openNodeSqlite } from '../src/driver.ts';
import { SqliteOutbox } from '../src/sqlite-outbox.ts';
import { tempDir, uuidv7 } from './helpers.ts';

const writer = fileURLToPath(new URL('./fixtures/crash-writer.ts', import.meta.url));
const t = tempDir();
afterAll(() => t.cleanup());

/** Run the writer until it reported `killAfter` lines, then kill it; returns committed seqs. */
function runAndKill(
  args: string[],
  killAfter: number,
): Promise<{ committed: Map<string, number>; lines: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writer, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const committed = new Map<string, number>();
    let buffer = '';
    let lines = 0;
    let killed = false;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        i = buffer.indexOf('\n');
        const [sid, seq] = line.split(' ');
        if (sid && seq !== undefined && line !== 'ready' && line !== 'batch') {
          committed.set(sid, Math.max(committed.get(sid) ?? -1, Number(seq)));
        }
        lines += 1;
        if (!killed && lines >= killAfter) {
          killed = true;
          child.kill('SIGKILL');
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!killed) reject(new Error(`writer exited early (${code ?? signal}): ${stderr}`));
      else resolve({ committed, lines });
    });
  });
}

describe('crash safety under SIGKILL', () => {
  it('stays consistent and gapless across 12 random kills', async () => {
    const dbPath = join(t.dir, 'crash.db');
    const kek = generateKek();
    const backend = generateRecipientKeyPair('backend-1');
    const sessions = Array.from({ length: 4 }, () => uuidv7());
    const args = [dbPath, toHex(kek), toHex(backend.publicKey), sessions.join(',')];
    const reported = new Map<string, number>();
    let seed = 12345;
    for (let round = 0; round < 12; round += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const killAfter = 30 + (seed % 400);
      const { committed } = await runAndKill([...args, String(seed)], killAfter);
      for (const [sid, seq] of committed) reported.set(sid, Math.max(reported.get(sid) ?? -1, seq));

      const outbox = new SqliteOutbox({
        kioskId: 'kiosk-crash',
        path: dbPath,
        encryption: {
          mode: 'sealed',
          kek,
          recipients: new RecipientKeyRing([
            { kid: 'backend-1', publicKey: backend.publicKey, notBefore: 0, notAfter: null },
          ]),
        },
      });
      try {
        expect(outbox.integrityCheck()).toEqual([]);
        for (const sid of sessions) {
          const next = await outbox.nextSeq(sid);
          // Every reported commit survived the kill (at most the in-flight event is lost).
          expect(next).toBeGreaterThan(reported.get(sid) ?? -1);
          const raw = openNodeSqlite(dbPath);
          const seqs = (
            raw.prepare('SELECT seq FROM events WHERE session_id = ? ORDER BY seq').all(sid) as {
              seq: number;
            }[]
          ).map((r) => r.seq);
          raw.close();
          // Rows may have been acknowledged (still stored until the grace purge): all seqs < next
          // are present exactly once, i.e. the per-session sequence is gapless.
          expect(seqs).toEqual(Array.from({ length: next }, (_, i) => i));
          const events = (await outbox.sessionEvents(sid)) as { seq: number; session_id: string }[];
          expect(events.map((e) => e.seq)).toEqual(seqs);
          expect(events.every((e) => e.session_id === sid)).toBe(true);
        }
        // Open batches left by a kill are still consistent: rebuilding or reusing works.
        const stats = await outbox.stats();
        expect(stats.inflightEvents === 0 || stats.openBatches > 0).toBe(true);
        expect(await outbox.nextBatch()).not.toBeUndefined();
      } finally {
        outbox.close();
      }
    }
    expect([...reported.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  }, 180_000);
});
