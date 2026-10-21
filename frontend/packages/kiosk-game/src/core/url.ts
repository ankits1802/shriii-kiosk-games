/**
 * Linear-time slash trimming for URL joining. The obvious `/\/+$/` and `/^\/+/` regexes backtrack
 * quadratically on inputs with long runs of '/' that are not at the end (polynomial ReDoS), and the
 * bases they trim come from content manifests and build configuration.
 */

/** `s` without trailing '/' characters. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** `s` without leading '/' characters. */
export function trimLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) start++;
  return start === 0 ? s : s.slice(start);
}
