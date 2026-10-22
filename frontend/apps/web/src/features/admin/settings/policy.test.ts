import { describe, expect, it } from 'vitest';
import {
  approve,
  changedKeys,
  effectivePolicy,
  nextPolicyVersion,
  type PolicyContext,
  parsePolicyDocument,
  planDefaults,
  policyHash,
  propose,
  validatePolicy,
} from './policy';

const ctx: PolicyContext = {
  catalogueLanguages: ['en-IN', 'hi-IN', 'mr-IN', 'ta-IN'],
  statementLines: ['report.what_this_is_about', 'report.disclaimer.snapshot'],
  releasePackValid: false,
};

const valid = { ...planDefaults(), report_use_statement_key: 'report.disclaimer.snapshot' };

describe('validatePolicy', () => {
  it('requires the report use statement to be chosen (no invented default)', () => {
    expect(validatePolicy(planDefaults(), ctx).map((i) => i.key)).toEqual([
      'report_use_statement_key',
    ]);
    expect(validatePolicy(valid, ctx)).toEqual([]);
  });

  it('keeps locked keys at the plan default', () => {
    const issues = validatePolicy({ ...valid, allow_minors: true, minimum_age: 16 }, ctx);
    expect(issues.map((i) => i.key)).toEqual(
      expect.arrayContaining(['allow_minors', 'minimum_age']),
    );
  });

  it('rejects player reports without a valid release pack or at open public sites', () => {
    const atOpen = validatePolicy(
      { ...valid, report_mode: 'player_report', site_mode: 'open_public' },
      { ...ctx, releasePackValid: true },
    );
    expect(atOpen.some((i) => /VAL-18/.test(i.message))).toBe(true);
    const noPack = validatePolicy({ ...valid, report_mode: 'player_report' }, ctx);
    expect(noPack.some((i) => /release pack/.test(i.message))).toBe(true);
    expect(
      validatePolicy(
        { ...valid, report_mode: 'player_report' },
        { ...ctx, releasePackValid: true },
      ),
    ).toEqual([]);
  });

  it('checks languages against the catalogue and ratios', () => {
    const issues = validatePolicy(
      { ...valid, enabled_languages: ['xx-YY'], pathway_mix: { B_fixed: 0 } },
      ctx,
    );
    expect(issues.map((i) => i.key)).toEqual(['enabled_languages', 'pathway_mix']);
  });
});

describe('versioning and approval', () => {
  it('bumps minor versions', () => {
    expect(nextPolicyVersion(null)).toBe('1.0.0');
    expect(nextPolicyVersion('1.4.2')).toBe('1.5.0');
  });

  it('needs a second person and a matching hash', async () => {
    const doc = await propose(valid, {
      current: null,
      actor: 'alice',
      note: 'first',
      now: new Date('2026-10-22T00:00:00Z'),
    });
    expect(doc.sha256).toBe(await policyHash('1.0.0', valid));
    expect(await approve(doc, 'alice')).toEqual({ ok: false, reason: 'own_proposal' });
    const tampered = { ...doc, values: { ...doc.values, asr_enabled: true } };
    expect(await approve(tampered, 'bob')).toEqual({ ok: false, reason: 'hash_mismatch' });
    const res = await approve(doc, 'bob');
    expect(res.ok && res.doc.status).toBe('approved');
    if (!res.ok) return;
    const next = await propose(
      { ...valid, asr_enabled: true },
      { current: res.doc, actor: 'bob', note: 'asr' },
    );
    expect(next.policy_version).toBe('1.1.0');
    expect(next.previous_sha256).toBe(doc.sha256);
    expect(changedKeys(res.doc.values, next.values)).toEqual(['asr_enabled']);

    // A pending proposal never hides the policy in force.
    expect(effectivePolicy(next)?.policy_version).toBe('1.0.0');
    expect(effectivePolicy(res.doc)?.policy_version).toBe('1.0.0');
    const reparsed = parsePolicyDocument(JSON.parse(JSON.stringify(next)));
    expect(reparsed?.last_approved?.sha256).toBe(doc.sha256);
    expect(reparsed?.last_approved && 'last_approved' in reparsed.last_approved).toBe(false);
    // A second proposal on top of a pending one still points at the last approved version.
    const again = await propose(next.values, { current: next, actor: 'carol', note: 'again' });
    expect(again.last_approved?.policy_version).toBe('1.0.0');
    expect(again.previous_sha256).toBe(doc.sha256);
  });

  it('treats approver names case-insensitively and re-validates at approval time', async () => {
    const doc = await propose(
      { ...valid, report_mode: 'player_report' },
      { current: null, actor: 'Alice', note: 'reports' },
    );
    expect(await approve(doc, ' alice ')).toEqual({ ok: false, reason: 'own_proposal' });
    // The release pack is no longer valid when the second person approves.
    const refused = await approve(doc, 'bob', { ctx: { ...ctx, releasePackValid: false } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('invalid');
      expect(refused.issues?.map((i) => i.key)).toContain('report_mode');
    }
    const accepted = await approve(doc, 'bob', { ctx: { ...ctx, releasePackValid: true } });
    expect(accepted.ok).toBe(true);
  });

  it('parses stored documents defensively', () => {
    expect(parsePolicyDocument({ foo: 1 })).toBeNull();
    expect(
      parsePolicyDocument({ policy_version: '1.0.0', values: {}, status: 'weird' })?.status,
    ).toBe('proposed');
  });
});
