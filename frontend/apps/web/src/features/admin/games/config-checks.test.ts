import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkGameConfig, invariantIssues, lockedReason } from './config-checks';

const GAMES_DIR = fileURLToPath(new URL('../../../../../../../content/games/', import.meta.url));

function loadAll(): { path: string; config: Record<string, unknown> }[] {
  const out: { path: string; config: Record<string, unknown> }[] = [];
  for (const dir of ['pathway-a', 'pathway-b', 'shared']) {
    for (const f of readdirSync(`${GAMES_DIR}${dir}`)) {
      if (!f.endsWith('.json')) continue;
      const config = JSON.parse(readFileSync(`${GAMES_DIR}${dir}/${f}`, 'utf8')) as Record<
        string,
        unknown
      >;
      // Only module configs are games (the API sync skips other documents, e.g. calibration).
      if ('module_id' in config) out.push({ path: `${dir}/${f}`, config });
    }
  }
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);

describe('checkGameConfig', () => {
  const all = loadAll();
  const dice = all.find((c) => c.path === 'pathway-b/private-dice.json')?.config;
  if (!dice) throw new Error('fixture missing');

  it('accepts every committed content/games config with no errors', () => {
    expect(all.length).toBeGreaterThan(5);
    for (const { path, config } of all) {
      const res = checkGameConfig(config, null);
      const errors = res.issues.filter((i) => i.severity === 'error');
      expect(errors, path).toEqual([]);
    }
  });

  it('reports schema violations with JSON pointers', () => {
    const edited = clone(dice);
    (edited.budget as Record<string, unknown>).intro_ms = -5;
    edited.surprise = true;
    const res = checkGameConfig(edited, null);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.source === 'schema')).toBe(true);
  });

  it('flags trials below min_trials and budget ordering', () => {
    const edited = clone(dice);
    const blocks = edited.blocks as Record<string, unknown>[];
    (blocks[1] as Record<string, unknown>).trials = 3;
    (edited.budget as Record<string, unknown>).soft_cap_ms = 999_999;
    const issues = invariantIssues(edited);
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['/blocks/1/trials', '/budget/soft_cap_ms']),
    );
  });

  it('flags planned counts below the minimum', () => {
    const edited = clone(dice);
    (edited.planned_counts as Record<string, number>).reports = 2;
    expect(invariantIssues(edited).some((i) => i.path === '/planned_counts/reports')).toBe(true);
  });

  it('locks science fields and requires a version bump', () => {
    const edited = clone(dice);
    (edited.min_counts as Record<string, number>).reports = 5;
    const res = checkGameConfig(edited, dice);
    const cc = res.issues.filter((i) => i.source === 'change-control').map((i) => i.path);
    expect(cc).toContain('/min_counts/reports');
    expect(cc).toContain('/version');
  });

  it('allows a timing change with a bumped version', () => {
    const edited = clone(dice);
    const l2 = (edited.levels as Record<string, Record<string, Record<string, number>>>).L2;
    if (!l2?.timing) throw new Error('fixture shape');
    l2.timing.reveal_ms = 2300;
    edited.version = '0.1.1';
    const res = checkGameConfig(edited, dice);
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(res.diff.map((d) => d.path)).toEqual(['/levels/L2/timing/reveal_ms', '/version']);
  });

  const dontTap = all.find((c) => c.path === 'pathway-b/dont-tap.json')?.config;

  it('locks phase, condition and shift tagging that dictionary indicators select on', () => {
    if (!dontTap) throw new Error('fixture missing');
    const edited = clone(dontTap);
    const blocks = edited.blocks as Record<string, unknown>[];
    const pressure = blocks.find((b) => b.block_id === 'pressure');
    if (!pressure) throw new Error('fixture shape');
    pressure.phase = 'main';
    (pressure.conditions as Record<string, boolean>).shift_active = true;
    (edited.context_shift as Record<string, unknown>).window = [10, 10];
    edited.version = '0.1.1';
    const res = checkGameConfig(edited, dontTap);
    const locked = res.issues
      .filter((i) => i.source === 'change-control' && i.severity === 'error')
      .map((i) => i.path);
    expect(locked).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/blocks\/\d+\/phase$/),
        expect.stringMatching(/^\/blocks\/\d+\/conditions\/shift_active$/),
        expect.stringMatching(/^\/context_shift\/window/),
      ]),
    );
    expect(res.valid).toBe(false);
  });

  it('does not let whole-block additions or removals bypass the minimum-trial locks', () => {
    if (!dontTap) throw new Error('fixture missing');
    const removed = clone(dontTap);
    (removed.blocks as unknown[]).pop();
    removed.version = '0.1.1';
    const r1 = checkGameConfig(removed, dontTap);
    expect(r1.valid).toBe(false);
    expect(r1.issues.some((i) => i.source === 'change-control' && i.severity === 'error')).toBe(
      true,
    );

    const added = clone(dontTap);
    const blocks = added.blocks as Record<string, unknown>[];
    blocks.push({ ...clone(blocks[1] as Record<string, unknown>), block_id: 'extra' });
    added.version = '0.1.1';
    const r2 = checkGameConfig(added, dontTap);
    expect(r2.valid).toBe(false);
  });

  it('warns (without blocking) on stimulus timing and response-window changes', () => {
    if (!dontTap) throw new Error('fixture missing');
    const edited = clone(dontTap);
    const l2 = (edited.levels as Record<string, Record<string, Record<string, number>>>).L2;
    if (!l2?.timing) throw new Error('fixture shape');
    l2.timing.response_window_ms = 600;
    l2.timing.stimulus_ms = 520;
    edited.version = '0.1.1';
    const res = checkGameConfig(edited, dontTap);
    expect(res.valid).toBe(true);
    const warnings = res.issues.filter((i) => i.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/response window/);
  });

  it('never accepts logging the true private-dice outcome', () => {
    const edited = clone(dice);
    (edited.constraints as Record<string, unknown>).true_outcome_logged = true;
    expect(invariantIssues(edited).map((i) => i.path)).toContain(
      '/constraints/true_outcome_logged',
    );
    edited.version = '0.1.1';
    const res = checkGameConfig(edited, dice);
    expect(res.valid).toBe(false);
    expect(res.issues.filter((i) => i.source === 'change-control').map((i) => i.path)).toContain(
      '/constraints/true_outcome_logged',
    );
  });

  it('matches locked patterns per segment', () => {
    expect(lockedReason('/blocks/3/min_trials')).toMatch(/science/);
    expect(lockedReason('/blocks/3/trials')).toBeNull();
    expect(lockedReason('/indicators/2')).toMatch(/indicator/);
    expect(lockedReason('/blocks/3')).not.toBeNull();
    expect(lockedReason('/levels/L2/timing/stimulus_ms')).toBeNull();
  });
});
