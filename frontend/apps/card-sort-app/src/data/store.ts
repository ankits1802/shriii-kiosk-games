import { canonicalJson, hashPin, type PinHash, sha256Hex, verifyPin } from './crypto.ts';
import type { KvBackend } from './kv.ts';
import type {
  AuditEntry,
  DeviceSettings,
  OutboxItem,
  SessionRecord,
  TrialRecord,
} from './types.ts';

export const GENESIS_HASH = '0'.repeat(64);
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCKOUT_MS = 60_000;

const pad = (n: number, width = 10): string => String(n).padStart(width, '0');

interface PinState {
  readonly pin: PinHash;
  readonly failures: number;
  readonly lockedUntil: number;
}

export type PinCheck = { ok: true } | { ok: false; lockedUntil: number | null; remaining: number };

/**
 * Domain persistence for the card-sort app on top of a {@link KvBackend}: settings and the
 * administrator PIN, sessions with their append-only trial log, the sync outbox and a
 * hash-chained, append-only audit trail.
 */
export class CardSortStore {
  private auditTail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly kv: KvBackend,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    await this.kv.open();
  }

  // ------------------------------------------------------------------ settings and PIN

  getSettings(): Promise<DeviceSettings | undefined> {
    return this.kv.get<DeviceSettings>('settings', 'device');
  }

  async saveSettings(settings: DeviceSettings): Promise<void> {
    await this.kv.put('settings', 'device', settings);
  }

  async hasPin(): Promise<boolean> {
    return (await this.kv.get<PinState>('settings', 'pin')) !== undefined;
  }

  async setPin(pin: string): Promise<void> {
    if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN must be 6-12 digits');
    await this.kv.put('settings', 'pin', { pin: await hashPin(pin), failures: 0, lockedUntil: 0 });
  }

  async checkPin(pin: string): Promise<PinCheck> {
    const state = await this.kv.get<PinState>('settings', 'pin');
    if (!state) return { ok: false, lockedUntil: null, remaining: 0 };
    const nowMs = this.now().getTime();
    if (state.lockedUntil > nowMs)
      return { ok: false, lockedUntil: state.lockedUntil, remaining: 0 };
    if (await verifyPin(pin, state.pin)) {
      await this.kv.put('settings', 'pin', { ...state, failures: 0, lockedUntil: 0 });
      return { ok: true };
    }
    const failures = state.failures + 1;
    const locked = failures >= MAX_PIN_FAILURES;
    await this.kv.put('settings', 'pin', {
      ...state,
      failures: locked ? 0 : failures,
      lockedUntil: locked ? nowMs + PIN_LOCKOUT_MS : 0,
    });
    return {
      ok: false,
      lockedUntil: locked ? nowMs + PIN_LOCKOUT_MS : null,
      remaining: locked ? 0 : MAX_PIN_FAILURES - failures,
    };
  }

  // ------------------------------------------------------------------ sessions and trials

  async saveSession(session: SessionRecord): Promise<void> {
    await this.kv.put('sessions', session.sessionId, session);
  }

  getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.kv.get<SessionRecord>('sessions', sessionId);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const all = await this.kv.list<SessionRecord>('sessions');
    return all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async appendTrial(sessionId: string, trial: TrialRecord): Promise<void> {
    await this.kv.put('trials', `${sessionId}:${pad(trial.index, 4)}`, trial);
  }

  listTrials(sessionId: string): Promise<TrialRecord[]> {
    return this.kv.list<TrialRecord>('trials', `${sessionId}:`);
  }

  // ------------------------------------------------------------------ outbox

  async putOutbox(item: OutboxItem): Promise<void> {
    await this.kv.put('outbox', item.id, item);
  }

  getOutbox(id: string): Promise<OutboxItem | undefined> {
    return this.kv.get<OutboxItem>('outbox', id);
  }

  listOutbox(): Promise<OutboxItem[]> {
    return this.kv.list<OutboxItem>('outbox');
  }

  // ------------------------------------------------------------------ audit trail

  /** Append an audit entry; entries are serialised so the hash chain never forks. */
  audit(actor: string, event: string, details: Record<string, unknown> = {}): Promise<AuditEntry> {
    const next = this.auditTail.then(async () => {
      const all = await this.kv.list<AuditEntry>('audit');
      const last = all[all.length - 1];
      const body = {
        seq: (last?.seq ?? 0) + 1,
        at: this.now().toISOString(),
        actor,
        event,
        details,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry: AuditEntry = { ...body, hash: await sha256Hex(canonicalJson(body)) };
      await this.kv.put('audit', pad(entry.seq), entry);
      return entry;
    });
    this.auditTail = next.catch(() => undefined);
    return next;
  }

  listAudit(): Promise<AuditEntry[]> {
    return this.kv.list<AuditEntry>('audit');
  }

  /** Recompute the hash chain; `brokenAt` is the first sequence number that fails. */
  async verifyAudit(): Promise<{ ok: boolean; brokenAt: number | null; entries: number }> {
    const all = await this.listAudit();
    let prev = GENESIS_HASH;
    for (const [i, e] of all.entries()) {
      const { hash, ...body } = e;
      if (e.seq !== i + 1 || e.prevHash !== prev || (await sha256Hex(canonicalJson(body))) !== hash)
        return { ok: false, brokenAt: e.seq, entries: all.length };
      prev = hash;
    }
    return { ok: true, brokenAt: null, entries: all.length };
  }
}
