import { describe, expect, it } from 'vitest';
import { auditInfo } from './audit';
import {
  formatActor,
  formatBytes,
  formatCoefficient,
  formatDateTime,
  formatEstimateCI,
  formatIsoUtc,
  formatP,
  formatRelative,
  shortId,
} from './format';

describe('format', () => {
  it('formats coefficients APA-style', () => {
    expect(formatCoefficient(0.344)).toBe('.34');
    expect(formatCoefficient(-0.12)).toBe('−.12');
    expect(formatCoefficient(-0.001)).toBe('.00');
    expect(formatCoefficient(1)).toBe('1.00');
    expect(formatCoefficient(null)).toBe('—');
    expect(formatEstimateCI(0.34, 0.21, 0.46)).toBe('.34 [.21, .46]');
  });

  it('formats p values', () => {
    expect(formatP(0.0004)).toBe('p < .001');
    expect(formatP(0.032)).toBe('p = .032');
    expect(formatP(undefined)).toBe('p = —');
  });

  it('formats times', () => {
    const iso = '2026-10-21T09:30:00Z';
    expect(formatDateTime(iso, 'Asia/Kolkata')).toMatch(/21 Oct 2026, 15:00/);
    expect(formatIsoUtc(iso)).toBe('2026-10-21T09:30:00.000Z');
    const now = Date.parse(iso);
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(formatRelative(now + 2 * 86_400_000, now)).toBe('in 2 days');
    expect(formatRelative(now - 10_000, now)).toBe('just now');
    expect(formatDateTime('nope')).toBe('—');
  });

  it('formats actors, ids and sizes', () => {
    expect(formatActor('system')).toBe('System');
    expect(formatActor(null)).toBe('Unknown');
    expect(formatActor('dev-researcher')).toBe('dev-researcher');
    expect(shortId('0190a7c2-1234-7abc-8def-0123456789ab')).toBe('0190a7…89ab');
    expect(shortId('short')).toBe('short');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('auditInfo', () => {
  it('reads the varied actor/time fields of API records', () => {
    expect(auditInfo({ created_by: 'u1', created_at: '2026-01-01T00:00:00Z' })).toEqual({
      verb: 'Created',
      actor: 'u1',
      at: '2026-01-01T00:00:00Z',
      updated: null,
    });
    expect(auditInfo({ recorded_by: 'u2', created_at: 't' })?.verb).toBe('Recorded');
    expect(auditInfo({ linked_by: 'u3' })?.verb).toBe('Linked');
    expect(auditInfo({ updated_by: 'u4', updated_at: 't2' })).toEqual({
      verb: 'Updated',
      actor: 'u4',
      at: 't2',
      updated: null,
    });
    expect(
      auditInfo({ created_by: 'a', created_at: 't1', updated_by: 'b', updated_at: 't2' })?.updated,
    ).toEqual({
      actor: 'b',
      at: 't2',
    });
    expect(auditInfo({ name: 'x' })).toBeNull();
  });
});
