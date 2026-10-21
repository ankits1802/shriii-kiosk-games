/**
 * Electron main process for the kiosk build (KSK-01 scaffold).
 *
 * - One fullscreen `kiosk: true` window; contextIsolation + sandbox; no Node in the renderer.
 * - Strict CSP: only the app itself (and the configured API origin for uploads); no remote scripts.
 * - Devtools only in unpackaged (development) runs; zoom, navigation and new windows are blocked.
 * - Permission handler denies everything; camera/video capture is never granted (no camera APIs).
 * - Power-save blocker keeps the display awake; a crashed renderer is reloaded to attract.
 *
 * Packaging (signed snap on Ubuntu Core) and the SQLite outbox adapter are later features; the
 * renderer currently uses the IndexedDB outbox.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, session } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Vite dev server URL for development (`SHRIII_KIOSK_DEV_URL=http://localhost:5173`). */
const devUrl = process.env.SHRIII_KIOSK_DEV_URL ?? null;
/** API origin allowed by the CSP for event uploads (must match VITE_API_BASE at build time). */
const apiOrigin = process.env.SHRIII_API_ORIGIN ?? '';
const rendererIndex = path.resolve(here, '..', '..', 'dist', 'index.html');

function contentSecurityPolicy(): string {
  const connect = ["'self'", apiOrigin, devUrl ? `${devUrl} ws://localhost:*` : '']
    .filter(Boolean)
    .join(' ');
  return [
    "default-src 'self'",
    `script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

let mainWindow: BrowserWindow | null = null;

function loadRenderer(win: BrowserWindow): void {
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(rendererIndex);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#b8643c',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    void win.webContents.setVisualZoomLevelLimits(1, 1);
  });
  // No navigation away from the app and no new windows.
  win.webContents.on('will-navigate', (event, url) => {
    if (!devUrl || !url.startsWith(devUrl)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Watchdog: a crashed or killed renderer relaunches to attract (consented events stay in the outbox).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[kiosk] renderer gone', details.reason);
    setTimeout(() => loadRenderer(win), 500);
  });
  win.on('unresponsive', () => {
    console.error('[kiosk] renderer unresponsive; reloading');
    loadRenderer(win);
  });
  loadRenderer(win);
  return win;
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
      },
    });
  });
  // Deny every permission request (camera/video is never granted; mic opt-in arrives with VOX-04).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

ipcMain.on('kiosk:relaunch', () => {
  if (mainWindow) loadRenderer(mainWindow);
});
ipcMain.handle('kiosk:app-version', () => app.getVersion());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  hardenSession();
  powerSaveBlocker.start('prevent-display-sleep');
  mainWindow = createWindow();
  powerMonitor.on('suspend', () => mainWindow?.webContents.send('kiosk:power', 'suspend'));
  powerMonitor.on('resume', () => mainWindow?.webContents.send('kiosk:power', 'resume'));
});

app.on('window-all-closed', () => {
  app.quit();
});
