/**
 * Preload bridge (contextIsolation + sandbox). Exposes exactly the typed {@link ShriiiKioskBridge}
 * as `window.shriiiKiosk`: no Node APIs, no file system, no generic IPC send/invoke. Bundled to a
 * single CommonJS file (sandboxed preloads cannot load modules other than `electron`).
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import {
  type ConsentState,
  IPC,
  type IpcResult,
  type LifecycleState,
  type PowerEvent,
  type PrintReportRequest,
  type ShriiiKioskBridge,
} from '../shared/ipc-contract.ts';

const invoke = <T>(channel: string, payload?: unknown): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>;

const bridge: ShriiiKioskBridge = {
  platform: 'electron',
  getInfo: () => ipcRenderer.invoke(IPC.info),
  relaunchToAttract: () => ipcRenderer.send(IPC.relaunch),
  reportState: (state: LifecycleState) => ipcRenderer.send(IPC.state, state),
  onPowerEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, evt: PowerEvent): void => listener(evt);
    ipcRenderer.on(IPC.power, handler);
    return () => {
      ipcRenderer.removeListener(IPC.power, handler);
    };
  },
  outbox: {
    appendAt: (sessionId: string, seq: number, event: unknown) =>
      invoke(IPC.outboxAppendAt, { sessionId, seq, event }),
    nextSeq: (sessionId: string) => invoke(IPC.outboxNextSeq, { sessionId }),
    setConsent: (sessionId: string, state: ConsentState) =>
      invoke(IPC.outboxSetConsent, { sessionId, state }),
    purgeSession: (sessionId: string, tombstone?: { seq: number; event: unknown }) =>
      invoke(IPC.outboxPurgeSession, { sessionId, tombstone: tombstone ?? null }),
    closeSession: (sessionId: string) => invoke(IPC.outboxCloseSession, { sessionId }),
    recordDecline: () => invoke(IPC.outboxRecordDecline),
    stats: () => invoke(IPC.outboxStats),
    openSessions: () => invoke(IPC.outboxOpenSessions),
    sessionEvents: (sessionId: string) => invoke(IPC.outboxSessionEvents, { sessionId }),
    pendingCount: () => invoke(IPC.outboxPendingCount),
    health: () => invoke(IPC.outboxHealth),
  },
  printer: {
    printReport: (request: PrintReportRequest) => invoke(IPC.printerPrint, request),
    status: () => invoke(IPC.printerStatus),
  },
};

contextBridge.exposeInMainWorld('shriiiKiosk', bridge);
