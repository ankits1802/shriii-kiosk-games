'use client';

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileAudioIcon,
  InfoIcon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { NeedsApi } from '../shared/components';
import {
  type CheckStatus,
  type DecodedAudio,
  evaluateTake,
  measureTake,
  overallStatus,
  parseWav,
  type QcCheck,
  type TakeMeasurement,
} from './audio-qc';
import type { QcThresholds } from './content-types';

async function decode(file: File): Promise<DecodedAudio> {
  const buffer = await file.arrayBuffer();
  const isWav = file.type.includes('wav') || /\.wave?$/i.test(file.name);
  if (isWav) return parseWav(buffer);
  // Other formats: the browser decoder (resamples to the context rate; the file's own rate is unknown).
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const audio = await ctx.decodeAudioData(buffer);
  return {
    sampleRate: audio.sampleRate,
    channels: Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)),
    sourceSampleRate: null,
    sourceChannels: audio.numberOfChannels,
  };
}

const ICON: Record<CheckStatus, typeof CheckCircle2Icon> = {
  pass: CheckCircle2Icon,
  warn: AlertTriangleIcon,
  fail: XCircleIcon,
  info: InfoIcon,
};
const ICON_CLASS: Record<CheckStatus, string> = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  info: 'text-muted-foreground',
};
const OVERALL: Record<
  CheckStatus,
  { label: string; tone: 'good' | 'warning' | 'critical' | 'neutral' }
> = {
  pass: { label: 'passes QC', tone: 'good' },
  warn: { label: 'needs review', tone: 'warning' },
  fail: { label: 'fails QC', tone: 'critical' },
  info: { label: 'checked', tone: 'neutral' },
};

/**
 * Audio slot for one line × language: pick a take, measure it in the browser against qc.yaml and see
 * pass/warn/fail per check. Uploading into the manifest needs an API endpoint that does not exist yet.
 */
export function AudioSlot({
  lineId,
  language,
  targetDurationMs,
  qc,
  recordingStatus,
  voiceForbidden,
}: {
  readonly lineId: string;
  readonly language: string;
  readonly targetDurationMs: number;
  readonly qc: QcThresholds;
  readonly recordingStatus: string;
  readonly voiceForbidden: boolean;
}) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ m: TakeMeasurement; checks: QcCheck[] } | null>(null);

  const analyse = async (f: File) => {
    setFile(f);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const audio = await decode(f);
      const m = measureTake(audio, qc);
      setResult({ m, checks: evaluateTake(m, qc, { targetDurationMs }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not decode this file.');
    } finally {
      setBusy(false);
    }
  };

  const overall = result ? overallStatus(result.checks) : null;

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid={`audio-slot-${language}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <FileAudioIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">Audio slot</span>
          <code className="font-mono text-xs text-muted-foreground">
            {lineId} · {language}
          </code>
          <StatusBadge status={recordingStatus} />
        </div>
        <div>
          <input
            id={inputId}
            type="file"
            accept="audio/wav,audio/x-wav,.wav,audio/ogg,audio/opus,.opus,audio/flac,.flac,audio/mpeg"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void analyse(f);
              e.target.value = '';
            }}
          />
          <Button asChild variant="outline" size="sm">
            <label htmlFor={inputId} className="cursor-pointer">
              <UploadIcon aria-hidden="true" />
              {file ? 'Check another take' : 'Check a take'}
            </label>
          </Button>
        </div>
      </div>
      {voiceForbidden && (
        <p className="text-xs text-muted-foreground">
          This line is on the never-voice list: it is never routed to the speakers (headset only
          where allowed).
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Target {(targetDurationMs / 1000).toFixed(2)} s · loudness {qc.targetLufs} ±{' '}
        {qc.toleranceLu} LU · true peak ≤ {qc.truePeakCeilingDbtp} dBTP
        (tools/audio-pipeline/config/qc.yaml). Measured locally; nothing leaves this browser.
      </p>
      {busy && (
        <p className="text-sm text-muted-foreground" role="status">
          Measuring {file?.name}…
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {result && overall && file && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{file.name}</span>
            <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            <StatusBadge
              status={overall}
              tone={OVERALL[overall].tone}
              label={OVERALL[overall].label}
            />
          </div>
          <ul className="space-y-1 text-xs" aria-label="QC checks">
            {result.checks.map((c) => {
              const Icon = ICON[c.status];
              return (
                <li key={c.id} className="flex gap-2">
                  <Icon
                    className={`mt-0.5 size-3.5 shrink-0 ${ICON_CLASS[c.status]}`}
                    aria-label={c.status}
                  />
                  <span>
                    <span className="font-medium">{c.label}</span>{' '}
                    <span className="text-muted-foreground">{c.detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <Button size="sm" disabled title="The upload endpoint does not exist yet">
            <UploadIcon aria-hidden="true" />
            Upload to manifest slot
          </Button>
        </div>
      )}
      <NeedsApi endpoint="audioUpload" compact />
    </div>
  );
}
