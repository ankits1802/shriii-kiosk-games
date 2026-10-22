import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FrameRow } from '../api/snapshot-frame';
import type { EnrollmentOut, MatchedRecord, OccasionRow, RunOut, SessionOut } from '../api/types';
import {
  buildPlan,
  buildSubmission,
  expectedResponse,
  isValidValue,
  itemWording,
  parseLicensedSource,
  progress,
  submissionIssues,
} from './administration';
import {
  groupMeans,
  hedgesG,
  keyedComposite,
  outliers,
  pairedOccasions,
  trajectorySummary,
  versionComparison,
} from './analytics';
import { checkImport, hasErrors, parseCsv, suggestMapping } from './import-mapping';
import {
  COMPARISONS,
  cvComparisons,
  holdoutComparisons,
  incrementalSummary,
  registryMetrics,
} from './models';
import {
  cellLabel,
  countBy,
  enrollmentBreakdowns,
  parseCellKey,
  quotaProgress,
  sortOrdinal,
  summariseMatches,
  summariseSessions,
} from './overview';
import { buildReport, evidenceExportColumns, reportHtml, SECTION_IDS, tableCsv } from './report';
import {
  compositeReliabilityRows,
  constructOf,
  constructsWithEvidence,
  criterionCorrelations,
  difRows,
  exclusionCount,
  flattenResults,
  invarianceSummaries,
  latestGateEvaluation,
  latestRuns,
  mtmmCellKind,
  mtmmMatrices,
  ownVersusDiscriminant,
  provenanceOf,
  retestRows,
  traitGateDecisions,
} from './results';
import { retestCandidates, retestPair, sha256Hex, windowCounts, windowState } from './studies';

// ---------------------------------------------------------------- fixtures

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../e2e/fixtures/engine-results.json', import.meta.url)),
    'utf8',
  ),
) as {
  analyses: Record<string, RunOut['results']>;
  gate_evaluation: { trait_gates: Record<string, unknown>[] };
};
const BSCS = JSON.parse(
  JSON.stringify(
    // A small inline instrument definition shaped like content/instruments/*.yaml.
    {
      instrument_id: 'demo',
      version: '1.0.0',
      response_scale: {
        type: 'likert',
        min: 1,
        max: 5,
        anchors: [1, 2, 3, 4, 5].map((v) => ({ value: v, label_key: `a${v}` })),
      },
      administration: {
        modes: ['self', 'read_aloud'],
        audio_assisted: true,
        estimated_minutes: 3,
        public_kiosk_allowed: false,
      },
      items: [
        {
          item_id: 'demo.i01',
          number: 1,
          item_text: '[licensed]',
          block: 'X',
          reverse_keyed: false,
          attention_check: false,
          subscales: ['total'],
        },
        {
          item_id: 'demo.i02',
          number: 2,
          item_text: '[licensed]',
          block: 'A',
          reverse_keyed: true,
          attention_check: false,
          subscales: ['total'],
        },
        {
          item_id: 'demo.i03',
          number: 3,
          item_text: '[licensed]',
          block: 'B',
          reverse_keyed: false,
          attention_check: false,
          subscales: ['total'],
        },
        {
          item_id: 'demo.i04',
          number: 4,
          item_text: '[licensed]',
          block: 'X',
          reverse_keyed: false,
          attention_check: true,
          subscales: ['failed_count'],
        },
        {
          item_id: 'demo.p1',
          number: 5,
          item_text: '[task]',
          block: 'X',
          reverse_keyed: false,
          attention_check: false,
          subscales: ['excess_moves'],
          measures: ['moves', 'solved_within_limit'],
        },
      ],
    },
  ),
) as Record<string, unknown>;

function run(analysis: string, extra: Partial<RunOut> = {}): RunOut {
  return {
    run_id: `run-${analysis}`,
    snapshot_id: 'snap',
    analysis,
    params: {},
    hypothesis_ids: [],
    confirmatory: false,
    analysis_plan_id: null,
    status: 'succeeded',
    job_id: null,
    engine: 'shriii_validation-0.2.0',
    manifest: {},
    error: null,
    created_by: 't',
    created_at: '2026-10-20T10:00:00Z',
    finished_at: '2026-10-20T11:00:00Z',
    results: FIXTURE.analyses[analysis] ?? [],
    ...extra,
  } as RunOut;
}
const RUNS = Object.keys(FIXTURE.analyses).map((a) => run(a));
const ROWS = flattenResults(RUNS);

function session(over: Partial<SessionOut>): SessionOut {
  return {
    session_id: 's',
    kiosk_id: 'k',
    site_id: null,
    site_mode: 'supervised',
    mode: null,
    language: 'hi-IN',
    battery_arm: null,
    pathway: 'B',
    slot_form: null,
    participant_pid: 'P1',
    study_id: 'st',
    occasion_id: 'T1',
    status: 'completed',
    end_reason: 'completed',
    event_count: 500,
    last_seq_received: 500,
    max_contiguous_seq: 500,
    valid_for_report: false,
    synthetic: false,
    started_at: '2026-10-01T10:00:00Z',
    completed_at: '2026-10-01T10:15:00Z',
    ...over,
  } as SessionOut;
}

// ---------------------------------------------------------------- overview

describe('overview aggregates', () => {
  it('parses quota cell keys and drops wildcards', () => {
    expect(
      parseCellKey('language=hi-IN|age_band=*|gender=female|edu_band=*|literacy_band=low'),
    ).toEqual({
      language: 'hi-IN',
      gender: 'female',
      literacy_band: 'low',
    });
    expect(parseCellKey(null)).toEqual({});
    expect(cellLabel({ language: 'ta-IN', age_band: '*' })).toBe('language ta-IN');
    expect(cellLabel({ language: '*' })).toBe('Any participant');
  });

  it('counts with a missing label and sorts by count', () => {
    const rows = countBy(['a', 'b', 'a', null], (x) => x);
    expect(rows[0]).toMatchObject({ key: 'a', count: 2, share: 0.5 });
    expect(rows.find((r) => r.key === 'not recorded')?.count).toBe(1);
  });

  it('orders ordinal bands naturally', () => {
    const rows = sortOrdinal(
      'age_band',
      countBy(['50+', '18-24', '25-34', '18-24'], (x) => x),
    );
    expect(rows.map((r) => r.key)).toEqual(['18-24', '25-34', '50+']);
  });

  it('summarises sessions: completion over ended sessions, gaps, durations', () => {
    const s = summariseSessions([
      session({}),
      session({ status: 'abandoned', end_reason: 'walkaway', completed_at: null }),
      session({ status: 'active', end_reason: null, completed_at: null }),
      session({ max_contiguous_seq: 400, synthetic: true }),
    ]);
    expect(s.completed).toBe(2);
    expect(s.completionRate).toBeCloseTo(2 / 3);
    expect(s.abandonmentRate).toBeCloseTo(1 / 3);
    expect(s.seqGaps).toBe(1);
    expect(s.synthetic).toBe(1);
    expect(s.durationsMinutes).toEqual([15, 15]);
    expect(s.endReasons.map((r) => r.key).sort()).toEqual(['completed', 'walkaway']);
  });

  it('breaks enrolments down by cell field, arm and block', () => {
    const e = (cell: string, status = 'enrolled') =>
      ({
        study_id: 's',
        pid: cell,
        cohort_id: 'main',
        cell_key: cell,
        arm_id: 'B_fixed',
        criterion_block: 'A',
        status,
        created_at: '',
      }) as EnrollmentOut;
    const b = enrollmentBreakdowns([
      e('language=hi-IN|age_band=18-24|gender=*|edu_band=*|literacy_band=*'),
      e('language=ta-IN|age_band=50+|gender=*|edu_band=*|literacy_band=*', 'withdrawn'),
    ]);
    expect(b.total).toBe(2);
    expect(b.withdrawn).toBe(1);
    expect(b.byField.language.map((r) => r.key).sort()).toEqual(['hi-IN', 'ta-IN']);
    expect(b.byField.age_band.map((r) => r.key)).toEqual(['18-24', '50+']);
  });

  it('summarises matching and caps quota progress at each target', () => {
    const m = (pid: string, occ: string, game: boolean, crit: boolean, issues: string[] = []) =>
      ({
        pid,
        occasion_id: occ,
        session_ids: [],
        has_game: game,
        has_criterion: crit,
        instrument_versions: {},
        game_versions: {},
        issues,
        algorithm_version: 'x',
      }) as MatchedRecord;
    const s = summariseMatches([
      m('a', 'T1', true, true),
      m('a', 'T2', true, true),
      m('b', 'T1', true, false, ['no_criterion']),
    ]);
    expect(s.matched).toBe(2);
    expect(s.retestPairs).toBe(1);
    expect(s.gameOnly).toBe(1);
    expect(s.issues[0]).toMatchObject({ key: 'no_criterion', count: 1 });
    const q = quotaProgress([
      { cell_key: 'a', cell: {}, target: 10, enrolled: 15, full: true },
      { cell_key: 'b', cell: {}, target: 10, enrolled: 5, full: false },
    ]);
    expect(q).toMatchObject({ target: 20, enrolled: 15, fullCells: 1, share: 0.75 });
  });
});

// ---------------------------------------------------------------- validation results

describe('validation results (real engine output)', () => {
  it('keeps the latest succeeded run per analysis', () => {
    const older = run('reliability', { run_id: 'old', finished_at: '2026-10-01T00:00:00Z' });
    const failed = run('reliability', {
      run_id: 'failed',
      status: 'failed',
      finished_at: '2026-10-30T00:00:00Z',
    });
    const latest = latestRuns([older, failed, run('reliability')]);
    expect(latest.get('reliability')?.run_id).toBe('run-reliability');
  });

  it('assigns constructs to rows', () => {
    const cs = constructsWithEvidence(ROWS);
    expect(cs).toEqual(expect.arrayContaining(['self_control', 'decisiveness', 'persistence']));
    const fairnessHyp = ROWS.find(
      (r) => r.analysis === 'fairness' && r.subject_kind === 'hypothesis',
    );
    expect(fairnessHyp && constructOf(fairnessHyp)).toBeTruthy();
  });

  it('slices criterion correlations, retest and composite reliability by construct', () => {
    const corr = criterionCorrelations(ROWS, 'self_control');
    const primary = corr.find((c) => c.hypothesisId === 'h1.self_control' && c.language === null);
    expect(primary?.criterion).toBe('bscs.total');
    expect(primary?.row.ci_low).toBeLessThan(primary?.row.estimate as number);
    const retest = retestRows(ROWS, 'self_control');
    expect(retest[0]?.subgroup).toEqual({});
    expect(retest.length).toBeGreaterThanOrEqual(3);
    expect(compositeReliabilityRows(ROWS, 'self_control')[0]?.metric).toBe('omega_total');
  });

  it('reads the MTMM matrix and classifies Campbell–Fiske blocks', () => {
    const [m] = mtmmMatrices(ROWS);
    expect(m).toBeDefined();
    if (!m) return;
    const g = m.variables.indexOf('game:self_control');
    const s = m.variables.indexOf('self_report:bscs.total');
    const other = m.variables.indexOf('game:persistence');
    expect(mtmmCellKind(m, g, g)).toBe('reliability');
    expect(mtmmCellKind(m, g, s)).toBe('validity');
    expect(mtmmCellKind(m, g, other)).toBe('heterotrait_monomethod');
    const ovd = ownVersusDiscriminant(m, 'self_control');
    expect(ovd.own).toBeGreaterThan(0.3);
    expect(Math.abs(ovd.discriminant[0]?.r ?? 1)).toBeLessThan(ovd.own as number);
  });

  it('summarises invariance steps and DIF rows', () => {
    const inv = invarianceSummaries(ROWS, 'decisiveness');
    expect(inv[0]?.grouping).toBe('language');
    expect(inv[0]?.steps.map((s) => s.metric)).toEqual([
      'cfi_configural',
      'cfi_metric',
      'cfi_scalar',
    ]);
    expect(difRows(ROWS, 'self_control').length).toBeGreaterThan(0);
  });

  it('reads exclusions and provenance', () => {
    const row = ROWS.find((r) => r.metric === 'icc_a1');
    expect(row && exclusionCount(row)).toBe(0);
    expect(
      provenanceOf({
        provenance: {
          snapshot_id: 's',
          algorithm_version: '0.2.0',
          dictionary_sha256: { A: 'abcdef123456789', B: 'fedcba' },
        },
      }),
    ).toMatchObject({
      snapshotId: 's',
      algorithmVersion: '0.2.0',
      dictionarySha: 'abcdef123456, fedcba',
    });
  });

  it('reads trait-gate decisions from a gate_evaluation run', () => {
    const gate = run('gate_evaluation', {
      results: FIXTURE.gate_evaluation.trait_gates.map((d) => ({
        subject: String(d.trait),
        subject_kind: 'trait_gate',
        metric: 'trait_gate_status',
        estimate: null,
        ci_low: null,
        ci_high: null,
        ci_level: null,
        n: null,
        threshold: null,
        passed: false,
        hypothesis_id: null,
        exploratory: false,
        method: 'gates',
        subgroup: { language: d.language, pathway: d.pathway },
        details: d,
      })),
    });
    expect(latestGateEvaluation([gate, ...RUNS])?.run_id).toBe('run-gate_evaluation');
    const decisions = traitGateDecisions(gate).filter((d) => d.trait === 'self_control');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.rules.B1).toBeDefined();
    expect(decisions[0]?.evaluatedStatus).toBe('unvalidated');
  });
});

// ---------------------------------------------------------------- models

describe('predictive comparisons', () => {
  const inc = FIXTURE.analyses.incremental_validity ?? [];
  it('reads the four grouped-CV comparisons per model', () => {
    const cv = cvComparisons(inc);
    expect(new Set(cv.map((r) => r.comparison))).toEqual(new Set(COMPARISONS.map((c) => c.key)));
    const primary = cv.find((r) => r.comparison === 'criterion_from_game' && r.primary);
    expect(primary?.model).toBe('ridge');
    expect(primary?.mae.estimate).toBeGreaterThan(0);
    expect(primary?.r2.low).toBeLessThanOrEqual(primary?.r2.estimate as number);
  });

  it('reads holdout and incremental validity', () => {
    expect(holdoutComparisons(inc)).toHaveLength(4);
    const s = incrementalSummary(inc);
    expect(s.deltaCvR2.estimate).not.toBeNull();
    expect(s.byModel.map((m) => m.model)).toEqual(['ridge', 'random_forest']);
    expect(s.hierarchical.map((h) => h.block)).toEqual(['battery', 'game']);
  });

  it('groups registry evaluations into CV and holdout', () => {
    const m = registryMetrics([
      {
        training_run_id: 't',
        split: 'cv',
        metric: 'r2',
        value: 0.2,
        sd: 0.05,
        n: 300,
        details: { ci_low: 0.1, ci_high: 0.3 },
      },
      {
        training_run_id: 't',
        split: 'holdout',
        metric: 'r2',
        value: 0.25,
        sd: null,
        n: 50,
        details: { ci_low: 0.05, ci_high: 0.4 },
      },
    ]);
    expect(m.cv.r2).toMatchObject({ value: 0.2, sd: 0.05, low: 0.1 });
    expect(m.holdout.r2).toMatchObject({ value: 0.25, n: 50, high: 0.4 });
  });
});

// ---------------------------------------------------------------- analytics

describe('exploratory analytics', () => {
  const rows: FrameRow[] = [
    ...Array.from({ length: 20 }, (_, i) => ({
      research_id: `r${i}`,
      occasion_id: 'T1',
      language: i % 2 ? 'hi-IN' : 'ta-IN',
      v: i,
      app_version: i < 10 ? '0.4.0' : '0.4.1',
    })),
    { research_id: 'out', occasion_id: 'T1', language: 'hi-IN', v: 200, app_version: '0.4.1' },
    ...Array.from({ length: 10 }, (_, i) => ({
      research_id: `r${i}`,
      occasion_id: 'T2',
      language: 'x',
      v: i + 1,
      app_version: '0.4.0',
    })),
  ];
  it('flags Tukey and robust outliers', () => {
    const o = outliers(
      rows.filter((r) => r.occasion_id === 'T1'),
      'v',
    );
    expect(o?.tukey).toBe(1);
    expect(o?.flaggedIds).toEqual(['out']);
    expect(outliers([], 'v')).toBeNull();
  });

  it('computes group means with t intervals and Hedges g', () => {
    const g = groupMeans(
      rows.filter((r) => r.occasion_id === 'T1' && r.research_id !== 'out'),
      'v',
      'app_version',
    );
    expect(g.map((x) => x.group)).toEqual(['0.4.0', '0.4.1']);
    expect(g[0]?.mean).toBeCloseTo(4.5);
    expect(g[0]?.lower).toBeLessThan(4.5);
    expect(hedgesG([1, 2, 3, 4], [1, 2, 3, 4]).g).toBeCloseTo(0);
    expect(versionComparison(rows, 'v', 'app_version')[0]).toMatchObject({
      reference: '0.4.0',
      focal: '0.4.1',
    });
  });

  it('pairs occasions and summarises change', () => {
    const p = pairedOccasions(rows, 'v', 'T1', 'T2');
    expect(p).toHaveLength(10);
    const t = trajectorySummary(p);
    expect(t.meanChange).toBeCloseTo(1);
    expect(t.improved).toBe(10);
  });

  it('builds a sign-keyed display composite', () => {
    const c = keyedComposite(
      [
        { a: 1, b: 3 },
        { a: 2, b: 2 },
        { a: 3, b: 1 },
      ],
      [
        { column: 'a', reverse: false },
        { column: 'b', reverse: true },
      ],
    );
    expect(c[0]).toBeCloseTo(-1);
    expect(c[2]).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------- administration

describe('researcher-administered mode', () => {
  it('plans items: other rotating forms are planned missing, measures expand', () => {
    const plan = buildPlan('demo', '1.0.0', BSCS, 'A');
    expect(plan.plannedMissing).toEqual(['demo.i03']);
    expect(plan.items.map((i) => i.responseId)).toEqual([
      'demo.i01',
      'demo.i02',
      'demo.i04',
      'demo.p1.moves',
      'demo.p1.solved_within_limit',
    ]);
    expect(plan.block).toBe('A');
    expect(plan.items.find((i) => i.measure === 'moves')?.needsKey).toBe(true);
    expect(buildPlan('demo', '1.0.0', BSCS, null).plannedMissing).toEqual(['demo.i02', 'demo.i03']);
  });

  it('reads the licensed source file (JSON and CSV) and keeps placeholders without it', () => {
    const json = parseLicensedSource(
      '{"items":{"demo.i01":{"text":{"hi-IN":"हिंदी"}},"demo.i04":{"expected_response":2}}}',
    );
    const csv = parseLicensedSource(
      'item_id,language,text,expected_response\ndemo.i01,hi-IN,"text, with comma",\ndemo.p1,,,7',
    );
    const plan = buildPlan('demo', '1.0.0', BSCS, 'A');
    const i01 = plan.items[0];
    const i04 = plan.items.find((i) => i.attentionCheck);
    const moves = plan.items.find((i) => i.measure === 'moves');
    if (!i01 || !i04 || !moves) throw new Error('plan');
    expect(itemWording(i01, 'hi-IN', json)).toEqual({ text: 'हिंदी', licensed: true });
    expect(itemWording(i01, 'ta-IN', null).licensed).toBe(false);
    expect(itemWording(i01, 'hi-IN', csv).text).toBe('text, with comma');
    expect(expectedResponse(i04, json)).toBe(2);
    expect(expectedResponse(moves, csv)).toBe(7);
    expect(() => parseLicensedSource('text\nfoo')).toThrow();
  });

  it('validates values, tracks progress and builds the submission body', () => {
    const plan = buildPlan('demo', '1.0.0', BSCS, 'A');
    const first = plan.items[0];
    if (!first) throw new Error('plan');
    expect(isValidValue(plan.scale, first, 6)).toBe(false);
    expect(isValidValue(plan.scale, first, 3)).toBe(true);
    const answers = new Map([
      ['demo.i01', { value: 4, latencyMs: 1200.4, skipped: false }],
      ['demo.i02', { value: null, latencyMs: 900, skipped: true }],
      ['demo.p1.moves', { value: 9, latencyMs: 30_000, skipped: false }],
    ]);
    expect(progress(plan, answers)).toMatchObject({
      total: 5,
      answered: 2,
      skipped: 1,
      remaining: 2,
    });
    const ctx = {
      pid: ' P1 ',
      studyId: 's',
      occasionId: 'T1',
      wave: 1,
      language: 'hi-IN',
      mode: 'read_aloud' as const,
      administratorId: 'adm-1',
      deviceId: 'd',
      audioVersion: null,
      raterRole: 'self' as const,
      ratedPid: null,
    };
    expect(submissionIssues(plan, answers, null, ctx).map((i) => i.responseId)).toEqual([
      'demo.p1.moves',
    ]);
    const source = parseLicensedSource('item_id,expected_response\ndemo.p1,7');
    expect(submissionIssues(plan, answers, source, ctx)).toEqual([]);
    const body = buildSubmission(plan, answers, source, ctx);
    expect(body).toMatchObject({
      pid: 'P1',
      block: 'A',
      administrator_id: 'adm-1',
      site_mode: 'supervised',
      planned_missing_items: ['demo.i03'],
    });
    expect(body.responses).toEqual([
      { item_id: 'demo.i01', raw_response: 4, response_latency_ms: 1200 },
      { item_id: 'demo.i02', raw_response: null, response_latency_ms: 900 },
      {
        item_id: 'demo.p1.moves',
        raw_response: 9,
        response_latency_ms: 30000,
        expected_response: 7,
      },
    ]);
    expect(
      submissionIssues(plan, answers, source, { ...ctx, raterRole: 'partner', ratedPid: 'P1' })
        .length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------- import mapping

describe('CSV/XLSX import mapping', () => {
  const plan = buildPlan('demo', '1.0.0', BSCS, 'A');
  it('parses quoted CSV with CRLF and detects the delimiter', () => {
    const p = parseCsv('﻿PID;Q1;Q2\r\n"A;1";4;5\r\nB;2;\r\n');
    expect(p.delimiter).toBe(';');
    expect(p.headers).toEqual(['PID', 'Q1', 'Q2']);
    expect(p.rows[0]).toEqual(['A;1', '4', '5']);
    expect(p.totalRows).toBe(2);
  });

  it('suggests mappings by item id and number', () => {
    const m = suggestMapping(
      ['PID', 'Q1', 'demo.i02', 'i04', 'expected_demo.i04', 'p5moves'],
      plan.items,
    );
    expect(m).toMatchObject({
      pid: 'PID',
      'item:demo.i01': 'Q1',
      'item:demo.i02': 'demo.i02',
      'item:demo.i04': 'i04',
      'expected:demo.i04': 'expected_demo.i04',
    });
  });

  it('checks mapping errors and out-of-range values', () => {
    const p = parseCsv('PID,Q1,Q1b\nA,9,1\nA,2,2\n,3,3');
    const checks = checkImport(
      p,
      { pid: 'PID', 'item:demo.i01': 'Q1', 'item:demo.i02': 'Q1' },
      plan.items,
      plan.scale,
    );
    expect(hasErrors(checks)).toBe(true);
    expect(checks.some((c) => c.message.includes('mapped twice'))).toBe(true);
    expect(checks.some((c) => c.row === 1 && c.message.includes('outside'))).toBe(true);
    expect(checks.some((c) => c.row === 2 && c.message.includes('also appears'))).toBe(true);
    expect(checks.some((c) => c.row === 3 && c.message.includes('Empty participant'))).toBe(true);
    expect(hasErrors(checkImport(p, {}, plan.items, plan.scale))).toBe(true);
  });
});

// ---------------------------------------------------------------- studies and report

describe('study management', () => {
  const t1: OccasionRow = {
    occasion_id: 'T1',
    wave: 1,
    label: 'Baseline',
    sequence: 1,
    offset_days_min: null,
    offset_days_max: null,
    instruments: [],
    game_required: true,
  };
  const t2: OccasionRow = {
    ...t1,
    occasion_id: 'T2',
    label: 'Retest',
    sequence: 2,
    offset_days_min: 14,
    offset_days_max: 28,
  };
  it('finds the retest pair and window states', () => {
    expect(retestPair([t2, t1])).toEqual({ first: t1, retest: t2 });
    expect(retestPair([t1])).toBeNull();
    const day = 86_400_000;
    expect(windowState(0, 10 * day, 14, 28, false)).toBe('not_open');
    expect(windowState(0, 20 * day, 14, 28, false)).toBe('open');
    expect(windowState(0, 30 * day, 14, 28, false)).toBe('closed');
    expect(windowState(0, 30 * day, 14, 28, true)).toBe('done');
  });

  it('builds retest candidates from completed first-occasion sessions', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    const c = retestCandidates(
      [
        session({ participant_pid: 'A', completed_at: '2026-10-01T10:00:00Z' }),
        session({ participant_pid: 'B', completed_at: '2026-10-15T10:00:00Z' }),
        session({ participant_pid: 'C', completed_at: '2026-09-01T10:00:00Z' }),
        session({ participant_pid: 'C', occasion_id: 'T2', completed_at: '2026-09-20T10:00:00Z' }),
        session({ participant_pid: null }),
      ],
      t1,
      t2,
      now,
    );
    expect(c.map((x) => [x.pid, x.state])).toEqual([
      ['C', 'done'],
      ['A', 'open'],
      ['B', 'not_open'],
    ]);
    expect(windowCounts(c)).toEqual({ not_open: 1, open: 1, closed: 0, done: 1 });
  });

  it('hashes protocol documents with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('scientific report', () => {
  const snapshot = {
    snapshot_id: 'snap',
    study_id: 's',
    name: 'demo',
    version: 2,
    status: 'frozen',
    spec: {},
    manifest: {},
    exclusions: { total: 3, by_reason: { withdrawn: 2, no_criterion: 1 } },
    sha256: 'x',
    row_count: 520,
    n_participants: 400,
    job_id: null,
    created_by: 't',
    created_at: '',
    frozen_at: null,
    tombstoned_at: null,
    tombstone_reason: null,
    supersedes_id: null,
    error: null,
  };
  it('builds every section with N on statistic rows', () => {
    const sections = buildReport(
      {
        snapshot,
        rows: ROWS,
        runs: RUNS,
        gateRun: null,
        deviations: [],
        names: new Map([['self_control', 'Self-control']]),
      },
      SECTION_IDS,
    );
    expect(sections.map((s) => s.id)).toEqual([...SECTION_IDS]);
    const rel = sections.find((s) => s.id === 'reliability')?.tables[0];
    expect(rel?.columns).toContain('N');
    expect(rel?.rows.some((r) => r[0] === 'Self-control')).toBe(true);
    expect(sections[0]?.tables[0]?.rows).toEqual([
      ['withdrawn', 2],
      ['no criterion', 1],
    ]);
    const pred = sections.find((s) => s.id === 'prediction');
    expect(pred?.tables[0]?.rows.length).toBe(8);
  });

  it('exports CSV, HTML and the flat evidence columns', () => {
    expect(
      tableCsv({
        id: 't',
        title: 't',
        columns: ['a', 'b'],
        rows: [
          ['x,y', 1],
          [null, 'q"'],
        ],
      }),
    ).toBe('a,b\r\n"x,y",1\r\n,"q"""');
    const html = reportHtml(
      'T <1>',
      [['k', 'v']],
      [{ id: 's', title: 'S', text: 'x', tables: [] }],
      true,
    );
    expect(html).toContain('T &lt;1&gt;');
    expect(html).toContain('Synthetic');
    expect(html).not.toContain('<script');
    const cols = evidenceExportColumns().map((c) => c.key);
    expect(cols).toEqual(
      expect.arrayContaining([
        'n',
        'ci_low',
        'ci_high',
        'excluded',
        'snapshot_id',
        'inputs_sha256',
      ]),
    );
  });
});
