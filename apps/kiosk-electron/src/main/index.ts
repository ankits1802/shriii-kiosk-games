/**
 * SHRIII kiosk runtime — Electron main process (KSK-01, KSK-07, KSK-08, KSK-11).
 *
 * - One fullscreen `kiosk: true` window; contextIsolation + sandbox; no Node in the renderer;
 *   minimal typed preload bridge; devtools only in unpackaged runs.
 * - Renderer served from `app://kiosk/` (standard, secure custom scheme) with a strict CSP; the
 *   network allow-list admits only the app, the API origin and (unpackaged) the dev server.
 * - Every permission denied (no camera, ever; microphone opt-in arrives with VOX-04).
 * - Single instance, power-save blocker, watchdog (crash / hang -> reload to attract < 5 s;
 *   crash loops -> app relaunch -> out-of-service page).
 * - Encrypted SQLite outbox (per-session DEK sealed to the backend key) and a main-process uploader
 *   paused while anyone is using the kiosk; thermal printer; signed-manifest update rings.
 */
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThermalPrinter } from '@shriii/escpos-printer';
import { loadOutboxPolicy, type OutboxEncryption, SqliteOutbox } from '@shriii/outbox-sqlite';
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
} from 'electron';
import {
  IPC,
  type KioskInfo,
  LIFECYCLE_STATES,
  type LifecycleState,
} from '../shared/ipc-contract.ts';
import { serveAppRequest } from './app-protocol.ts';
import { ConfigError, type KioskConfig, resolveConfig } from './config.ts';
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  contentSecurityPolicy,
  isAllowedNavigation,
  isAllowedRequest,
} from './csp.ts';
import { createHandlers } from './ipc-handlers.ts';
import {
  loadOrCreateKek,
  loadRecipientKeys,
  plainFileStore,
  type SecretStore,
} from './keystore.ts';
import { createFileLogger, type Logger } from './log.ts';
import { createPrinter } from './printer-service.ts';
import { collectConsoleErrors, runSelfTest } from './selftest.ts';
import { assignRing } from './update-policy.ts';
import { KioskUpdater, type UpdaterLike } from './updater.ts';
import { MainUploader } from './uploader.ts';
import { RendererWatchdog, type WatchdogAction } from './watchdog.ts';

// Must run before `ready`: the app scheme behaves like https (ES modules, fetch, storage, CSP).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

if (process.env.SHRIII_KIOSK_USER_DATA) app.setPath('userData', process.env.SHRIII_KIOSK_USER_DATA);

const selfTestPath = process.env.SHRIII_KIOSK_SELFTEST ?? null;
const windowed = process.env.SHRIII_KIOSK_WINDOWED === '1' || selfTestPath !== null;

// Touch kiosk: no pinch zoom, no swipe history navigation, audio may start without a gesture.
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resourceDir = (name: string): string =>
  app.isPackaged ? path.join(process.resourcesPath, name) : path.join(distDir, name);

interface Runtime {
  cfg: KioskConfig;
  log: Logger;
  csp: string;
  outbox: SqliteOutbox | null;
  encryption: KioskInfo['encryption'];
  printer: ThermalPrinter | null;
  uploader: MainUploader | null;
  updater: KioskUpdater | null;
  watchdog: RendererWatchdog;
  window: BrowserWindow | null;
  lifecycle: LifecycleState;
}

let rt: Runtime | null = null;

function readConfigFile(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Open the outbox; any failure (unreadable KEK, bad key file, corrupt DB) leaves it unavailable. */
function openOutboxSafely(
  cfg: KioskConfig,
  log: Logger,
): { outbox: SqliteOutbox | null; encryption: KioskInfo['encryption'] } {
  try {
    return openOutbox(cfg, log);
  } catch (err) {
    // Never regenerate keys or delete data here: the kiosk keeps running (sessions cannot start,
    // the heartbeat reports it) and operations fix the device key or policy file.
    log.error('outbox could not be opened', { error: (err as Error).message });
    return { outbox: null, encryption: 'unavailable' };
  }
}

function secretStore(): SecretStore {
  if (!safeStorage.isEncryptionAvailable()) return plainFileStore;
  const backend =
    process.platform === 'linux'
      ? safeStorage.getSelectedStorageBackend()
      : process.platform === 'win32'
        ? 'dpapi'
        : 'keychain';
  return {
    protection: backend,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}

function openOutbox(
  cfg: KioskConfig,
  log: Logger,
): { outbox: SqliteOutbox | null; encryption: KioskInfo['encryption'] } {
  const userData = app.getPath('userData');
  const policy = loadOutboxPolicy(
    cfg.outboxPolicyPath ?? path.join(resourceDir('config'), 'outbox-policy.yaml'),
  );
  let encryption: OutboxEncryption;
  if (cfg.recipientKeysPath) {
    const store = secretStore();
    const { kek, created } = loadOrCreateKek(path.join(userData, 'keys'), store);
    if (created) log.info('device KEK created', { protection: store.protection });
    encryption = { mode: 'sealed', kek, recipients: loadRecipientKeys(cfg.recipientKeysPath) };
  } else if (cfg.allowPlaintextOutbox) {
    log.warn('outbox running unencrypted (none_dev): development only');
    encryption = { mode: 'none_dev' };
  } else {
    log.error('no backend recipient keys: outbox unavailable, sessions cannot start');
    return { outbox: null, encryption: 'unavailable' };
  }
  const outbox = new SqliteOutbox({
    kioskId: cfg.kioskId,
    path: path.join(userData, 'outbox.db'),
    encryption,
    policy,
    freeDiskBytes: () => {
      try {
        const s = statfsSync(userData);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
  });
  const problems = outbox.integrityCheck();
  if (problems.length > 0) log.error('outbox integrity problems', { problems });
  log.info('outbox open', { journal: outbox.journalMode, encryption: encryption.mode });
  return { outbox, encryption: encryption.mode };
}

function loadRenderer(win: BrowserWindow): void {
  const r = rt;
  if (!r) return;
  if (r.watchdog.isOutOfService) {
    void win.loadURL(`${APP_ORIGIN}/__shell/out-of-service.html`);
    return;
  }
  void win.loadURL(r.cfg.devUrl ?? `${APP_ORIGIN}/index.html`);
}

const relaunchFile = (): string => path.join(app.getPath('userData'), 'watchdog-relaunches.json');

function applyWatchdog(action: WatchdogAction): void {
  const r = rt;
  const win = r?.window;
  if (!r || !win || win.isDestroyed()) return;
  switch (action.kind) {
    case 'none':
      return;
    case 'reload':
      r.log.warn('renderer recovery: reload to attract', { reason: action.reason });
      setTimeout(() => {
        if (!win.isDestroyed()) loadRenderer(win);
      }, action.delayMs);
      return;
    case 'force_crash':
      r.log.warn('renderer hung: forcing crash', { reason: action.reason });
      win.webContents.forcefullyCrashRenderer();
      return;
    case 'relaunch_app':
      r.log.error('crash loop: relaunching app', { reason: action.reason });
      try {
        writeFileSync(relaunchFile(), JSON.stringify(r.watchdog.relaunchHistory));
      } catch {
        // best effort
      }
      shutdown();
      app.relaunch();
      app.exit(0);
      return;
    case 'out_of_service':
      r.log.error('out of service', { reason: action.reason });
      void win.loadURL(`${APP_ORIGIN}/__shell/out-of-service.html`);
      return;
  }
}

function createWindow(r: Runtime): BrowserWindow {
  const win = new BrowserWindow({
    kiosk: !windowed,
    fullscreen: !windowed,
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#b8643c',
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(distDir, 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => {
    if (!selfTestPath) win.show();
  });
  const wc = win.webContents;
  wc.on('did-finish-load', () => {
    void wc.setVisualZoomLevelLimits(1, 1);
    r.watchdog.handle({ type: 'loaded', at: Date.now() });
  });
  wc.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, r.cfg.devUrl)) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, r.cfg.devUrl)) event.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('context-menu', (event) => event.preventDefault());
  wc.on('before-input-event', (event, input) => {
    // No reload, zoom, devtools, print, find or fullscreen toggles from a stray USB keyboard.
    const key = input.key.toLowerCase();
    const mod = input.control || input.meta;
    if (['f5', 'f11', 'f12'].includes(key)) event.preventDefault();
    if (mod && ['r', 'w', 'p', 'f', 'n', 't', '+', '-', '=', '0', 'i'].includes(key))
      event.preventDefault();
    if (input.alt && ['arrowleft', 'arrowright', 'f4'].includes(key)) event.preventDefault();
  });
  if (app.isPackaged) wc.on('devtools-opened', () => wc.closeDevTools());
  wc.on('render-process-gone', (_e, details) =>
    applyWatchdog(
      r.watchdog.handle({ type: 'renderer_gone', reason: details.reason, at: Date.now() }),
    ),
  );
  win.on('unresponsive', () =>
    applyWatchdog(r.watchdog.handle({ type: 'unresponsive', at: Date.now() })),
  );
  win.on('responsive', () => r.watchdog.handle({ type: 'responsive', at: Date.now() }));
  loadRenderer(win);
  return win;
}

function hardenSession(r: Runtime): void {
  const ses = session.defaultSession;
  const roots = { renderer: resourceDir('renderer'), shell: resourceDir('static') };
  protocol.handle(APP_SCHEME, async (request) => {
    const res = await serveAppRequest({ url: request.url, method: request.method }, roots, r.csp);
    return new Response(res.body ? Buffer.from(res.body) : null, {
      status: res.status,
      headers: res.headers,
    });
  });
  const allow = { apiOrigin: r.cfg.apiOrigin, devUrl: r.cfg.devUrl, devtools: !app.isPackaged };
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = isAllowedRequest(details.url, allow);
    if (!ok) r.log.warn('blocked request', { url: details.url.slice(0, 200) });
    callback({ cancel: !ok });
  });
  // The dev server's pages get the same CSP as app:// pages.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      headers['Content-Security-Policy'] = [r.csp];
    }
    callback({ responseHeaders: headers });
  });
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    r.log.warn('permission denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  ses.on('will-download', (event) => event.preventDefault());
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const r = rt;
  if (!r?.window || event.sender !== r.window.webContents) return false;
  const url = event.senderFrame?.url ?? '';
  return (
    isAllowedNavigation(url, r.cfg.devUrl) &&
    (url.startsWith(`${APP_SCHEME}://${APP_HOST}/`) || r.cfg.devUrl !== null)
  );
}

function registerIpc(r: Runtime): void {
  const handlers = createHandlers({
    outbox: r.outbox,
    printer: r.printer,
    onOutboxWrite: () => r.uploader?.poke(),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload: unknown) => {
      if (!isTrustedSender(event))
        return { ok: false, code: 'invalid', message: 'untrusted sender' };
      return handler(payload);
    });
  }
  ipcMain.handle(IPC.info, (event): KioskInfo | null => {
    if (!isTrustedSender(event)) return null;
    return {
      platform: 'electron',
      appVersion: app.getVersion(),
      kioskId: r.cfg.kioskId,
      updateChannel: r.updater?.ring ?? null,
      encryption: r.encryption,
      printer: r.printer?.description ?? 'none',
    };
  });
  ipcMain.handle(IPC.status, (event) => {
    if (!isTrustedSender(event)) return null;
    return {
      lifecycle: r.lifecycle,
      outbox: r.outbox?.healthSync() ?? null,
      uploader: r.uploader?.current ?? null,
      update: r.updater?.current ?? null,
    };
  });
  ipcMain.on(IPC.relaunch, (event) => {
    if (isTrustedSender(event) && r.window) loadRenderer(r.window);
  });
  ipcMain.on(IPC.state, (event, state: unknown) => {
    if (!isTrustedSender(event) || !LIFECYCLE_STATES.includes(state as LifecycleState)) return;
    const s = state as LifecycleState;
    r.watchdog.handle({ type: 'heartbeat', at: Date.now() });
    if (s !== r.lifecycle) r.log.info('lifecycle', { state: s });
    r.lifecycle = s;
    r.uploader?.setLifecycleState(s);
    r.updater?.setLifecycleState(s);
  });
}

function shutdown(): void {
  const r = rt;
  if (!r) return;
  r.uploader?.stop();
  r.updater?.stop();
  try {
    r.outbox?.checkpoint();
    r.outbox?.close();
  } catch (err) {
    r.log.error('outbox close failed', { error: (err as Error).message });
  }
  r.outbox = null;
}

async function main(): Promise<void> {
  const userData = app.getPath('userData');
  const log = createFileLogger(path.join(userData, 'logs'), { echo: !app.isPackaged });
  let cfg: KioskConfig;
  try {
    cfg = resolveConfig({
      file: readConfigFile(
        process.env.SHRIII_KIOSK_CONFIG ?? path.join(userData, 'kiosk-config.json'),
      ),
      env: process.env,
      isPackaged: app.isPackaged,
      devKioskId: `kiosk-dev-${
        hostname()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 40) || 'local'
      }`,
    });
  } catch (err) {
    log.error('configuration invalid', { error: (err as Error).message });
    if (err instanceof ConfigError) {
      app.exit(78); // EX_CONFIG: the supervisor shows it on the heartbeat
      return;
    }
    throw err;
  }
  let history: number[] = [];
  try {
    history = JSON.parse(readFileSync(relaunchFile(), 'utf8')) as number[];
  } catch {
    history = [];
  }
  const { outbox, encryption } = openOutboxSafely(cfg, log);
  const printer = createPrinter(cfg.printer, path.join(userData, 'virtual-printer'));
  const r: Runtime = {
    cfg,
    log,
    csp: contentSecurityPolicy({ apiOrigin: cfg.apiOrigin, devUrl: cfg.devUrl }),
    outbox,
    encryption,
    printer,
    uploader: null,
    updater: null,
    watchdog: new RendererWatchdog({ hangTimeoutMs: cfg.hangTimeoutMs }, history),
    window: null,
    lifecycle: 'boot',
  };
  rt = r;
  if (outbox) {
    r.uploader = new MainUploader({
      outbox,
      apiOrigin: cfg.apiOrigin,
      fetch: (input, init) => net.fetch(input as string, init),
      timeoutMs: cfg.uploadTimeoutMs,
      idlePollMs: cfg.uploadIdlePollMs,
      log: (msg, data) => log.info(msg, data),
    });
    r.uploader.start();
  }
  if (app.isPackaged && !process.env.SNAP && cfg.update.feedUrl) {
    const { default: electronUpdater } = await import('electron-updater');
    const ring = assignRing(cfg.kioskId, cfg.update.ring, cfg.update.ring10Percent);
    // Manifest fetches use their own session: the default session's request allow-list admits only
    // the app and the API origin (the renderer's network), which would cancel the update feed.
    const updateSession = session.fromPartition('shriii-updater', { cache: false });
    r.updater = new KioskUpdater(
      electronUpdater.autoUpdater as unknown as UpdaterLike,
      cfg.update,
      ring,
      app.getVersion(),
      log,
      (input, init) => updateSession.fetch(input as string, init),
    );
    r.updater.start();
  }
  Menu.setApplicationMenu(null);
  hardenSession(r);
  registerIpc(r);
  powerSaveBlocker.start('prevent-display-sleep');
  r.window = createWindow(r);
  powerMonitor.on('suspend', () => r.window?.webContents.send(IPC.power, 'suspend'));
  powerMonitor.on('resume', () => r.window?.webContents.send(IPC.power, 'resume'));
  setInterval(
    () => applyWatchdog(r.watchdog.handle({ type: 'tick', at: Date.now() })),
    1000,
  ).unref();
  log.info('kiosk started', {
    version: app.getVersion(),
    kioskId: cfg.kioskId,
    packaged: app.isPackaged,
    encryption,
  });

  if (selfTestPath) {
    const win = r.window;
    const consoleErrors = collectConsoleErrors(win);
    let renderer = 'unknown';
    try {
      renderer = (
        JSON.parse(readFileSync(path.join(distDir, 'build-info.json'), 'utf8')) as {
          rendererSource: string;
        }
      ).rendererSource;
    } catch {
      renderer = 'unknown';
    }
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void runSelfTest(
          win,
          selfTestPath,
          () => ({
            electron: process.versions.electron,
            node: process.versions.node,
            packaged: app.isPackaged,
            encryption,
            journal: r.outbox?.journalMode ?? null,
            renderer,
            consoleErrorsTotal: consoleErrors.length,
          }),
          [...consoleErrors],
        ).then((ok) => {
          shutdown();
          app.exit(ok ? 0 : 1);
        });
      }, 1500);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = rt?.window;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app.on('child-process-gone', (_e, details) => {
    rt?.log.warn('child process gone', { type: details.type, reason: details.reason });
  });
  app.on('before-quit', shutdown);
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', (err) => {
    rt?.log.error('uncaught exception: relaunching', {
      error: err.message,
      stack: err.stack?.slice(0, 2000),
    });
    shutdown();
    if (!selfTestPath) app.relaunch();
    app.exit(1);
  });
  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      // A startup failure must not leave a window-less zombie process: exit so the supervisor
      // (snap daemon / systemd) restarts the kiosk and the failure shows on the heartbeat.
      const e = err instanceof Error ? err : new Error(String(err));
      rt?.log.error('startup failed', { error: e.message, stack: e.stack?.slice(0, 2000) });
      console.error('SHRIII kiosk startup failed:', e);
      shutdown();
      app.exit(70);
    });
}
