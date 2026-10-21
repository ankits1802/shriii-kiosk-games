import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ParadigmConfigError, ParadigmStateError } from '../common.ts';
import {
  assertNoTrueOutcome,
  cryptoEntropy,
  type EntropySource,
  FORBIDDEN_TRUE_OUTCOME_KEYS,
  PrivateReportTrial,
  parseFaceCode,
  reportVocabulary,
  uniformFace,
} from '../private-report.ts';

/** Deterministic entropy for tests: yields the given words in order. */
function scripted(words: readonly number[]): EntropySource {
  let i = 0;
  return {
    fill(out) {
      for (let k = 0; k < out.length; k += 1) out[k] = (words[i++ % words.length] ?? 0) >>> 0;
    },
  };
}

/** Every primitive reachable from an object (own props, deep). */
function reachableValues(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'function') return; // code, not data
    if (v === null || typeof v !== 'object') {
      out.push(v);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    for (const key of Reflect.ownKeys(v as object)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (d && 'value' in d) visit(d.value);
    }
  };
  visit(root);
  return out;
}

describe('uniform faces', () => {
  it('maps words to faces and rejects the biased tail', () => {
    expect(uniformFace(scripted([0]), 6)).toBe(1);
    expect(uniformFace(scripted([5]), 6)).toBe(6);
    // 2^32 - (2^32 mod 6) = 4294967292: words >= this are rejected.
    expect(uniformFace(scripted([4294967295, 4294967292, 13]), 6)).toBe(2);
    expect(() => uniformFace(scripted([0]), 1)).toThrow(ParadigmConfigError);
  });

  it('crypto entropy gives every face with a roughly uniform frequency', () => {
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 6000; i += 1) counts[uniformFace(cryptoEntropy, 6) - 1] += 1;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });
});

describe('PrivateReportTrial (integrity_dice_mode = a)', () => {
  it('never retains the true roll: it reaches only the render callback (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xfffffff0 }),
        fc.integer({ min: 1, max: 6 }),
        (word, reported) => {
          const trueFace = (word % 6) + 1;
          const trial = new PrivateReportTrial({
            context: 'private_dice',
            reportIndex: 7,
            faces: 6,
            entropy: scripted([word]),
          });
          let shown: number | null = null;
          trial.reveal((face) => {
            shown = face;
          });
          expect(shown).toBe(trueFace);
          // The trial object holds no copy of the face (its only numbers are faces=6 and reportIndex=7).
          const nums = reachableValues(trial).filter((v) => typeof v === 'number');
          expect(nums.sort()).toEqual([6, 7]);
          expect(JSON.stringify(trial)).not.toMatch(/true|roll|outcome/i);
          const payload = trial.report(reported, { headset: true, onlookerReported: false });
          expect(payload).toEqual({
            report_context: 'private_dice',
            report_index: 7,
            reported_value: reported,
            headset: true,
            onlooker_reported: false,
          });
          expect(() => assertNoTrueOutcome(payload)).not.toThrow();
          // After the report the object still holds nothing but its configuration.
          expect(
            reachableValues(trial)
              .filter((v) => typeof v === 'number')
              .sort(),
          ).toEqual([6, 7]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('enforces reveal -> report order and the value range', () => {
    const t = new PrivateReportTrial({
      context: 'luck_token',
      reportIndex: 0,
      faces: 6,
      entropy: scripted([2]),
    });
    expect(() => t.report(3, { headset: false, onlookerReported: false })).toThrow(
      ParadigmStateError,
    );
    t.reveal(() => undefined);
    expect(() => t.reveal(() => undefined)).toThrow(ParadigmStateError);
    expect(() => t.report(7, { headset: false, onlookerReported: false })).toThrow(
      ParadigmStateError,
    );
    expect(t.report(6, { headset: false, onlookerReported: false }).report_context).toBe(
      'luck_token',
    );
    expect(t.state).toBe('reported');
  });

  it('is independent of any seeded stream: same config, different entropy -> different faces', () => {
    const faces = new Set<number>();
    for (let w = 0; w < 6; w += 1) {
      const t = new PrivateReportTrial({
        context: 'private_dice',
        reportIndex: 0,
        faces: 6,
        entropy: scripted([w]),
      });
      t.reveal((f) => faces.add(f));
    }
    expect(faces.size).toBe(6);
  });

  it('guards payloads against true-outcome keys and parses face codes', () => {
    for (const k of FORBIDDEN_TRUE_OUTCOME_KEYS)
      expect(() => assertNoTrueOutcome({ nested: { [k]: 3 } })).toThrow(ParadigmStateError);
    expect(reportVocabulary(6)).toEqual([
      'face_1',
      'face_2',
      'face_3',
      'face_4',
      'face_5',
      'face_6',
    ]);
    expect(parseFaceCode('face_4', 6)).toBe(4);
    expect(parseFaceCode('face_9', 6)).toBeNull();
    expect(parseFaceCode(null, 6)).toBeNull();
  });
});
