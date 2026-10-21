import { Capacitor } from '@capacitor/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  abortAdministration,
  completeAdministration,
  recordTrial,
  resumeAdministration,
  type StartInput,
  startAdministration,
} from './app/administration.ts';
import { createAudioPlayer } from './audio/slots.ts';
import type { CardSortStore } from './data/store.ts';
import type { AuditEntry, DeviceSettings, OutboxItem, SessionRecord } from './data/types.ts';
import type { KeyIndex } from './domain/cards.ts';
import { type EngineState, respond } from './domain/engine.ts';
import { requeue, syncOutbox } from './sync/outbox.ts';
import {
  AbortPanel,
  AuditView,
  EMPTY_SETTINGS,
  HomeScreen,
  InstructionsScreen,
  PinForm,
  SettingsForm,
  StartForm,
  SummaryScreen,
} from './ui/AdminScreens.tsx';
import { FinishedScreen, TestScreen } from './ui/TestScreen.tsx';

type View =
  | 'setPin'
  | 'setup'
  | 'locked'
  | 'home'
  | 'settings'
  | 'audit'
  | 'start'
  | 'instructions'
  | 'test'
  | 'pinGate'
  | 'paused'
  | 'finished'
  | 'summary';

const ADMIN_VIEWS: ReadonlySet<View> = new Set<View>(['home', 'settings', 'audit', 'start']);
const IDLE_LOCK_MS = 5 * 60_000;
const SYNC_INTERVAL_MS = 2 * 60_000;

/** Feedback override for the browser smoke test only (ignored inside the native app). */
function feedbackOverride(): number | null {
  if (Capacitor.isNativePlatform()) return null;
  const raw = new URLSearchParams(globalThis.location?.search ?? '').get('feedbackMs');
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function App({ store }: { store: CardSortStore }) {
  const [view, setView] = useState<View | null>(null);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditOk, setAuditOk] = useState<{ ok: boolean; brokenAt: number | null } | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const gateNext = useRef<View>('home');
  const engineRef = useRef<EngineState | null>(null);
  engineRef.current = engine;

  const actor = settings?.administratorId || 'administrator';
  const audio = useMemo(() => createAudioPlayer(session?.language ?? 'en-IN'), [session?.language]);
  const feedbackMs = feedbackOverride() ?? session?.protocol.feedbackMs ?? 1200;

  const refresh = useCallback(async () => {
    setSessions(await store.listSessions());
    setOutbox(await store.listOutbox());
  }, [store]);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    (async () => {
      const s = (await store.getSettings()) ?? null;
      setSettings(s);
      await refresh();
      await store.audit('system', 'app_started', {
        storage: store.kv.kind,
        native: Capacitor.isNativePlatform(),
      });
      setView(!(await store.hasPin()) ? 'setPin' : 'locked');
    })().catch((e: unknown) => setFatal(e instanceof Error ? e.message : String(e)));
  }, [store, refresh]);

  // ---------------------------------------------------------------- sync
  const runSync = useCallback(
    async (force: boolean) => {
      if (!settings?.apiBaseUrl || syncing) return;
      setSyncing(true);
      try {
        await syncOutbox(
          { store, settings, fetch: globalThis.fetch.bind(globalThis), actor },
          { force },
        );
      } finally {
        setSyncing(false);
        await refresh();
      }
    },
    [settings, store, actor, refresh, syncing],
  );
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void runSyncRef.current(true);
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = setInterval(() => void runSyncRef.current(false), SYNC_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(timer);
    };
  }, []);

  // ---------------------------------------------------------------- idle lock (admin views only)
  useEffect(() => {
    if (!view || !ADMIN_VIEWS.has(view)) return;
    let timer = setTimeout(() => lock('idle'), IDLE_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lock('idle'), IDLE_LOCK_MS);
    };
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  });

  const lock = (reason: 'manual' | 'idle') => {
    void store.audit(actor, 'locked', { reason });
    setView('locked');
  };

  // ---------------------------------------------------------------- PIN handlers
  const onSetPin = async (pin: string) => {
    await store.setPin(pin);
    await store.audit('administrator', 'pin_set', {});
    setView(settings ? 'home' : 'setup');
  };

  const checkPin = async (pin: string): Promise<boolean> => {
    const res = await store.checkPin(pin);
    if (res.ok) {
      setPinError(null);
      return true;
    }
    await store.audit(actor, 'unlock_failed', { locked_until: res.lockedUntil });
    setPinError(
      res.lockedUntil
        ? `Too many attempts. Try again after ${new Date(res.lockedUntil).toLocaleTimeString()}.`
        : `Wrong PIN. ${res.remaining} attempts left.`,
    );
    return false;
  };

  const onUnlock = async (pin: string) => {
    if (!(await checkPin(pin))) return;
    await store.audit(actor, 'unlocked', {});
    setView(settings ? 'home' : 'setup');
    void runSync(false);
  };

  const onGate = async (pin: string) => {
    if (!(await checkPin(pin))) return;
    await store.audit(actor, 'admin_gate_opened', { session_id: session?.sessionId ?? null });
    setView(gateNext.current);
  };

  const openGate = (next: View) => {
    gateNext.current = next;
    setPinError(null);
    setView('pinGate');
  };

  // ---------------------------------------------------------------- settings
  const onSaveSettings = async (s: DeviceSettings) => {
    await store.saveSettings(s);
    await store.audit(s.administratorId, 'settings_changed', {
      api_base_url: s.apiBaseUrl,
      device_id: s.deviceId,
      administrator_id: s.administratorId,
      default_study_id: s.defaultStudyId,
      default_language: s.defaultLanguage,
      audio_version: s.audioVersion,
      device_token_set: s.deviceToken.length > 0,
    });
    setSettings(s);
    setView('home');
  };

  // ---------------------------------------------------------------- administration
  const onStart = async (input: StartInput) => {
    const started = await startAdministration(store, input);
    setSession(started.session);
    setEngine(started.engine);
    setView('instructions');
  };

  const onResume = async (sessionId: string) => {
    const resumed = await resumeAdministration(store, sessionId, actor);
    setSession(resumed.session);
    setEngine(resumed.engine);
    if (resumed.engine.finished) {
      const done = await completeAdministration(store, resumed.session, resumed.engine);
      setSession(done);
      await refresh();
      setView('summary');
      return;
    }
    setView('instructions');
  };

  const onRespond = useCallback(
    async (key: KeyIndex, latencyMs: number) => {
      const current = engineRef.current;
      if (!current || !session) throw new Error('no active administration');
      const next = respond(current, key, latencyMs, new Date().toISOString());
      await recordTrial(store, session, next.trial); // persist before advancing
      engineRef.current = next.state;
      setEngine(next.state);
      if (next.state.finished) {
        const done = await completeAdministration(store, session, next.state);
        setSession(done);
        await refresh();
        void runSyncRef.current(true);
      }
      return { correct: next.trial.correct, finished: next.state.finished };
    },
    [session, store, refresh],
  );

  const onAbort = async (reason: string) => {
    if (!session || !engineRef.current) return;
    const aborted = await abortAdministration(store, session, engineRef.current, reason, actor);
    setSession(aborted);
    await refresh();
    setView('summary');
  };

  const onExport = async () => {
    const trials = await Promise.all(
      sessions.map(async (s) => [s.sessionId, await store.listTrials(s.sessionId)]),
    );
    const data = {
      exported_at: new Date().toISOString(),
      device_id: settings?.deviceId,
      sessions,
      trials: Object.fromEntries(trials),
      outbox,
      audit: await store.listAudit(),
    };
    await store.audit(actor, 'exported', { sessions: sessions.length });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `card-sort-export-${settings?.deviceId ?? 'device'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openAudit = async () => {
    setAudit(await store.listAudit());
    setAuditOk(await store.verifyAudit());
    setView('audit');
  };

  // ---------------------------------------------------------------- render
  if (fatal) return <div className="panel narrow error">Storage failed to open: {fatal}</div>;
  if (!view) return <div className="panel narrow muted">Loading…</div>;

  switch (view) {
    case 'setPin':
      return <PinForm mode="set" error={null} onSubmit={(p) => void onSetPin(p)} />;
    case 'locked':
      return <PinForm mode="unlock" error={pinError} onSubmit={(p) => void onUnlock(p)} />;
    case 'pinGate':
      return (
        <PinForm
          mode="unlock"
          error={pinError}
          onSubmit={(p) => void onGate(p)}
          onCancel={() => setView(gateNext.current === 'paused' ? 'test' : 'finished')}
        />
      );
    case 'setup':
    case 'settings':
      return (
        <SettingsForm
          initial={settings ?? EMPTY_SETTINGS}
          onSave={(s) => void onSaveSettings(s)}
          {...(view === 'settings' ? { onCancel: () => setView('home') } : {})}
        />
      );
    case 'home':
      if (!settings) return null;
      return (
        <HomeScreen
          settings={settings}
          sessions={sessions}
          outbox={outbox}
          backend={store.kv.kind}
          online={online}
          syncing={syncing}
          onStart={() => setView('start')}
          onResume={(id) => void onResume(id)}
          onSync={() => void runSync(true)}
          onRequeue={(id) => void requeue(store, id, actor).then(refresh)}
          onSettings={() => setView('settings')}
          onAudit={() => void openAudit()}
          onExport={() => void onExport()}
          onLock={() => lock('manual')}
        />
      );
    case 'audit':
      return <AuditView entries={audit} verified={auditOk} onBack={() => setView('home')} />;
    case 'start':
      if (!settings) return null;
      return (
        <StartForm
          settings={settings}
          onStart={(i) => void onStart(i)}
          onCancel={() => setView('home')}
        />
      );
    case 'instructions':
      if (!session) return null;
      return (
        <InstructionsScreen
          session={session}
          audio={audio}
          onBegin={() => {
            void store.audit(actor, 'test_handed_over', { session_id: session.sessionId });
            void audio.play('begin');
            setView('test');
          }}
          onCancel={() => void onAbort('cancelled_before_start')}
        />
      );
    case 'test':
      if (!engine || !session) return null;
      return (
        <TestScreen
          engine={engine}
          feedbackMs={feedbackMs}
          audio={audio}
          onRespond={onRespond}
          onFinished={() => {
            void audio.play('finished');
            setView('finished');
          }}
          onAdminRequest={() => openGate('paused')}
        />
      );
    case 'paused':
      return <AbortPanel onResume={() => setView('test')} onAbort={(r) => void onAbort(r)} />;
    case 'finished':
      return <FinishedScreen onAdmin={() => openGate('summary')} />;
    case 'summary':
      if (!session) return null;
      return (
        <SummaryScreen
          session={session}
          onDone={() => {
            setSession(null);
            setEngine(null);
            void refresh();
            setView('home');
          }}
        />
      );
  }
}
