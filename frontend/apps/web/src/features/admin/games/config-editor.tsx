'use client';

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  LockIcon,
  RotateCcwIcon,
  WandSparklesIcon,
  XCircleIcon,
} from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Section } from '@/components/data/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { canonicalJson, downloadText, parseJson, sha256Hex } from '../shared/canonical-json';
import { Hash, NeedsApi } from '../shared/components';
import { checkGameConfig, LOCKED_FIELDS, MEASUREMENT_FIELDS } from './config-checks';
import { DiffList } from './diff-list';

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * JSON editor for a draft game configuration with live schema, invariant and change-control checks.
 * There is no API to save a draft yet, so a valid result is downloaded for commit under
 * content/games (then Sync creates the draft version server-side).
 */
export function ConfigEditor({
  base,
  sourcePath,
  readOnly,
}: {
  readonly base: Record<string, unknown>;
  readonly sourcePath: string | null;
  readonly readOnly: boolean;
}) {
  const initial = useMemo(() => pretty(base), [base]);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const deferred = useDeferredValue(text);
  const parsed = useMemo(() => parseJson(deferred), [deferred]);
  const check = useMemo(
    () => (parsed.ok ? checkGameConfig(parsed.value, base) : null),
    [parsed, base],
  );
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!parsed.ok) {
      setHash(null);
      return;
    }
    try {
      void sha256Hex(canonicalJson(parsed.value)).then((h) => live && setHash(h));
    } catch {
      setHash(null);
    }
    return () => {
      live = false;
    };
  }, [parsed]);

  const errors = check?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = check?.issues.filter((i) => i.severity === 'warning') ?? [];
  const dirty = text !== initial;
  const lines = text.split('\n').length;
  const fileName = sourcePath?.split('/').pop() ?? `${String(base.module_id ?? 'game')}.json`;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3">
        {readOnly && (
          <Alert>
            <LockIcon aria-hidden="true" />
            <AlertTitle>Read-only: this version is approved</AlertTitle>
            <AlertDescription>
              Approved versions are frozen. Edit the latest draft, or bump the version in
              content/games and sync to start a new one.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {lines} lines · canonical sha256 <Hash value={hash} />
            {sourcePath && (
              <>
                {' '}
                · source <code className="font-mono">{sourcePath}</code>
              </>
            )}
          </p>
          {!readOnly && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!parsed.ok}
                onClick={() => parsed.ok && setText(pretty(parsed.value))}
              >
                <WandSparklesIcon aria-hidden="true" />
                Format
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty}
                onClick={() => setText(initial)}
              >
                <RotateCcwIcon aria-hidden="true" />
                Reset
              </Button>
              <Button
                size="sm"
                disabled={!dirty || !check?.valid}
                onClick={() => parsed.ok && downloadText(fileName, pretty(parsed.value))}
              >
                <DownloadIcon aria-hidden="true" />
                Download {fileName}
              </Button>
            </div>
          )}
        </div>
        <Textarea
          aria-label="Game configuration JSON"
          spellCheck={false}
          readOnly={readOnly}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-[34rem] resize-y font-mono text-xs leading-5"
        />
        {!readOnly && <NeedsApi endpoint="gameDraftCreate" />}
      </div>

      <div className="space-y-5">
        <Section
          title="Validation"
          description="game-config.v1 schema, invariants and change control"
        >
          {!parsed.ok ? (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <XCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Not valid JSON: {parsed.message}
            </p>
          ) : errors.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-success" data-testid="config-valid">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              {dirty ? 'Valid draft' : 'Valid'}
              {warnings.length > 0 &&
                ` with ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}
            </p>
          ) : (
            <p
              className="flex items-center gap-2 text-sm text-destructive"
              data-testid="config-invalid"
            >
              <XCircleIcon className="size-4" aria-hidden="true" />
              {errors.length} problem{errors.length > 1 ? 's' : ''} block this draft
            </p>
          )}
          {check && check.issues.length > 0 && (
            <ul
              className="max-h-72 space-y-1.5 overflow-auto text-xs"
              aria-label="Validation issues"
            >
              {check.issues.map((i) => (
                <li key={`${i.source}:${i.path}:${i.message}`} className="flex gap-2">
                  {i.severity === 'error' ? (
                    <XCircleIcon
                      className="mt-0.5 size-3.5 shrink-0 text-destructive"
                      aria-label="Error"
                    />
                  ) : (
                    <AlertTriangleIcon
                      className="mt-0.5 size-3.5 shrink-0 text-warning"
                      aria-label="Warning"
                    />
                  )}
                  <span>
                    <code className="font-mono text-muted-foreground">{i.path || '/'}</code>{' '}
                    {i.message} <span className="text-muted-foreground">({i.source})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {check && check.diff.length > 0 && (
          <Section
            title={`Changes (${check.diff.length})`}
            description="Against the version you opened"
          >
            <DiffList diff={check.diff} max={30} />
          </Section>
        )}

        <Section
          title="Locked fields"
          description="Science, measurement-tagging and privacy fields change only through a signed amendment (PLT-09)"
        >
          <details className="group text-xs" data-testid="locked-fields">
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
              {LOCKED_FIELDS.length} locked paths
            </summary>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {LOCKED_FIELDS.map((f) => (
                <li key={f.pattern} className="flex gap-2">
                  <LockIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span>
                    <code className="font-mono text-foreground/80">{f.pattern}</code> {f.reason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <p className="pt-2 text-xs font-medium">Allowed with a warning</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {MEASUREMENT_FIELDS.map((f) => (
              <li key={f.pattern} className="flex gap-2">
                <AlertTriangleIcon
                  className="mt-0.5 size-3 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  <code className="font-mono text-foreground/80">{f.pattern}</code> {f.reason}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
