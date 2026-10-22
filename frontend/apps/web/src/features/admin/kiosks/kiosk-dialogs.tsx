'use client';

import { CheckIcon, CopyIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorMessage } from '@/lib/api/errors';
import type { Schema } from '@/lib/api/types';
import { type Deployment, KIOSK_ID_PATTERN, type Kiosk } from './heartbeat';

type KioskToken = Schema<'KioskToken'>;
type KioskCreate = Schema<'KioskCreate'>;
type DeploymentIn = Schema<'DeploymentIn'>;

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Register a kiosk. The API answers with a device token that is shown exactly once. */
export function RegisterKioskDialog({
  open,
  onOpenChange,
  existing,
  pending,
  error,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly existing: readonly string[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (body: KioskCreate) => void;
}) {
  const base = useId();
  const [form, setForm] = useState({ kiosk_id: '', site_id: '', label: '', hardware_sku: '' });
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) {
      setForm({ kiosk_id: '', site_id: '', label: '', hardware_sku: '' });
      setTouched(false);
    }
  }, [open]);
  const idError = !KIOSK_ID_PATTERN.test(form.kiosk_id)
    ? 'Lower-case letters, digits and dashes; 2–64 characters, starting with a letter or digit.'
    : existing.includes(form.kiosk_id)
      ? 'A kiosk with this id is already registered.'
      : null;
  const siteError = form.site_id.trim() ? null : 'Site is required.';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a kiosk</DialogTitle>
          <DialogDescription>
            Creates the device record and issues its device token. The token is shown once; store it
            in the kiosk's secure storage during provisioning.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          aria-label="Register kiosk"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (idError || siteError) return;
            onSubmit({
              kiosk_id: form.kiosk_id,
              site_id: form.site_id.trim(),
              label: form.label.trim() || null,
              hardware_sku: form.hardware_sku.trim() || null,
            });
          }}
        >
          <Field
            id={`${base}-id`}
            label="Kiosk id"
            hint="e.g. pune-market-01"
            error={touched ? idError : null}
          >
            <Input
              id={`${base}-id`}
              value={form.kiosk_id}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, kiosk_id: e.target.value.trim() })}
            />
          </Field>
          <Field id={`${base}-site`} label="Site" error={touched ? siteError : null}>
            <Input
              id={`${base}-site`}
              value={form.site_id}
              onChange={(e) => setForm({ ...form, site_id: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${base}-label`} label="Label (optional)">
              <Input
                id={`${base}-label`}
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </Field>
            <Field id={`${base}-sku`} label="Hardware SKU (optional)">
              <Input
                id={`${base}-sku`}
                value={form.hardware_sku}
                onChange={(e) => setForm({ ...form, hardware_sku: e.target.value })}
              />
            </Field>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Registering…' : 'Register and issue token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CopyField({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

/** Shows a freshly issued device token once; closing requires confirming it was stored. */
export function TokenOnceDialog({
  token,
  onClose,
}: {
  readonly token: KioskToken | null;
  readonly onClose: () => void;
}) {
  const [stored, setStored] = useState(false);
  const boxId = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the confirmation for every newly issued token
  useEffect(() => setStored(false), [token]);
  return (
    <Dialog open={token !== null} onOpenChange={(o) => !o && stored && onClose()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => !stored && e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" aria-hidden="true" />
            Device token for {token?.kiosk.kiosk_id}
          </DialogTitle>
          <DialogDescription>
            This is the only time the token is shown. The server keeps only its digest. If it is
            lost, rotate the token.
          </DialogDescription>
        </DialogHeader>
        {token && (
          <div className="space-y-3">
            <CopyField label="Device token" value={token.device_token} />
            <CopyField
              label="Backend X25519 public key (seal per-session keys to this)"
              value={token.backend_x25519_public_key}
            />
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
              <TriangleAlertIcon
                className="mt-0.5 size-3.5 shrink-0 text-warning"
                aria-hidden="true"
              />
              Do not paste the token into chat, email or tickets. Enter it on the kiosk during
              provisioning only.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id={boxId}
                checked={stored}
                onCheckedChange={(v) => setStored(v === true)}
              />
              <Label htmlFor={boxId} className="font-normal">
                I have stored the token on the kiosk
              </Label>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button disabled={!stored} onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm a destructive action by typing the kiosk id. */
export function ConfirmKioskDialog({
  kiosk,
  action,
  description,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  readonly kiosk: Kiosk | null;
  readonly action: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the typed confirmation when the target changes
  useEffect(() => setTyped(''), [kiosk]);
  return (
    <Dialog open={kiosk !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action} {kiosk?.kiosk_id}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field id={id} label={`Type ${kiosk?.kiosk_id ?? ''} to confirm`}>
          <Input
            id={id}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending || typed !== kiosk?.kiosk_id}
            onClick={onConfirm}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DeployOptions {
  readonly studies: readonly {
    readonly study_id: string;
    readonly code: string;
    readonly name: string;
  }[];
  readonly contentVersions: readonly Schema<'ContentVersionOut'>[];
  /** Policy version from the deployment-policy setting, when one exists. */
  readonly policyVersion: string | null;
}

/** Assign a kiosk to a site with a site mode, policy, app and content version (supersedes the active one). */
export function DeployDialog({
  kiosk,
  current,
  options,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  readonly kiosk: Kiosk | null;
  readonly current: Deployment | null;
  readonly options: DeployOptions;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (body: DeploymentIn) => void;
  readonly onClose: () => void;
}) {
  const base = useId();
  const NONE = '__none__';
  const [form, setForm] = useState({
    site_id: '',
    site_mode: 'supervised' as DeploymentIn['site_mode'],
    study_id: NONE,
    policy_version: '',
    app_version: '',
    content_version_id: NONE,
    ring: 'pilot',
  });
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!kiosk) return;
    setTouched(false);
    setForm({
      site_id: current?.site_id ?? kiosk.site_id,
      site_mode: (current?.site_mode as DeploymentIn['site_mode'] | undefined) ?? 'supervised',
      study_id: current?.study_id ?? NONE,
      policy_version: current?.policy_version ?? options.policyVersion ?? '',
      app_version: current?.app_version ?? kiosk.app_version ?? '',
      content_version_id: current?.content_version_id ?? NONE,
      ring: current?.ring ?? 'pilot',
    });
  }, [kiosk, current, options.policyVersion]);
  const approvedContent = options.contentVersions.filter((c) => c.status === 'approved');
  const missing = (['site_id', 'policy_version', 'app_version'] as const).filter(
    (k) => !form[k].trim(),
  );

  return (
    <Dialog open={kiosk !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Deploy {kiosk?.kiosk_id}</DialogTitle>
          <DialogDescription>
            A new deployment supersedes the kiosk's active one. Open public sites run in thank-you
            mode with no criterion capture until the unattended-mode substudy passes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          aria-label="Deploy kiosk"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (missing.length > 0) return;
            onSubmit({
              kiosk_id: kiosk?.kiosk_id ?? '',
              site_id: form.site_id.trim(),
              site_mode: form.site_mode,
              study_id: form.study_id === NONE ? null : form.study_id,
              policy_version: form.policy_version.trim(),
              app_version: form.app_version.trim(),
              content_version_id: form.content_version_id === NONE ? null : form.content_version_id,
              ring: form.ring.trim() || 'pilot',
            });
          }}
        >
          <Field
            id={`${base}-site`}
            label="Site"
            error={touched && !form.site_id.trim() ? 'Required' : null}
          >
            <Input
              id={`${base}-site`}
              value={form.site_id}
              onChange={(e) => setForm({ ...form, site_id: e.target.value })}
            />
          </Field>
          <Field
            id={`${base}-mode`}
            label="Site mode"
            hint={
              form.site_mode === 'open_public'
                ? 'Unattended: thank-you mode, no criterion capture.'
                : 'Staffed by a field administrator.'
            }
          >
            <Select
              value={form.site_mode}
              onValueChange={(v) => setForm({ ...form, site_mode: v as DeploymentIn['site_mode'] })}
            >
              <SelectTrigger id={`${base}-mode`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="supervised">Supervised</SelectItem>
                <SelectItem value="open_public">Open public</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id={`${base}-study`} label="Study">
            <Select value={form.study_id} onValueChange={(v) => setForm({ ...form, study_id: v })}>
              <SelectTrigger id={`${base}-study`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No study (play only)</SelectItem>
                {options.studies.map((s) => (
                  <SelectItem key={s.study_id} value={s.study_id}>
                    {s.code} · {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id={`${base}-content`}
            label="Content version"
            hint="Approved content versions only"
          >
            <Select
              value={form.content_version_id}
              onValueChange={(v) => setForm({ ...form, content_version_id: v })}
            >
              <SelectTrigger id={`${base}-content`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not pinned</SelectItem>
                {approvedContent.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.kind} {c.version} · {c.sha256.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id={`${base}-policy`}
            label="Policy version"
            error={touched && !form.policy_version.trim() ? 'Required' : null}
          >
            <Input
              id={`${base}-policy`}
              value={form.policy_version}
              onChange={(e) => setForm({ ...form, policy_version: e.target.value })}
            />
          </Field>
          <Field
            id={`${base}-app`}
            label="App version"
            error={touched && !form.app_version.trim() ? 'Required' : null}
          >
            <Input
              id={`${base}-app`}
              value={form.app_version}
              onChange={(e) => setForm({ ...form, app_version: e.target.value })}
            />
          </Field>
          <Field
            id={`${base}-ring`}
            label="Update ring"
            hint="lab → single kiosk → 10 % → all (KSK-11)"
          >
            <Input
              id={`${base}-ring`}
              value={form.ring}
              onChange={(e) => setForm({ ...form, ring: e.target.value })}
            />
          </Field>
          {error ? (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {errorMessage(error)}
            </p>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Deploying…' : 'Deploy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
