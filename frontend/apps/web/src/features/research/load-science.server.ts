/**
 * Server-only read of the frozen science inputs the research pages display thresholds from:
 * `stats/measurement-model/gates.yaml` and `hypotheses.yaml`. Thresholds are never hard-coded in the
 * UI (BUILD_DECISIONS non-negotiable 8); the API applies the same files when it evaluates gates.
 * Replace with an API read once the backend exposes the frozen analysis-plan documents.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { ScienceConfig } from './lib/science';

export const GATES_PATH = 'stats/measurement-model/gates.yaml';
export const HYPOTHESES_PATH = 'stats/measurement-model/hypotheses.yaml';

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown): Raw => (isRaw(v) ? v : {});
const num = (v: unknown, fallback: number | null = null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The monorepo root (the directory holding pnpm-workspace.yaml) above `start`. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repository root not found above ${start}`);
    dir = parent;
  }
}

function readYaml(root: string, path: string): { doc: Raw; sha256: string } {
  const bytes = readFileSync(join(/*turbopackIgnore: true*/ root, path));
  return {
    doc: rec(parse(bytes.toString('utf8'))),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function loadScienceConfig(root: string = findRepoRoot()): ScienceConfig {
  const gates = readYaml(root, GATES_PATH);
  const hyp = readYaml(root, HYPOTHESES_PATH);
  const tg = rec(gates.doc.trait_gate);
  const retest = rec(tg.retest);
  const reliability = rec(tg.reliability);
  const convergent = rec(tg.convergent);
  const invariance = rec(tg.invariance);
  const battery = rec(gates.doc.battery_gate);
  const quality = rec(gates.doc.quality);
  const defaults = rec(hyp.doc.defaults);
  const hypotheses = (Array.isArray(hyp.doc.hypotheses) ? hyp.doc.hypotheses : [])
    .filter(isRaw)
    .map((h) => ({
      id: String(h.id ?? ''),
      family: str(h.family),
      construct: str(h.construct),
      criterion: str(h.criterion),
      kind: str(h.type) ?? str(h.kind),
      pathways: (Array.isArray(h.pathways) ? h.pathways : []).map(String),
      expectedSign: str(h.expected_sign),
      note: str(h.notes),
    }))
    .filter((h) => h.id);
  const caps = (Array.isArray(gates.doc.caps) ? gates.doc.caps : []).filter(isRaw).map((c) => ({
    construct: String(c.construct ?? ''),
    maxStatus: String(c.max_status ?? ''),
    reason: str(c.reason),
  }));
  const withholds = (
    Array.isArray(gates.doc.permanent_withhold) ? gates.doc.permanent_withhold : []
  )
    .filter(isRaw)
    .map((w) => ({
      construct: String(w.construct ?? ''),
      pathway: String(w.pathway ?? ''),
      reason: str(w.reason),
    }));
  return {
    gates: {
      path: GATES_PATH,
      version: String(gates.doc.version ?? ''),
      status: String(gates.doc.status ?? ''),
      sha256: gates.sha256,
      retest: {
        statistic: str(retest.statistic) ?? 'icc_a1',
        pointMin: num(retest.point_min),
        lowerBoundMin: num(retest.lower_bound_min),
        ciLevel: num(retest.ci_level, 0.95) ?? 0.95,
        pooledLanguagePointMin: num(retest.pooled_language_point_min),
        minPairsPerCell: num(retest.min_pairs_per_cell),
      },
      reliability: {
        pointMin: num(reliability.point_min),
        lowerBoundMin: num(reliability.lower_bound_min),
      },
      convergent: {
        lowerBoundGt: num(convergent.lower_bound_gt),
        correction: str(convergent.correction),
      },
      invariance: {
        requiredGroupings: (Array.isArray(invariance.required_groupings)
          ? invariance.required_groupings
          : []
        ).map(String),
        maxFreedParameterShare: num(invariance.max_freed_parameter_share),
      },
      battery: {
        minLanguageGroups: num(battery.min_language_groups),
        differentialExclusionMaxPp: num(battery.differential_exclusion_max_pp),
        signoffRoles: (Array.isArray(battery.signoff_roles) ? battery.signoff_roles : []).map(
          String,
        ),
      },
      minNamedSigners: num(tg.min_named_signers),
      fairnessCellMinN: num(quality.fairness_cell_min_n),
      practiceEffectDFlag: num(quality.practice_effect_d_flag),
      floorCeilingFlagShare: num(quality.floor_ceiling_flag_share),
      caps,
      withholds,
    },
    hypotheses: {
      path: HYPOTHESES_PATH,
      version: String(hyp.doc.version ?? ''),
      status: String(hyp.doc.status ?? ''),
      sha256: hyp.sha256,
      r0: num(defaults.r0),
      ciLevel: num(defaults.ci_level, 0.95) ?? 0.95,
      items: hypotheses,
    },
  };
}
