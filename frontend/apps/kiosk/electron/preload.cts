/**
 * Minimal typed preload bridge (contextIsolation + sandbox). Exposes only what the renderer needs;
 * no Node APIs, no file system, no arbitrary IPC. Sandboxed preloads must be CommonJS.
 */
import electron = require('electron');

type PowerEvent = 'suspend' | 'resume';

const bridge = {
  platform: 'electron' as const,
  /** App version from the main process. */
  getAppVersion: (): Promise<string> =>
    electron.ipcRenderer.invoke('kiosk:app-version') as Promise<string>,
  /** Reload the renderer to the attract screen (watchdog / admin). */
  relaunchToAttract: (): void => electron.ipcRenderer.send('kiosk:relaunch'),
  /** Subscribe to OS power events; returns an unsubscribe function. */
  onPowerEvent: (listener: (event: PowerEvent) => void): (() => void) => {
    const handler = (_e: unknown, evt: PowerEvent): void => listener(evt);
    electron.ipcRenderer.on('kiosk:power', handler);
    return () => {
      electron.ipcRenderer.removeListener('kiosk:power', handler);
    };
  },
};

electron.contextBridge.exposeInMainWorld('shriiiKiosk', bridge);

export type ShriiiKioskBridge = typeof bridge;
