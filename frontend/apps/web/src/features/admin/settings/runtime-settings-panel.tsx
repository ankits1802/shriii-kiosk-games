'use client';

import { useQuery } from '@tanstack/react-query';
import { PencilIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Can } from '@/components/auth/can';
import { AuditStamp } from '@/components/data/audit-stamp';
import { Section } from '@/components/data/page-header';
import { EmptyState, QueryState } from '@/components/data/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { isPlainObject, parseJson } from '../shared/canonical-json';
import { useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';
import { POLICY_SETTING_KEY } from './policy';

type Setting = Schema<'SettingOut'>;

/** Keys managed by a dedicated editor (edited there, shown read-only here). */
const MANAGED: Readonly<Record<string, string>> = { [POLICY_SETTING_KEY]: 'Deployment policy tab' };

const KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;

function SettingDialog({
  setting,
  open,
  existing,
  onClose,
}: {
  readonly setting: Setting | null;
  readonly open: boolean;
  readonly existing: readonly string[];
  readonly onClose: () => void;
}) {
  const api = useApi();
  const id = useId();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('{}');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (!open) return;
    setKey(setting?.key ?? '');
    setValue(JSON.stringify(setting?.value ?? {}, null, 2));
    setDescription(setting?.description ?? '');
  }, [open, setting]);
  const parsed = parseJson(value);
  const keyError = setting
    ? null
    : !KEY_PATTERN.test(key)
      ? 'Lower-case letters, digits, dot, dash or underscore.'
      : existing.includes(key)
        ? 'This key exists; edit it instead.'
        : MANAGED[key]
          ? `Managed in the ${MANAGED[key]}.`
          : null;
  const valueError = !parsed.ok
    ? parsed.message
    : !isPlainObject(parsed.value)
      ? 'The value must be a JSON object.'
      : null;
  const save = useAdminMutation({
    mutationFn: (body: {
      key: string;
      value: Record<string, unknown>;
      description: string | null;
    }) =>
      unwrap(
        api.PUT('/api/v1/admin/settings/{key}', {
          params: { path: { key: body.key } },
          body: { value: body.value, description: body.description },
        }),
      ),
    invalidate: [adminKeys.settings(), adminKeys.auditAll()],
    success: (s: Setting) => `Saved ${s.key}`,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{setting ? `Edit ${setting.key}` : 'New runtime setting'}</DialogTitle>
          <DialogDescription>
            Saved with your name; the audit log keeps the previous and new value.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          aria-label="Runtime setting"
          onSubmit={(e) => {
            e.preventDefault();
            if (keyError || valueError || !parsed.ok) return;
            save.mutate(
              {
                key: setting?.key ?? key,
                value: parsed.value as Record<string, unknown>,
                description: description.trim() || null,
              },
              { onSuccess: onClose },
            );
          }}
        >
          {!setting && (
            <div className="space-y-1">
              <Label htmlFor={`${id}-key`}>Key</Label>
              <Input
                id={`${id}-key`}
                className="font-mono"
                value={key}
                onChange={(e) => setKey(e.target.value.trim())}
              />
              {keyError && key && <p className="text-xs text-destructive">{keyError}</p>}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`${id}-value`}>Value (JSON object)</Label>
            <Textarea
              id={`${id}-value`}
              className="h-48 font-mono text-xs"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            {valueError && <p className="text-xs text-destructive">{valueError}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-desc`}>Description</Label>
            <Input
              id={`${id}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {save.error ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(save.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || Boolean(keyError) || Boolean(valueError)}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Runtime settings (audited key/value store). */
export function RuntimeSettingsPanel() {
  const api = useApi();
  const settings = useQuery({
    queryKey: adminKeys.settings(),
    queryFn: () => unwrap(api.GET('/api/v1/admin/settings')),
  });
  const [editing, setEditing] = useState<Setting | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <Section
      title="Runtime settings"
      description="Operational configuration read by the API and worker. Scientific thresholds are not settings: they live in stats/measurement-model YAML."
      actions={
        <Can all={['admin.settings']}>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            New setting
          </Button>
        </Can>
      }
    >
      <QueryState
        query={settings}
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState title="No runtime settings stored" />}
      >
        {(rows) => (
          <ul className="divide-y rounded-lg border bg-card">
            {rows.map((s) => (
              <li key={s.key} className="grid gap-2 px-4 py-3 md:grid-cols-[16rem_1fr_auto]">
                <div className="min-w-0 space-y-1">
                  <code className="font-mono text-sm">{s.key}</code>
                  {MANAGED[s.key] && <Badge variant="secondary">{MANAGED[s.key]}</Badge>}
                  {s.description && (
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <pre className="max-h-32 overflow-auto rounded-md bg-muted/50 px-2 py-1 font-mono text-xs">
                    {JSON.stringify(s.value, null, 2)}
                  </pre>
                  <AuditStamp actor={s.updated_by} at={s.updated_at} verb="Updated" />
                </div>
                <div>
                  {!MANAGED[s.key] && (
                    <Can all={['admin.settings']}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(s)}
                        aria-label={`Edit ${s.key}`}
                      >
                        <PencilIcon aria-hidden="true" />
                        Edit
                      </Button>
                    </Can>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <SettingDialog
        open={editing !== null || creating}
        setting={editing}
        existing={(settings.data ?? []).map((s) => s.key)}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
      />
    </Section>
  );
}
