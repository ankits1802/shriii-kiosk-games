/**
 * Structured operations log (JSON lines) with size-based rotation. Never receives participant data:
 * callers log states, counts and error messages only, so scrubbed logs can be pulled remotely
 * (KSK-10) without a privacy review of their content.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createFileLogger(
  dir: string,
  options: { maxBytes?: number; keep?: number; echo?: boolean } = {},
): Logger {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const keep = options.keep ?? 3;
  const file = path.join(dir, 'main.log');
  mkdirSync(dir, { recursive: true });
  const rotate = (): void => {
    try {
      if (!existsSync(file) || statSync(file).size < maxBytes) return;
      rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i -= 1)
        if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    } catch {
      // Logging must never take the kiosk down.
    }
  };
  const write = (level: string, msg: string, data?: Record<string, unknown>): void => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
    if (options.echo) (level === 'error' ? console.error : console.log)(line);
    try {
      rotate();
      appendFileSync(file, `${line}\n`);
    } catch {
      // ignore
    }
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
