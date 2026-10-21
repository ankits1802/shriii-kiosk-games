import { describe, expect, it } from 'vitest';
import {
  CROCKFORD,
  isValidPid,
  luhnCheckChar,
  normaliseCode,
  pidFromQr,
} from '../src/domain/pid.ts';

const withCheck = (body: string) => body + luhnCheckChar(body);

describe('pid (Crockford base32 + Luhn mod 32, as backend security.py)', () => {
  const pid = withCheck('7K3M9QX2A');

  it('accepts a generated pid', () => {
    expect(pid).toHaveLength(10);
    expect(isValidPid(pid)).toBe(true);
  });

  it('rejects every single-character substitution', () => {
    for (let i = 0; i < pid.length; i++) {
      for (const ch of CROCKFORD) {
        if (ch === pid[i]) continue;
        const bad = pid.slice(0, i) + ch + pid.slice(i + 1);
        expect(isValidPid(bad), bad).toBe(false);
      }
    }
  });

  it('rejects adjacent transpositions of different characters', () => {
    for (let i = 0; i < pid.length - 1; i++) {
      if (pid[i] === pid[i + 1]) continue;
      const bad = pid.slice(0, i) + pid[i + 1] + pid[i] + pid.slice(i + 2);
      expect(isValidPid(bad), bad).toBe(false);
    }
  });

  it('matches a known backend vector', () => {
    // body 000000000 -> check '0'; body 000000001 -> 1*2 = 2 -> (32-2)%32 = 30 -> 'Y'
    expect(luhnCheckChar('000000000')).toBe('0');
    expect(luhnCheckChar('000000001')).toBe('Y');
  });

  it('normalises typed codes', () => {
    expect(normaliseCode(` ${pid.slice(0, 5).toLowerCase()}-${pid.slice(5)} `)).toBe(pid);
    expect(normaliseCode('io-l')).toBe('101');
  });

  it('extracts pids from QR payloads', () => {
    expect(pidFromQr(pid)).toBe(pid);
    expect(pidFromQr(`shriii:pid:${pid}`)).toBe(pid);
    expect(pidFromQr(`https://example.org/p?pid=${pid}`)).toBe(pid);
    expect(pidFromQr('https://example.org/p')).toBeNull();
    expect(pidFromQr(`${pid.slice(0, -1)}0`)).toBe(pid.endsWith('0') ? pid : null);
  });
});
