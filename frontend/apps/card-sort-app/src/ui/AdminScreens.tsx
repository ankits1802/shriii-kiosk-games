import { type FormEvent, useCallback, useState } from 'react';
import { IDENTIFIER, type StartInput, validateStart } from '../app/administration.ts';
import { ADMIN_SCRIPT, type AudioPlayer, LANGUAGES } from '../audio/slots.ts';
import type {
  AuditEntry,
  DeviceSettings,
  LanguageTag,
  OutboxItem,
  SessionRecord,
} from '../data/types.ts';
import { KEY_CARDS } from '../domain/cards.ts';
import { normaliseCode, pidFromQr } from '../domain/pid.ts';
import { PROTOCOLS } from '../domain/protocol.ts';
import { CardFace } from './CardFace.tsx';
import { QrScanner, qrScanSupported } from './QrScanner.tsx';

// ------------------------------------------------------------------------------ PIN

export function PinForm({
  mode,
  error,
  onSubmit,
  onCancel,
}: {
  mode: 'set' | 'unlock';
  error: string | null;
  onSubmit: (pin: string) => void;
  onCancel?: () => void;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'set') {
      if (!/^\d{6,12}$/.test(pin)) return setLocal('Use 6 to 12 digits.');
      if (pin !== confirm) return setLocal('The two PINs do not match.');
    }
    setLocal(null);
    onSubmit(pin);
    setPin('');
    setConfirm('');
  };
  return (
    <form className="panel narrow" onSubmit={submit} data-testid={`pin-${mode}`}>
      <h1>{mode === 'set' ? 'Set administrator PIN' : 'Administrator PIN'}</h1>
      {mode === 'set' && (
        <p className="muted">
          This tablet runs the supervised criterion card sort. Only trained administrators may
          operate it. Choose a 6-12 digit PIN.
        </p>
      )}
      <label>
        PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          name="pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      {mode === 'set' && (
        <label>
          Confirm PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            name="pin-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
          />
        </label>
      )}
      {(local ?? error) && <p className="error">{local ?? error}</p>}
      <div className="row">
        <button type="submit" className="btn primary">
          {mode === 'set' ? 'Save PIN' : 'Unlock'}
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------ settings

export const EMPTY_SETTINGS: DeviceSettings = {
  apiBaseUrl: '',
  deviceToken: '',
  deviceId: '',
  administratorId: '',
  defaultStudyId: '',
  defaultLanguage: 'hi-IN',
  audioVersion: null,
};

export function SettingsForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: DeviceSettings;
  onSave: (s: DeviceSettings) => void;
  onCancel?: () => void;
}) {
  const [s, setS] = useState<DeviceSettings>(initial);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof DeviceSettings) => ({
    name: key,
    value: (s[key] ?? '') as string,
    onChange: (e: { target: { value: string } }) =>
      setS({ ...s, [key]: key === 'audioVersion' ? e.target.value || null : e.target.value }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bad = (['deviceId', 'administratorId'] as const).filter((k) => !IDENTIFIER.test(s[k]));
    if (bad.length)
      return setError(`${bad.join(', ')} must be lower-case identifiers (a-z, 0-9, _ . : -).`);
    if (s.defaultStudyId && !IDENTIFIER.test(s.defaultStudyId))
      return setError('Study id must be a lower-case identifier.');
    if (s.apiBaseUrl && !/^https?:\/\//.test(s.apiBaseUrl))
      return setError('API URL must start with https://');
    if (s.audioVersion && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s.audioVersion))
      return setError('Audio version must be a semantic version such as 1.0.0.');
    setError(null);
    onSave({ ...s, apiBaseUrl: s.apiBaseUrl.trim() });
  };
  return (
    <form className="panel" onSubmit={submit} data-testid="settings-form">
      <h1>Device settings</h1>
      <div className="grid2">
        <label>
          Administrator id
          <input {...field('administratorId')} autoComplete="off" />
        </label>
        <label>
          Device id
          <input {...field('deviceId')} autoComplete="off" />
        </label>
        <label>
          Default study id
          <input {...field('defaultStudyId')} autoComplete="off" />
        </label>
        <label>
          Default language
          <select {...field('defaultLanguage')}>
            {LANGUAGES.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          API base URL
          <input
            {...field('apiBaseUrl')}
            placeholder="https://api.example.org"
            autoComplete="off"
          />
        </label>
        <label>
          Device token
          <input {...field('deviceToken')} type="password" autoComplete="off" />
        </label>
        <label>
          Audio version (semver, blank if not recorded)
          <input {...field('audioVersion')} placeholder="1.0.0" autoComplete="off" />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="btn primary">
          Save settings
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------ home

export function HomeScreen({
  settings,
  sessions,
  outbox,
  backend,
  online,
  syncing,
  onStart,
  onResume,
  onSync,
  onRequeue,
  onSettings,
  onAudit,
  onExport,
  onLock,
}: {
  settings: DeviceSettings;
  sessions: readonly SessionRecord[];
  outbox: readonly OutboxItem[];
  backend: string;
  online: boolean;
  syncing: boolean;
  onStart: () => void;
  onResume: (sessionId: string) => void;
  onSync: () => void;
  onRequeue: (id: string) => void;
  onSettings: () => void;
  onAudit: () => void;
  onExport: () => void;
  onLock: () => void;
}) {
  const pending = outbox.filter((o) => o.status === 'pending');
  const rejected = outbox.filter((o) => o.status === 'rejected');
  const synced = outbox.filter((o) => o.status === 'synced');
  const interrupted = sessions.filter((s) => s.status === 'in_progress');
  return (
    <div className="panel" data-testid="home">
      <header className="row spread">
        <h1>Criterion card sort</h1>
        <button type="button" className="btn secondary" onClick={onLock}>
          Lock
        </button>
      </header>
      <p className="muted">
        Administrator <b>{settings.administratorId}</b> · device <b>{settings.deviceId}</b> ·
        storage {backend} · {online ? 'online' : 'offline'}
      </p>
      <div className="row">
        <button
          type="button"
          className="btn primary big"
          onClick={onStart}
          data-testid="new-administration"
        >
          New administration
        </button>
      </div>
      {interrupted.length > 0 && (
        <section>
          <h2>Interrupted administrations</h2>
          {interrupted.map((s) => (
            <div key={s.sessionId} className="row spread item">
              <span>
                {s.pid} · {s.studyId}/{s.occasionId} · started{' '}
                {new Date(s.startedAt).toLocaleString()}
              </span>
              <button type="button" className="btn secondary" onClick={() => onResume(s.sessionId)}>
                Resume
              </button>
            </div>
          ))}
        </section>
      )}
      <section>
        <h2>Sync queue</h2>
        <p data-testid="outbox-summary">
          {pending.length} pending · {rejected.length} need attention · {synced.length} synced
        </p>
        {!settings.apiBaseUrl && (
          <p className="warn">No API URL configured: records stay on this tablet.</p>
        )}
        <div className="row">
          <button
            type="button"
            className="btn secondary"
            onClick={onSync}
            disabled={syncing || !settings.apiBaseUrl}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button type="button" className="btn secondary" onClick={onExport}>
            Export JSON
          </button>
          <button type="button" className="btn secondary" onClick={onAudit}>
            Audit trail
          </button>
          <button type="button" className="btn secondary" onClick={onSettings}>
            Settings
          </button>
        </div>
        {[...rejected, ...pending].map((o) => (
          <div key={o.id} className="row spread item" data-testid="outbox-item">
            <span>
              {o.payload.administration.pid} · {o.status} · attempts {o.attempts}
              {o.lastError ? ` · ${o.lastError}` : ''}
            </span>
            {o.status === 'rejected' && (
              <button type="button" className="btn secondary" onClick={() => onRequeue(o.id)}>
                Retry
              </button>
            )}
          </div>
        ))}
      </section>
      <section>
        <h2>Recent administrations</h2>
        {sessions.slice(0, 15).map((s) => (
          <div key={s.sessionId} className="item" data-testid="session-row">
            {s.pid} · {s.studyId}/{s.occasionId} · {s.language} · {s.protocol.protocolId} ·{' '}
            {s.status}
            {s.scores ? ` · ${s.scores.trialsAdministered} cards` : ''}
          </div>
        ))}
        {sessions.length === 0 && <p className="muted">None yet.</p>}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------ start

export function StartForm({
  settings,
  onStart,
  onCancel,
}: {
  settings: DeviceSettings;
  onStart: (input: StartInput) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [pidSource, setPidSource] = useState<'qr' | 'typed'>('typed');
  const [studyId, setStudyId] = useState(settings.defaultStudyId);
  const [occasionId, setOccasionId] = useState('t1');
  const [wave, setWave] = useState('1');
  const [language, setLanguage] = useState<LanguageTag>(settings.defaultLanguage);
  const [protocolId, setProtocolId] = useState('wcst64-standard');
  const [scanning, setScanning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const onScan = useCallback((text: string) => {
    const pid = pidFromQr(text);
    if (pid) {
      setCode(pid);
      setPidSource('qr');
      setScanning(false);
      setErrors([]);
    } else setErrors(['Scanned QR does not contain a valid participant code.']);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const protocol = PROTOCOLS[protocolId];
    if (!protocol) return;
    const input: StartInput = {
      pid: normaliseCode(code),
      pidSource,
      studyId: studyId.trim(),
      occasionId: occasionId.trim(),
      wave: Number(wave),
      language,
      protocol,
      administratorId: settings.administratorId,
      deviceId: settings.deviceId,
      audioVersion: settings.audioVersion,
    };
    const errs = validateStart(input);
    setErrors(errs);
    if (errs.length === 0) onStart(input);
  };

  return (
    <form className="panel" onSubmit={submit} data-testid="start-form">
      <h1>New administration</h1>
      <p className="muted">
        Supervised sites only. Confirm the participant has given criterion consent.
      </p>
      <div className="grid2">
        <label>
          Participant code
          <input
            name="pid"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setPidSource('typed');
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <div className="row end">
          {qrScanSupported() && (
            <button type="button" className="btn secondary" onClick={() => setScanning(true)}>
              Scan QR card
            </button>
          )}
        </div>
        {scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}
        <label>
          Study id
          <input
            name="study"
            value={studyId}
            onChange={(e) => setStudyId(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Occasion id
          <input
            name="occasion"
            value={occasionId}
            onChange={(e) => setOccasionId(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Wave
          <input
            name="wave"
            inputMode="numeric"
            value={wave}
            onChange={(e) => setWave(e.target.value)}
          />
        </label>
        <label>
          Language of spoken instructions
          <select
            name="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguageTag)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.tag} value={l.tag}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Protocol
          <select
            name="protocol"
            value={protocolId}
            onChange={(e) => setProtocolId(e.target.value)}
          >
            {Object.values(PROTOCOLS).map((p) => (
              <option key={p.protocolId} value={p.protocolId}>
                {p.deckSize} cards · {p.consecutiveCorrectToComplete} in a row · {p.maxCategories}{' '}
                categories
              </option>
            ))}
          </select>
        </label>
      </div>
      {errors.length > 0 && (
        <ul className="error">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button type="submit" className="btn primary" data-testid="start-submit">
          Continue to instructions
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------ instructions

export function InstructionsScreen({
  session,
  audio,
  onBegin,
  onCancel,
}: {
  session: SessionRecord;
  audio: AudioPlayer;
  onBegin: () => void;
  onCancel: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const play = async () => {
    const ok = await audio.play('instructions');
    setMissing(!ok);
  };
  return (
    <div className="panel" data-testid="instructions">
      <h1>Instructions</h1>
      <p className="muted">
        Participant {session.pid} · {session.language} · {session.protocol.deckSize} cards. Seat the
        participant and show the four cards below.
      </p>
      <div className="keys small">
        {KEY_CARDS.map((c) => (
          <div key={`${c.colour}-${c.shape}`} className="key-card static">
            <CardFace card={c} />
          </div>
        ))}
      </div>
      <div className="row">
        <button type="button" className="btn secondary" onClick={() => void play()}>
          Play spoken instructions
        </button>
      </div>
      {missing && (
        <p className="warn">
          No recording for {session.language} yet. {ADMIN_SCRIPT.instructions}
        </p>
      )}
      {!missing && <p className="muted small-text">{ADMIN_SCRIPT.instructions}</p>}
      <div className="row">
        <button
          type="button"
          className="btn primary big"
          onClick={onBegin}
          data-testid="begin-test"
        >
          Hand over and begin
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>
          Cancel administration
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------ summary

export function SummaryScreen({ session, onDone }: { session: SessionRecord; onDone: () => void }) {
  return (
    <div className="panel narrow" data-testid="summary">
      <h1>Administration {session.status === 'completed' ? 'complete' : 'ended'}</h1>
      <p>
        Participant {session.pid} · {session.scores?.trialsAdministered ?? 0} cards administered.
      </p>
      <p className="muted">
        {session.status === 'completed'
          ? 'Records are saved on this tablet and queued for sync. Scores are computed by the research server and are not shown here.'
          : `Stopped: ${session.abortReason ?? 'unknown reason'}. Partial administrations are kept on this tablet and are not synced.`}
      </p>
      <button type="button" className="btn primary" onClick={onDone} data-testid="summary-done">
        Done
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------ abort

export const ABORT_REASONS = [
  'participant_withdrew',
  'participant_distressed',
  'interruption',
  'device_problem',
  'wrong_participant',
] as const;

export function AbortPanel({
  onResume,
  onAbort,
}: {
  onResume: () => void;
  onAbort: (reason: string) => void;
}) {
  const [reason, setReason] = useState<string>(ABORT_REASONS[0]);
  return (
    <div className="panel narrow" data-testid="abort-panel">
      <h1>Administration paused</h1>
      <label>
        Reason to stop
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {ABORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button type="button" className="btn primary" onClick={onResume}>
          Continue the test
        </button>
        <button type="button" className="btn danger" onClick={() => onAbort(reason)}>
          Stop administration
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------ audit

export function AuditView({
  entries,
  verified,
  onBack,
}: {
  entries: readonly AuditEntry[];
  verified: { ok: boolean; brokenAt: number | null } | null;
  onBack: () => void;
}) {
  return (
    <div className="panel" data-testid="audit">
      <header className="row spread">
        <h1>Audit trail</h1>
        <button type="button" className="btn secondary" onClick={onBack}>
          Back
        </button>
      </header>
      {verified && (
        <p className={verified.ok ? 'ok' : 'error'} data-testid="audit-verify">
          {verified.ok
            ? `Hash chain intact (${entries.length} entries)`
            : `Hash chain broken at entry ${verified.brokenAt}`}
        </p>
      )}
      <table className="audit-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Actor</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {[...entries]
            .reverse()
            .slice(0, 300)
            .map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td>{e.actor}</td>
                <td>{e.event}</td>
                <td className="mono">{JSON.stringify(e.details)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
