/**
 * Display formatting for the research console. Research views show statistics with uncertainty;
 * none of this is ever used on the kiosk (players never see numbers).
 */

const LOCALE = 'en-IN';

export function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `21 Oct 2026, 15:04 IST` (viewer's time zone unless given). */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  timeZone?: string,
): string {
  const d = parseDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

export function formatDate(
  value: string | number | Date | null | undefined,
  timeZone?: string,
): string {
  const d = parseDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Exact UTC timestamp for tooltips and exports (ISO 8601). */
export function formatIsoUtc(value: string | number | Date | null | undefined): string {
  const d = parseDate(value);
  return d ? d.toISOString() : '—';
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** `3 hours ago`, `in 2 days`. */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const d = parseDate(value);
  if (!d) return '—';
  const deltaSeconds = (d.getTime() - now) / 1000;
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (abs >= seconds || unit === 'second') {
      return rtf.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return rtf.format(Math.round(deltaSeconds), 'second');
}

/** Actor display: service principals read as words, user subjects verbatim. */
export function formatActor(sub: string | null | undefined): string {
  if (!sub) return 'Unknown';
  if (sub === 'system') return 'System';
  if (sub.startsWith('kiosk:') || sub.startsWith('kdt_'))
    return `Kiosk ${sub.replace(/^kiosk:/, '')}`;
  return sub;
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString(LOCALE);
}

/** Correlations and loadings drop the leading zero: `.34`, `−.12` (APA style). */
export function formatCoefficient(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const fixed = Math.abs(value).toFixed(digits);
  const trimmed = fixed.startsWith('0') ? fixed.slice(1) : fixed;
  return value < 0 && Number(fixed) !== 0 ? `−${trimmed}` : trimmed;
}

/** `.34 [.21, .46]` */
export function formatEstimateCI(
  estimate: number | null | undefined,
  lower: number | null | undefined,
  upper: number | null | undefined,
  digits = 2,
  coefficient = true,
): string {
  const f = coefficient ? formatCoefficient : formatNumber;
  return `${f(estimate, digits)} [${f(lower, digits)}, ${f(upper, digits)}]`;
}

/** APA p-values: `p < .001`, `p = .032`. */
export function formatP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'p = —';
  if (p < 0.001) return 'p < .001';
  return `p = ${formatCoefficient(p, 3)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Shorten long ids for tables (`3f2a…9c1d`); the full id stays in the title/copy action. */
export function shortId(id: string, head = 6, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
