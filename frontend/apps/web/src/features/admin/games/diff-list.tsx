import { LockIcon } from 'lucide-react';
import type { DiffEntry } from '../shared/canonical-json';
import { lockedReason } from './config-checks';

function show(value: unknown): string {
  if (value === undefined) return '';
  const s = JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

const KIND_LABEL: Record<DiffEntry['kind'], string> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
};

/** Compact list of config changes; locked (science/identity) paths are marked. */
export function DiffList({
  diff,
  max = 50,
}: {
  readonly diff: readonly DiffEntry[];
  readonly max?: number;
}) {
  if (diff.length === 0) return <p className="text-sm text-muted-foreground">No differences.</p>;
  return (
    <ul className="space-y-1.5 text-xs" aria-label="Configuration changes">
      {diff.slice(0, max).map((d) => {
        const locked = lockedReason(d.path);
        return (
          <li key={d.path} className="rounded-md border bg-card px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              {locked && <LockIcon className="size-3 text-destructive" aria-label="Locked field" />}
              <code className="font-mono">{d.path}</code>
              <span className="text-muted-foreground">{KIND_LABEL[d.kind]}</span>
            </div>
            <div className="mt-0.5 font-mono text-muted-foreground">
              {d.kind !== 'added' && (
                <span className="line-through decoration-destructive/60">{show(d.before)}</span>
              )}
              {d.kind === 'changed' && <span aria-hidden="true"> → </span>}
              {d.kind !== 'removed' && <span className="text-foreground">{show(d.after)}</span>}
            </div>
          </li>
        );
      })}
      {diff.length > max && (
        <li className="text-muted-foreground">…and {diff.length - max} more</li>
      )}
    </ul>
  );
}
