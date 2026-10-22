import { describe, expect, it } from 'vitest';
import {
  clippingEvents,
  evaluateTake,
  integratedLoudness,
  kWeighting,
  measureTake,
  overallStatus,
  parseWav,
  samplePeak,
  toDb,
  truePeak,
} from './audio-qc';
import { coverage, itcTrail, progressFraction, transitionOptions } from './catalogue-model';
import type { TranslationEntry } from './content-types';
import { loadContentSnapshot, sourceHash } from './load-content.server';

function sine(freq: number, amp: number, seconds: number, fs: number, phase = 0): Float32Array {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return out;
}

function wav16(samples: Float32Array, fs: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true);
  }
  return buf;
}

describe('BS.1770 loudness', () => {
  it('reproduces the ITU 48 kHz K-weighting coefficients', () => {
    const [shelf, hp] = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10);
  });

  it('measures a full-scale 997 Hz mono sine at −3.01 LUFS', () => {
    for (const fs of [48000, 44100]) {
      const lufs = integratedLoudness({ sampleRate: fs, channels: [sine(997, 1, 5, fs)] });
      expect(lufs).toBeCloseTo(-3.01, 1);
    }
  });

  it('scales with amplitude and gates silence', () => {
    const fs = 48000;
    const quiet = integratedLoudness({
      sampleRate: fs,
      channels: [sine(997, 10 ** (-20 / 20), 3, fs)],
    });
    expect(quiet).toBeCloseTo(-23.01, 1);
    expect(integratedLoudness({ sampleRate: fs, channels: [new Float32Array(fs * 2)] })).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(integratedLoudness({ sampleRate: fs, channels: [new Float32Array(100)] })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe('peaks and clipping', () => {
  it('finds inter-sample peaks above the sample peak', () => {
    const fs = 48000;
    const x = sine(fs / 4, 1, 0.1, fs, Math.PI / 4);
    expect(toDb(samplePeak([x]))).toBeCloseTo(-3.01, 1);
    expect(toDb(truePeak([x]))).toBeGreaterThan(-0.5);
  });

  it('counts clipped runs', () => {
    const x = new Float32Array([0, 1, 1, 1, 0, -1, -1, 0, 1, 1, 1, 1]);
    expect(clippingEvents([x], 0.999, 3)).toBe(2);
  });
});

describe('WAV parsing and take evaluation', () => {
  const qc = loadContentSnapshot().qc;

  it('parses 16-bit PCM', () => {
    const audio = parseWav(wav16(sine(440, 0.5, 0.5, 44100), 44100));
    expect(audio.sampleRate).toBe(44100);
    expect(audio.channels[0]?.length).toBe(22050);
    expect(samplePeak(audio.channels)).toBeCloseTo(0.5, 2);
  });

  it('rejects non-WAV input', () => {
    expect(() => parseWav(new ArrayBuffer(16))).toThrow(/RIFF/);
  });

  it('passes a delivered-level clip and flags a hot, long one', () => {
    const fs = 48000;
    const amp = 10 ** ((qc.targetLufs + 3.01) / 20);
    const good = measureTake(parseWav(wav16(sine(997, amp, 2, fs), fs)), qc);
    const goodChecks = evaluateTake(good, qc, { targetDurationMs: 2000 });
    expect(overallStatus(goodChecks)).toBe('pass');

    const hot = measureTake(parseWav(wav16(sine(997, 1, 4, fs), fs)), qc);
    const hotChecks = evaluateTake(hot, qc, { targetDurationMs: 2000 });
    const status = Object.fromEntries(hotChecks.map((c) => [c.id, c.status]));
    expect(status.loudness).toBe('fail');
    expect(status.duration_target).toBe('warn');
    expect(status.ratio_to_source).toBe(qc.longClipIsError ? 'fail' : 'warn');
  });
});

describe('content snapshot', () => {
  const snap = loadContentSnapshot();

  it('loads the catalogue, workflow, translations and QC thresholds without problems', () => {
    expect(snap.problems).toEqual([]);
    expect(snap.lines.length).toBeGreaterThan(50);
    expect(snap.languages).toContain(snap.referenceLanguage);
    expect(Object.keys(snap.translations).sort()).toEqual(
      snap.workflow.languages.map((l) => l.tag).sort(),
    );
    expect(Number.isFinite(snap.qc.targetLufs)).toBe(true);
    expect(snap.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
  });

  it('matches the tools/i18n source hash', () => {
    expect(sourceHash('Namaste! Come and play a short game at the market fair.')).toBe(
      'd6c55d5e6c795c85',
    );
    expect(sourceHash('  Namaste!  Come and play a short game at the market fair. ')).toBe(
      'd6c55d5e6c795c85',
    );
  });

  it('summarises coverage per language', () => {
    const cov = coverage(snap);
    const ref = cov.find((c) => c.isReference);
    expect(ref?.missingTranslation).toBe(0);
    for (const c of cov.filter((x) => !x.isReference)) {
      const counted =
        Object.values(c.byTranslation).reduce((a, b) => a + b, 0) + c.missingTranslation;
      expect(counted).toBe(c.total);
      // Pack readiness uses the shriii_i18n base: lines this language records.
      const file = snap.translations[c.language];
      const entries = Object.values(file?.entries ?? {});
      const base = entries.filter((e) => e.record).length + c.missingTranslation;
      expect(c.toRecord).toBe(base);
      const prodStatuses = snap.workflow.packEligibility.production ?? [];
      const expected = entries.filter(
        (e) => e.record && !e.stale && prodStatuses.includes(e.status),
      ).length;
      expect(c.eligible.production ?? 0).toBe(expected);
    }
  });

  it('exports an ITC trail per language', () => {
    const lang = snap.workflow.languages[0]?.tag ?? 'hi-IN';
    const rows = itcTrail(snap, lang);
    expect(rows.length).toBeGreaterThanOrEqual(
      Object.keys(snap.translations[lang]?.entries ?? {}).length,
    );
  });
});

describe('ITC transitions', () => {
  const wf = loadContentSnapshot().workflow;
  const entry = (status: string, extra: Partial<TranslationEntry> = {}): TranslationEntry => ({
    id: 'x',
    status,
    text: 'text',
    backTranslation: '',
    registerNote: '',
    translatorNote: '',
    record: true,
    stale: false,
    history: [],
    ...extra,
  });

  it('offers the next step and flagging, with the sign-off role', () => {
    const opts = transitionOptions(wf, entry('forward_translated'));
    expect(opts.map((o) => o.to.id)).toEqual(['back_translated', 'flagged_for_revision']);
    expect(opts[0]?.signoffRole).toBe('back_translator');
    expect(opts[0]?.missing).toEqual(['back_translation']);
    expect(opts[1]?.commentRequired).toBe(true);
  });

  it('bars the forward translator from signing the back-translation', () => {
    const e = entry('forward_translated', {
      history: [
        {
          fromStatus: 'draft_machine_needs_native_review',
          toStatus: 'forward_translated',
          by: 'A. Kumar',
          role: 'translator',
          date: '2026-10-01',
          comment: '',
          source: 'manual',
        },
      ],
    });
    expect(transitionOptions(wf, e)[0]?.barredSigners).toEqual(['A. Kumar']);
  });

  it('ranks progress from machine draft to approved', () => {
    expect(progressFraction(wf, 'draft_machine_needs_native_review')).toBe(0);
    expect(progressFraction(wf, 'approved')).toBe(1);
    expect(progressFraction(wf, 'flagged_for_revision')).toBeNull();
  });
});
