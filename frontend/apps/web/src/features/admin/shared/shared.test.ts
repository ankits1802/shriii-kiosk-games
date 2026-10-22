import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  compareVersions,
  jsonDiff,
  pointerWithin,
  sha256Hex,
} from './canonical-json';
import { MISSING_ENDPOINTS } from './missing-endpoints';
import { checkApprovers } from './two-person';

describe('canonicalJson', () => {
  it('sorts keys and ignores formatting', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2 }] })).toBe(
      '{"a":[true,null,{"c":2,"d":"x"}],"b":1}',
    );
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('jsonDiff', () => {
  it('lists leaf changes with escaped pointers', () => {
    const d = jsonDiff(
      { a: 1, 'x/y': [1, 2], keep: { z: 1 } },
      { a: 2, 'x/y': [1], keep: { z: 1 }, n: 'new' },
    );
    expect(d).toEqual([
      { path: '/a', kind: 'changed', before: 1, after: 2 },
      { path: '/n', kind: 'added', after: 'new' },
      { path: '/x~1y/1', kind: 'removed', before: 2 },
    ]);
  });
  it('treats key order as no change', () => {
    expect(jsonDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });
  it('checks pointer containment by segment', () => {
    expect(pointerWithin('/version', '/version')).toBe(true);
    expect(pointerWithin('/versions', '/version')).toBe(false);
    expect(pointerWithin('/a/b', '/a')).toBe(true);
  });
});

describe('compareVersions', () => {
  it('orders numerically', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });
});

describe('checkApprovers', () => {
  it('needs two distinct people', () => {
    expect(checkApprovers(['Dr Rao', '']).errors).toHaveLength(1);
    expect(checkApprovers(['Dr Rao', ' dr  rao ']).errors.length).toBeGreaterThan(0);
    expect(checkApprovers(['Dr Rao', 'Ms Iyer']).errors).toEqual([]);
  });
  it('excludes named people', () => {
    expect(checkApprovers(['Dr Rao', 'dev-admin'], { exclude: ['dev-admin'] }).errors).toHaveLength(
      1,
    );
  });
});

describe('missing endpoints', () => {
  const openapi = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../../../../backend/api/openapi.json', import.meta.url)),
      'utf8',
    ),
  ) as { paths: Record<string, Record<string, unknown>> };

  it('are still missing from backend/api/openapi.json (wire them up once they exist)', () => {
    for (const e of Object.values(MISSING_ENDPOINTS)) {
      const ops = openapi.paths[e.path];
      expect(ops?.[e.method.toLowerCase()], `${e.method} ${e.path} now exists`).toBeUndefined();
    }
  });
});
