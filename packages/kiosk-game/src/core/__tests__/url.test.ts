import { describe, expect, it } from 'vitest';
import { trimLeadingSlashes, trimTrailingSlashes } from '../url.ts';

describe('slash trimming', () => {
  it('trims only the requested end', () => {
    expect(trimTrailingSlashes('https://api.example/v1///')).toBe('https://api.example/v1');
    expect(trimTrailingSlashes('https://api.example')).toBe('https://api.example');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimLeadingSlashes('//audio/hi/a.opus')).toBe('audio/hi/a.opus');
    expect(trimLeadingSlashes('audio/a.opus/')).toBe('audio/a.opus/');
    expect(trimLeadingSlashes('')).toBe('');
  });

  it('is linear on long runs of slashes that are not at the end', () => {
    const hostile = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(trimLeadingSlashes(`x${'/'.repeat(200_000)}`)).toHaveLength(200_001);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
