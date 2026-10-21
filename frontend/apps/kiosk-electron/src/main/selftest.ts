/**
 * Built-in runtime self-test (`SHRIII_KIOSK_SELFTEST=<result.json>`), used by the end-to-end smoke
 * test against the unpacked and the packed app. It checks the KSK-01 acceptance criteria in the real
 * Electron runtime and writes a JSON report, then exits (0 = all passed).
 */
import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

export interface SelfTestCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}

function waitForLoad(win: BrowserWindow, timeoutMs: number): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('renderer did not reload in time')), timeoutMs);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(Date.now() - started);
    });
  });
}

const SID = '01928c6e-7d3a-7b2c-8f00-1234567890ab';

/** Collect renderer console errors from the first load on (attach before loading). */
export function collectConsoleErrors(win: BrowserWindow): string[] {
  const errors: string[] = [];
  win.webContents.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { level?: string | number; message?: string };
    const level = e.level ?? args[1];
    const message = e.message ?? String(args[2] ?? '');
    if (level === 'error' || level === 3) errors.push(message.slice(0, 300));
  });
  return errors;
}

export async function runSelfTest(
  win: BrowserWindow,
  resultPath: string,
  extra: () => Record<string, unknown>,
  consoleErrors: readonly string[] = [],
): Promise<boolean> {
  const checks: SelfTestCheck[] = [];
  checks.push({
    name: 'renderer: kiosk app booted without console errors (incl. CSP violations)',
    ok: consoleErrors.length === 0,
    detail: consoleErrors.slice(0, 10),
  });
  const js = <T>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true) as Promise<T>;
  const check = async (
    name: string,
    fn: () => Promise<{ ok: boolean; detail?: unknown }>,
  ): Promise<void> => {
    try {
      const r = await fn();
      checks.push({ name, ...r });
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message });
    }
  };

  await check('isolation: bridge present, no Node globals', async () => {
    const r = await js<{ bridge: string; require: string; process: string; origin: string }>(
      `({ bridge: typeof window.shriiiKiosk, require: typeof require, process: typeof process, origin: location.origin })`,
    );
    return {
      ok:
        r.bridge === 'object' &&
        r.require === 'undefined' &&
        r.process === 'undefined' &&
        r.origin === 'app://kiosk',
      detail: r,
    };
  });

  await check('renderer: kiosk canvas mounted', async () => {
    // Pixi initialises asynchronously (WebGL context, textures): poll for up to 10 s.
    const r = await js<{
      canvases: number;
      title: string;
      waitedMs: number;
      body: string;
    }>(`(async () => {
      const t0 = performance.now();
      while (document.querySelectorAll('canvas').length === 0 && performance.now() - t0 < 10000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        canvases: document.querySelectorAll('canvas').length,
        title: document.title,
        waitedMs: Math.round(performance.now() - t0),
        body: document.body.innerHTML.slice(0, 300),
      };
    })()`);
    const placeholder =
      r.title === 'SHRIII Kiosk' && r.canvases === 0 && extra().renderer === 'placeholder';
    return { ok: r.canvases > 0 || placeholder, detail: r };
  });

  await check('csp: external fetch is blocked', async () => {
    const r = await js<{ result: string; violations: number }>(`(async () => {
      let violations = 0;
      document.addEventListener('securitypolicyviolation', () => { violations += 1; });
      const result = await fetch('https://example.com/').then(() => 'allowed', () => 'blocked');
      await new Promise((r) => setTimeout(r, 100));
      return { result, violations };
    })()`);
    return { ok: r.result === 'blocked' && r.violations > 0, detail: r };
  });

  await check('csp: remote script injection is blocked', async () => {
    const r = await js<string>(`new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://example.com/x.js';
      s.onload = () => resolve('loaded');
      s.onerror = () => resolve('blocked');
      document.head.appendChild(s);
    })`);
    return { ok: r === 'blocked', detail: r };
  });

  await check('permissions: camera is denied', async () => {
    const r = await js<string>(
      `navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => 'denied:' + e.name) : Promise.resolve('denied:no-mediaDevices')`,
    );
    return { ok: r.startsWith('denied'), detail: r };
  });

  await check('outbox: gapless append through the bridge', async () => {
    const r = await js<unknown>(`(async () => {
      const o = window.shriiiKiosk.outbox;
      const sid = '${SID}';
      const n = await o.nextSeq(sid);
      if (!n.ok) return n;
      const a = await o.appendAt(sid, n.value, { event_id: 'selftest', session_id: sid, seq: n.value, event_type: 'selftest' });
      const conflict = await o.appendAt(sid, n.value, { event_id: 'dup', session_id: sid, seq: n.value, event_type: 'selftest' });
      const health = await o.health();
      await o.purgeSession(sid);
      return { start: n.value, a, conflict, health };
    })()`);
    const v = r as { a?: { ok: boolean }; conflict?: { ok: boolean; code?: string } };
    return {
      ok: v.a?.ok === true && v.conflict?.ok === false && v.conflict.code === 'seq_conflict',
      detail: r,
    };
  });

  await check('printer: report prints on the configured printer', async () => {
    const r = await js<unknown>(
      `window.shriiiKiosk.printer.printReport({ qrUrl: 'https://shriii.example/r/selftest' })`,
    );
    const v = r as { ok: boolean; value?: { ok: boolean } };
    return { ok: v.ok && v.value?.ok === true, detail: r };
  });

  await check('watchdog: killed renderer relaunches to attract within 5 s', async () => {
    const reload = waitForLoad(win, 10_000);
    win.webContents.forcefullyCrashRenderer();
    const ms = await reload;
    const origin = await js<string>('location.href');
    return {
      ok: ms < 5000 && origin.startsWith('app://kiosk/'),
      detail: { reloadMs: ms, href: origin },
    };
  });

  const ok = checks.every((c) => c.ok);
  writeFileSync(resultPath, JSON.stringify({ ok, checks, ...extra() }, null, 2));
  return ok;
}
