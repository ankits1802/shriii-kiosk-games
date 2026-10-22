'use client';

/**
 * Researcher-administered mode (spec section 5): a tablet-friendly, full-screen administration of one
 * criterion instrument to one participant in a supervised session. Large touch targets, audio-assist
 * slots per item, progress, embedded attention checks, the administrator id on every record, and no
 * scores shown afterwards (field administrators may never read scores).
 */
import { useMutation } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FileKeyIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  SkipForwardIcon,
  Volume2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { useInstruments, useInstrumentVersion, useParticipant, useStudyDesign } from '../api/hooks';
import type { SubmissionOut } from '../api/types';
import { Field } from '../components/form-dialog';
import { StudySelect, useFocusStudy } from '../components/shared';
import {
  type AnswerState,
  buildPlan,
  buildSubmission,
  deviceIdFrom,
  isValidValue,
  itemWording,
  type LicensedSource,
  type PlanItem,
  parseLicensedSource,
  progress,
  type SubmissionContext,
  submissionIssues,
} from '../lib/administration';

const LANGUAGES = ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'] as const;
type Phase = 'setup' | 'items' | 'review' | 'done';

export function AdministerPage({ instrumentId }: { readonly instrumentId: string }) {
  const api = useApi();
  const { principal } = useAuth();
  const instruments = useInstruments();
  const inst = instruments.data?.find((i) => i.instrument_id === instrumentId) ?? null;
  const version = useInstrumentVersion(instrumentId, inst?.current_version ?? null);
  const { study, studies, setStudyId } = useFocusStudy();
  const design = useStudyDesign(study?.study_id ?? null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [pidInput, setPidInput] = useState('');
  const [pid, setPid] = useState<string | null>(null);
  const participant = useParticipant(pid);
  const [occasion, setOccasion] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>('hi-IN');
  const [mode, setMode] = useState<'self' | 'read_aloud'>('read_aloud');
  const [adminId, setAdminId] = useState('');
  const [raterRole, setRaterRole] = useState<SubmissionContext['raterRole']>('self');
  const [ratedPid, setRatedPid] = useState('');
  const [source, setSource] = useState<LicensedSource | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Map<string, AnswerState>>(new Map());
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<SubmissionOut | null>(null);
  const [deviceId, setDeviceId] = useState('web-tablet');
  const shownAt = useRef<number>(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setDeviceId(deviceIdFrom(typeof window === 'undefined' ? null : window.localStorage));
  }, []);
  useEffect(() => {
    if (principal && !adminId) setAdminId(principal.sub);
  }, [principal, adminId]);
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enrollment =
    participant.data?.enrollments.find((e) => e.study_id === study?.study_id) ??
    participant.data?.enrollments[0];
  const personBlock =
    (['A', 'B', 'C'] as const).find((b) => b === enrollment?.criterion_block) ?? null;
  const plan = useMemo(() => {
    const def = version.data?.definition;
    return def && inst
      ? buildPlan(
          inst.instrument_id,
          version.data?.version ?? inst.current_version,
          def,
          personBlock,
        )
      : null;
  }, [version.data, inst, personBlock]);
  const occasionId = occasion ?? design.data?.occasions[0]?.occasion_id ?? null;
  const ctx: SubmissionContext = {
    pid: pid ?? '',
    studyId: study?.study_id ?? '',
    occasionId: occasionId ?? '',
    wave: design.data?.occasions.find((o) => o.occasion_id === occasionId)?.wave ?? 1,
    language,
    mode,
    administratorId: adminId,
    deviceId,
    audioVersion: null,
    raterRole,
    ratedPid: raterRole === 'partner' ? ratedPid.trim() : null,
  };
  const prog = plan ? progress(plan, answers) : null;
  const item = plan?.items[index] ?? null;
  const consentOk = participant.data?.consent.criterion === true;
  const active = participant.data?.participant.status === 'active';
  const issues = plan ? submissionIssues(plan, answers, source, ctx) : [];

  const enterFullscreen = useCallback(async () => {
    try {
      await rootRef.current?.requestFullscreen?.();
    } catch {
      // Full screen is a convenience; the overlay already covers the console.
    }
  }, []);
  const exitFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // ignore
    }
  }, []);

  // Restart the latency clock whenever a new item is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index changes mean a new item is on screen
  useEffect(() => {
    if (phase === 'items') shownAt.current = performance.now();
  }, [phase, index]);
  const wantFullscreen = useRef(false);
  useEffect(() => {
    if (phase === 'items' && wantFullscreen.current) {
      wantFullscreen.current = false;
      void enterFullscreen();
    }
  }, [phase, enterFullscreen]);

  const answer = (value: number | null, skipped = false) => {
    if (!item) return;
    const next = new Map(answers);
    next.set(item.responseId, {
      value: skipped ? null : value,
      skipped,
      latencyMs: performance.now() - shownAt.current,
    });
    setAnswers(next);
    if (item.measure === null) {
      window.setTimeout(() => {
        if (plan && index + 1 < plan.items.length) setIndex(index + 1);
        else setPhase('review');
      }, 220);
    }
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error('No instrument loaded.');
      return (await unwrap(
        api.POST('/api/v1/assessment-responses', {
          body: buildSubmission(plan, answers, source, ctx),
        }),
      )) as SubmissionOut;
    },
    onSuccess: (r) => {
      setResult(r);
      setPhase('done');
    },
  });

  const resetForNext = () => {
    setAnswers(new Map());
    setIndex(0);
    setResult(null);
    setPid(null);
    setPidInput('');
    setPhase('setup');
    submit.reset();
  };

  if (instruments.isPending) return <LoadingState rows={6} />;
  if (!inst)
    return <ErrorState error={new Error(`Instrument ${instrumentId} is not in the registry.`)} />;

  if (phase === 'setup') {
    return (
      <div className="space-y-6">
        <PageHeader
          title={`Administer ${inst.short_name}`}
          description="Supervised, researcher-administered session on a tablet. Set up the session here, then hand over the full-screen view. Item wording comes from the licensed source file on this device; it is never uploaded."
          meta={
            <Link
              href={`/research/instruments/${encodeURIComponent(instrumentId)}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              ← {inst.name}
            </Link>
          }
        />
        {(inst.licensing_warnings ?? []).length > 0 && (
          <Alert variant="warning">
            <AlertTitle>Licensing not cleared</AlertTitle>
            <AlertDescription>
              {(inst.licensing_warnings ?? []).join(' · ')} The API will refuse the submission.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
            <Field id="adm-study" label="Study">
              <StudySelect
                value={study?.study_id ?? null}
                studies={studies}
                onChange={setStudyId}
              />
            </Field>
            <Field id="adm-occ" label="Occasion">
              <Select value={occasionId ?? ''} onValueChange={setOccasion}>
                <SelectTrigger id="adm-occ" className="w-full">
                  <SelectValue placeholder="Occasion" />
                </SelectTrigger>
                <SelectContent>
                  {(design.data?.occasions ?? []).map((o) => (
                    <SelectItem key={o.occasion_id} value={o.occasion_id}>
                      {o.occasion_id} · {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="adm-pid"
              label="Participant id (pid)"
              hint="From the pairing card. Checks consent and the rotating form."
            >
              <div className="flex gap-2">
                <Input
                  id="adm-pid"
                  value={pidInput}
                  onChange={(e) => setPidInput(e.target.value.toUpperCase())}
                  className="font-mono"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setPid(pidInput.trim() || null);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPid(pidInput.trim() || null)}
                >
                  Check
                </Button>
              </div>
            </Field>
            <Field id="adm-admin" label="Administrator id">
              <Input id="adm-admin" value={adminId} onChange={(e) => setAdminId(e.target.value)} />
            </Field>
            <Field id="adm-lang" label="Language">
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="adm-lang" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="adm-mode"
              label="Mode"
              hint="Read aloud: the administrator reads each item (audio-assisted for low literacy)."
            >
              <Select value={mode} onValueChange={(v) => setMode(v as 'self' | 'read_aloud')}>
                <SelectTrigger id="adm-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read_aloud">Read aloud</SelectItem>
                  <SelectItem value="self">Self-completed</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="adm-rater" label="Rater">
              <Select
                value={raterRole}
                onValueChange={(v) => setRaterRole(v as SubmissionContext['raterRole'])}
              >
                <SelectTrigger id="adm-rater" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="self">Self-report</SelectItem>
                  <SelectItem value="partner">Partner rating (co-play)</SelectItem>
                  <SelectItem value="observer">Observer</SelectItem>
                  <SelectItem value="administrator">Administrator</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {raterRole === 'partner' && (
              <Field id="adm-rated" label="Rated participant pid">
                <Input
                  id="adm-rated"
                  value={ratedPid}
                  onChange={(e) => setRatedPid(e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </Field>
            )}
            <Field
              id="adm-source"
              label="Licensed source file (optional)"
              className="sm:col-span-2"
              hint={
                sourceError ??
                (sourceName
                  ? `${sourceName}: wording for ${source?.size ?? 0} items loaded for this session only.`
                  : 'JSON or CSV with item_id, language, text, expected_response. Without it, placeholders are shown and the administrator reads from the paper form.')
              }
            >
              <Input
                id="adm-source"
                type="file"
                accept=".json,.csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  setSourceError(null);
                  if (!f) return;
                  try {
                    setSource(parseLicensedSource(await f.text()));
                    setSourceName(f.name);
                  } catch (err) {
                    setSource(null);
                    setSourceName(null);
                    setSourceError(err instanceof Error ? err.message : 'Could not read the file.');
                  }
                }}
              />
            </Field>
          </div>
          <div className="space-y-3">
            <div className="rounded-lg border bg-card p-4 text-sm">
              <p className="mb-2 font-semibold">Session check</p>
              {!pid ? (
                <p className="text-muted-foreground">Enter the participant id.</p>
              ) : participant.isPending ? (
                <LoadingState rows={1} />
              ) : participant.isError ? (
                <p className="text-destructive">{errorMessage(participant.error)}</p>
              ) : participant.data ? (
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2">
                    <StatusBadge status={active ? 'active' : 'withdrawn'} /> participant status
                  </li>
                  <li className="flex items-center gap-2">
                    <StatusBadge
                      status={consentOk ? 'granted' : 'missing'}
                      tone={consentOk ? 'good' : 'critical'}
                      label={consentOk ? 'criterion consent recorded' : 'no criterion consent'}
                    />
                  </li>
                  <li>
                    Rotating form: <Badge variant="outline">{personBlock ?? 'none'}</Badge>{' '}
                    {plan && plan.plannedMissing.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        ({plan.plannedMissing.length} items planned missing)
                      </span>
                    )}
                  </li>
                </ul>
              ) : null}
            </div>
            {plan && (
              <div className="rounded-lg border bg-card p-4 text-sm">
                <p className="font-semibold">
                  {plan.items.length} items · ~{plan.estimatedMinutes ?? '?'} min ·{' '}
                  {plan.audioAssisted ? 'audio-assisted' : 'no audio'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {plan.items.filter((i) => i.attentionCheck).length} attention check(s) ·{' '}
                  {['A', 'B', 'C'].includes(plan.block)
                    ? `rotating form ${plan.block}`
                    : `block ${plan.block} (common items; this instrument has no rotating forms)`}{' '}
                  · device {deviceId}
                </p>
              </div>
            )}
            <Button
              size="lg"
              className="h-14 w-full text-base"
              disabled={
                !plan ||
                !pid ||
                !participant.data ||
                !active ||
                !consentOk ||
                !occasionId ||
                !adminId
              }
              onClick={() => {
                wantFullscreen.current = true;
                setPhase('items');
                setIndex(0);
              }}
            >
              Start administration <ArrowRightIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="administer-overlay"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <header className="flex items-center justify-between gap-3 border-b px-6 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {inst.short_name} · {language} · {mode === 'read_aloud' ? 'read aloud' : 'self'}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            pid {pid} · administrator {adminId} · {occasionId}
          </p>
        </div>
        {prog && phase !== 'done' && (
          <div className="flex min-w-60 flex-1 items-center gap-3 px-6">
            <div
              className="h-3 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Items answered"
              aria-valuemin={0}
              aria-valuemax={prog.total}
              aria-valuenow={prog.answered + prog.skipped}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${prog.share * 100}%` }}
              />
            </div>
            <span className="text-sm tabular-nums text-muted-foreground">
              {phase === 'items' ? index + 1 : prog.total} / {prog.total}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={() => void (fullscreen ? exitFullscreen() : enterFullscreen())}
          >
            {fullscreen ? <MinimizeIcon aria-hidden="true" /> : <MaximizeIcon aria-hidden="true" />}
          </Button>
          {phase !== 'done' && (
            <Button
              variant="outline"
              onClick={() => {
                void exitFullscreen();
                setPhase('setup');
              }}
            >
              <PauseIcon aria-hidden="true" /> Pause
            </Button>
          )}
        </div>
      </header>

      {phase === 'items' && item && plan && (
        <ItemScreen
          key={item.responseId}
          item={item}
          plan={plan}
          language={language}
          source={source}
          current={answers.get(item.responseId) ?? null}
          onAnswer={answer}
          onBack={() => setIndex(Math.max(0, index - 1))}
          onNext={() => (index + 1 < plan.items.length ? setIndex(index + 1) : setPhase('review'))}
          canBack={index > 0}
        />
      )}

      {phase === 'review' && plan && prog && (
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 p-8">
          <h1 className="text-2xl font-semibold">Check before saving</h1>
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              ['Answered', prog.answered],
              ['Skipped', prog.skipped],
              ['Not reached', prog.remaining],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl border bg-card p-6">
                <p className="text-sm text-muted-foreground">{k}</p>
                <p className="text-4xl font-semibold tabular-nums">{v}</p>
              </div>
            ))}
          </div>
          {issues.length > 0 && (
            <Alert variant="warning">
              <AlertTitle>Fix before saving</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-5">
                  {issues.map((i) => (
                    <li key={i.message}>{i.message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {submit.isError && (
            <Alert variant="destructive">
              <AlertTitle>Not saved</AlertTitle>
              <AlertDescription>{errorMessage(submit.error)}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              variant="outline"
              className="h-14 flex-1 text-base"
              onClick={() => {
                setIndex(0);
                setPhase('items');
              }}
            >
              <ArrowLeftIcon aria-hidden="true" /> Review answers
            </Button>
            <Button
              size="lg"
              className="h-14 flex-1 text-base"
              disabled={issues.length > 0 || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Saving…' : 'Save administration'}
            </Button>
          </div>
        </main>
      )}

      {phase === 'done' && result && (
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
          <CheckCircle2Icon className="size-20 text-success" aria-hidden="true" />
          <h1 className="text-3xl font-semibold">Saved. Thank you.</h1>
          <p className="text-muted-foreground">
            {result.responses.length} responses stored with administrator {adminId}. Scoring run{' '}
            <span className="font-mono">{result.scoring_run_id.slice(0, 8)}</span> recorded; no
            scores are shown here.
          </p>
          <div className="flex gap-3">
            <Button size="lg" className="h-14 px-8 text-base" onClick={resetForNext}>
              Next participant
            </Button>
            <Button size="lg" variant="outline" className="h-14 px-8 text-base" asChild>
              <Link href="/research/instruments" onClick={() => void exitFullscreen()}>
                Done
              </Link>
            </Button>
          </div>
        </main>
      )}
    </div>
  );
}

function ItemScreen({
  item,
  plan,
  language,
  source,
  current,
  onAnswer,
  onBack,
  onNext,
  canBack,
}: {
  readonly item: PlanItem;
  readonly plan: ReturnType<typeof buildPlan>;
  readonly language: string;
  readonly source: LicensedSource | null;
  readonly current: AnswerState | null;
  readonly onAnswer: (value: number | null, skipped?: boolean) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly canBack: boolean;
}) {
  const wording = itemWording(item, language, source);
  const [audioState, setAudioState] = useState<'idle' | 'playing' | 'missing'>('idle');
  const [numeric, setNumeric] = useState(
    current?.value === null || current?.value === undefined ? '' : String(current.value),
  );
  const audioKey = `criterion.${plan.instrumentId}.${item.itemId}`;
  const play = () => {
    const audio = new Audio(`/audio/${language}/${audioKey}.opus`);
    setAudioState('playing');
    audio.onended = () => setAudioState('idle');
    audio.onerror = () => setAudioState('missing');
    void audio.play().catch(() => setAudioState('missing'));
  };
  const values =
    plan.scale.min !== null && plan.scale.max !== null
      ? Array.from(
          { length: plan.scale.max - plan.scale.min + 1 },
          (_, i) => (plan.scale.min as number) + i,
        )
      : [];
  const numericValid = numeric !== '' && isValidValue(plan.scale, item, Number(numeric));
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {item.responseId}
          </Badge>
          {item.attentionCheck && (
            <Badge variant="warning" title="Instructed-response item (administrator view)">
              attention check
            </Badge>
          )}
          {item.reverseKeyed && <Badge variant="secondary">reverse-keyed</Badge>}
        </div>
        {plan.audioAssisted && (
          <Button
            variant="outline"
            size="lg"
            className="h-12"
            onClick={play}
            disabled={audioState === 'playing'}
            aria-label="Play item audio"
          >
            <Volume2Icon aria-hidden="true" />
            {audioState === 'missing'
              ? 'No recording yet'
              : audioState === 'playing'
                ? 'Playing…'
                : 'Play audio'}
          </Button>
        )}
      </div>
      <section aria-live="polite" className="flex flex-1 flex-col justify-center gap-3 text-center">
        <p
          className={cn(
            'mx-auto max-w-3xl text-3xl leading-snug font-medium',
            !wording.licensed && 'text-muted-foreground italic',
          )}
        >
          {wording.text}
        </p>
        {!wording.licensed && (
          <p className="text-sm text-muted-foreground">
            Placeholder: read item {item.number} from the licensed form (
            {item.sourceReference ?? 'licensed source'}).
          </p>
        )}
        {audioState === 'missing' && (
          <p className="text-xs text-muted-foreground">
            Audio slot <span className="font-mono">{audioKey}</span> ({language}) has no approved
            recording.
          </p>
        )}
      </section>
      {item.measure === null ? (
        <fieldset
          aria-label="Response"
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, values.length)}, minmax(0, 1fr))` }}
        >
          {values.map((v, i) => {
            const selected = current?.value === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={selected}
                aria-label={`Response ${v}`}
                onClick={() => onAnswer(v)}
                className={cn(
                  'flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border-2 bg-card p-4 text-2xl font-semibold shadow-sm transition active:scale-[0.98]',
                  selected
                    ? 'border-primary bg-primary/10 ring-4 ring-primary/20'
                    : 'hover:border-primary/50',
                )}
              >
                <span aria-hidden="true" className="flex items-end gap-1">
                  {values.map((dot, k) => (
                    <span
                      key={`dot-${dot}`}
                      className={cn('rounded-full', k <= i ? 'bg-primary' : 'bg-muted')}
                      style={{ width: 10, height: 10 + k * 6 }}
                    />
                  ))}
                </span>
                {v}
              </button>
            );
          })}
        </fieldset>
      ) : (
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
          <label htmlFor="measure-input" className="text-lg font-medium">
            {item.measure.replaceAll('_', ' ')}
          </label>
          <Input
            id="measure-input"
            type="number"
            inputMode="decimal"
            min={0}
            value={numeric}
            onChange={(e) => setNumeric(e.target.value)}
            className="h-16 text-center text-3xl"
          />
          <Button
            size="lg"
            className="h-14 w-full text-base"
            disabled={!numericValid}
            onClick={() => {
              onAnswer(Number(numeric));
              onNext();
            }}
          >
            Record
          </Button>
        </div>
      )}
      <nav className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          size="lg"
          className="h-14 px-6 text-base"
          onClick={onBack}
          disabled={!canBack}
        >
          <ArrowLeftIcon aria-hidden="true" /> Back
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="h-14 px-6 text-base"
          onClick={() => {
            onAnswer(null, true);
            if (item.measure !== null) onNext();
          }}
        >
          <SkipForwardIcon aria-hidden="true" /> Prefer not to answer
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-14 px-6 text-base"
          onClick={onNext}
          disabled={!current}
        >
          Next <ArrowRightIcon aria-hidden="true" />
        </Button>
      </nav>
      <p className="text-center text-xs text-muted-foreground">
        <FileKeyIcon className="mr-1 inline size-3.5" aria-hidden="true" />
        Responses are saved only when the administration is submitted.
      </p>
    </main>
  );
}
