/**
 * Pseudonymous participant ids (CRT-06): Crockford base32 with a Luhn mod-32 check character,
 * mirroring backend/api/src/shriii_api/security.py so a mistyped code is rejected on the tablet.
 */

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6,26}$/;

export function luhnCheckChar(body: string): string {
  let factor = 2;
  let total = 0;
  for (const ch of [...body].reverse()) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`not Crockford base32: ${ch}`);
    const addend = factor * idx;
    factor = factor === 2 ? 1 : 2;
    total += Math.floor(addend / 32) + (addend % 32);
  }
  return CROCKFORD[(32 - (total % 32)) % 32] as string;
}

/** Upper-case and apply Crockford substitutions (I/L -> 1, O -> 0, drop hyphens and spaces). */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[-\s]/g, '');
}

/** True when `pid` (normalised) matches the contract pattern and its check character is valid. */
export function isValidPid(pid: string): boolean {
  if (!PID_PATTERN.test(pid)) return false;
  return luhnCheckChar(pid.slice(0, -1)) === pid.slice(-1);
}

/**
 * Extract a pid from a scanned QR payload: a bare pid, `shriii:pid:<pid>`, or a URL with a
 * `pid` query parameter. Returns null when no valid pid is present.
 */
export function pidFromQr(payload: string): string | null {
  const text = payload.trim();
  let candidate = text;
  const prefixed = /^shriii:pid:(.+)$/i.exec(text);
  if (prefixed?.[1]) candidate = prefixed[1];
  else if (/^https?:\/\//i.test(text)) {
    try {
      candidate = new URL(text).searchParams.get('pid') ?? '';
    } catch {
      return null;
    }
  }
  const pid = normaliseCode(candidate);
  return isValidPid(pid) ? pid : null;
}
