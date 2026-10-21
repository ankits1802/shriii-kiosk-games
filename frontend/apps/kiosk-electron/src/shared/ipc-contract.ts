/**
 * The typed IPC contract between the kiosk renderer (through the preload bridge) and the main
 * process. This file is bundled into both the preload script and the main process; it has no
 * runtime dependencies.
 *
 * Design rules:
 * - The renderer never gets Node, the file system or arbitrary IPC: only the methods below.
 * - Every payload is validated in the main process (see `main/ipc-validation.ts`) and every
 *   handler checks that the sender is the kiosk window loaded from `app://kiosk/`.
 * - Uploads run in the main process; the renderer has no network path to the API (CSP allows the
 *   API origin only for future renderer features and in development).
 */

export const IPC = {
  info: 'kiosk:info',
  relaunch: 'kiosk:relaunch',
  state: 'kiosk:state',
  power: 'kiosk:power',
  outboxAppendAt: 'outbox:append-at',
  outboxNextSeq: 'outbox:next-seq',
  outboxSetConsent: 'outbox:set-consent',
  outboxPurgeSession: 'outbox:purge-session',
  outboxCloseSession: 'outbox:close-session',
  outboxRecordDecline: 'outbox:record-decline',
  outboxStats: 'outbox:stats',
  outboxOpenSessions: 'outbox:open-sessions',
  outboxSessionEvents: 'outbox:session-events',
  outboxPendingCount: 'outbox:pending-count',
  outboxHealth: 'outbox:health',
  printerPrint: 'printer:print-report',
  printerStatus: 'printer:status',
  status: 'kiosk:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Session lifecycle states reported by the renderer (KSK-02); drives upload pause and updates. */
export const LIFECYCLE_STATES = [
  'boot',
  'attract',
  'languageSelect',
  'consent',
  'bands',
  'practiceWarmup',
  'play',
  'report',
  'survey',
  'contactOptIn',
  'farewell',
  'wipe',
  'admin',
  'out_of_service',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export type PowerEvent = 'suspend' | 'resume';

export interface KioskInfo {
  readonly platform: 'electron';
  readonly appVersion: string;
  readonly kioskId: string;
  readonly updateChannel: string | null;
  readonly encryption: 'sealed' | 'none_dev' | 'unavailable';
  readonly printer: string;
}

export type ConsentState = 'pending' | 'granted' | 'declined';

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'seq_conflict' | 'outbox_full' | 'unavailable' | 'invalid' | 'error';
      readonly message: string;
      /** For `seq_conflict`: the seq the main process expects next. */
      readonly expected?: number;
    };

export interface OpenSessionInfo {
  readonly sessionId: string;
  readonly consent: ConsentState;
  readonly nextSeq: number;
}

export interface OutboxStats {
  readonly pendingEvents: number;
  readonly inflightEvents: number;
  readonly acknowledgedEvents: number;
  readonly sessions: number;
  readonly sessionsAwaitingConsent: number;
  readonly openBatches: number;
  readonly declinedCount: number;
  readonly lastAckAt: number | null;
}

export interface OutboxHealthView {
  readonly canStartSession: boolean;
  readonly alerts: readonly string[];
  readonly unsyncedEvents: number;
  readonly oldestUnsyncedAgeMs: number | null;
  readonly storedBytes: number;
  readonly quotaBytes: number;
}

export interface PrintReportRequest {
  /** RGBA pixels of the rendered report page. */
  readonly rgba?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  /** Retrieval URL printed as a raster QR under the picture. */
  readonly qrUrl?: string | null;
}

export type PrintReportResult =
  | { readonly ok: true; readonly paperNearEnd: boolean }
  | { readonly ok: false; readonly reason: string };

export interface PrinterStatusView {
  readonly available: boolean;
  readonly description: string;
  readonly online?: boolean;
  readonly paperNearEnd?: boolean;
  readonly paperOut?: boolean;
  readonly coverOpen?: boolean;
  readonly error?: string;
}

/** The `window.shriiiKiosk` bridge exposed by the preload script. */
export interface ShriiiKioskBridge {
  readonly platform: 'electron';
  getInfo(): Promise<KioskInfo>;
  /** Reload the renderer to the attract screen (watchdog / admin). */
  relaunchToAttract(): void;
  /** Report the session lifecycle state; doubles as the renderer liveness heartbeat. */
  reportState(state: LifecycleState): void;
  onPowerEvent(listener: (event: PowerEvent) => void): () => void;
  readonly outbox: {
    appendAt(sessionId: string, seq: number, event: unknown): Promise<IpcResult<number>>;
    nextSeq(sessionId: string): Promise<IpcResult<number>>;
    setConsent(sessionId: string, state: ConsentState): Promise<IpcResult<null>>;
    /** Purge a session; with `tombstone` (built for `seq`), keep only that event for upload. */
    purgeSession(
      sessionId: string,
      tombstone?: { readonly seq: number; readonly event: unknown },
    ): Promise<IpcResult<null>>;
    closeSession(sessionId: string): Promise<IpcResult<null>>;
    recordDecline(): Promise<IpcResult<null>>;
    stats(): Promise<IpcResult<OutboxStats>>;
    openSessions(): Promise<IpcResult<readonly OpenSessionInfo[]>>;
    sessionEvents(sessionId: string): Promise<IpcResult<unknown[]>>;
    pendingCount(): Promise<IpcResult<number>>;
    health(): Promise<IpcResult<OutboxHealthView>>;
  };
  readonly printer: {
    printReport(request: PrintReportRequest): Promise<IpcResult<PrintReportResult>>;
    status(): Promise<IpcResult<PrinterStatusView>>;
  };
}

/** Heartbeat cadence the renderer must keep (the watchdog treats silence as a hang). */
export const HEARTBEAT_INTERVAL_MS = 2000;
