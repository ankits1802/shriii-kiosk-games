import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  LockIcon,
  type LucideIcon,
  XCircleIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Status tones: reserved colours, always paired with an icon and a label (never colour alone). */
export type StatusTone =
  | 'good'
  | 'warning'
  | 'serious'
  | 'critical'
  | 'neutral'
  | 'info'
  | 'locked';

const TONE: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  good: { icon: CheckCircle2Icon, className: 'text-success border-success/30 bg-success/10' },
  warning: { icon: AlertTriangleIcon, className: 'text-warning border-warning/40 bg-warning/10' },
  serious: {
    icon: AlertOctagonIcon,
    className: 'text-status-serious border-status-serious/40 bg-status-serious/10',
  },
  critical: {
    icon: XCircleIcon,
    className: 'text-destructive border-destructive/30 bg-destructive/10',
  },
  neutral: { icon: CircleDashedIcon, className: 'text-muted-foreground border-border bg-muted/50' },
  info: { icon: CircleDotIcon, className: 'text-info border-info/30 bg-info/10' },
  locked: { icon: LockIcon, className: 'text-foreground border-border bg-muted' },
};

/** Common lifecycle words mapped to tones; unknown words read as neutral. */
const STATUS_WORDS: Record<string, StatusTone> = {
  active: 'good',
  approved: 'good',
  passed: 'good',
  pass: 'good',
  open: 'good',
  ready: 'good',
  succeeded: 'good',
  completed: 'good',
  healthy: 'good',
  online: 'good',
  draft: 'neutral',
  planned: 'neutral',
  queued: 'neutral',
  pending: 'neutral',
  provisional: 'warning',
  running: 'info',
  in_review: 'info',
  recruiting: 'info',
  warning: 'warning',
  degraded: 'warning',
  stale: 'warning',
  closed: 'locked',
  frozen: 'locked',
  locked: 'locked',
  failed: 'critical',
  fail: 'critical',
  error: 'critical',
  revoked: 'critical',
  withdrawn: 'serious',
  withheld: 'serious',
  offline: 'serious',
  cancelled: 'neutral',
};

export function toneFor(status: string): StatusTone {
  return STATUS_WORDS[status.toLowerCase()] ?? 'neutral';
}

export function StatusBadge({
  status,
  tone,
  label,
  className,
}: {
  readonly status: string;
  readonly tone?: StatusTone;
  readonly label?: string;
  readonly className?: string;
}) {
  const t = TONE[tone ?? toneFor(status)];
  const Icon = t.icon;
  return (
    <span
      data-slot="status-badge"
      className={cn(
        'inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium',
        t.className,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label ?? status.replaceAll('_', ' ')}
    </span>
  );
}
