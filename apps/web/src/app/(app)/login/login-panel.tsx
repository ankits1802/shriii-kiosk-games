'use client';

import { AlertTriangleIcon, KeyRoundIcon, Loader2Icon, LogInIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api/errors';
import type { DevLoginRole } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { safeReturnTo } from '@/lib/auth/oidc';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, USER_ROLES } from '@/lib/auth/permissions';
import { canOpen, defaultLanding } from '@/lib/nav';

const REASON_TEXT = {
  expired: 'Your session expired. Sign in again to continue.',
  unauthorized: 'The API rejected your session. Sign in again.',
  user: null,
} as const;

export function LoginPanel() {
  const { status, principal, config, configError, signOutReason, signInDev, signInOidc } =
    useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const [sub, setSub] = useState('dev-researcher');
  const [roles, setRoles] = useState<DevLoginRole[]>(['researcher']);
  const [studies, setStudies] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subId = useId();
  const studiesId = useId();

  // Once signed in, continue to `next` if permitted, else to the first permitted page.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const target = safeReturnTo(next, '');
    router.replace(target && canOpen(principal, target) ? target : defaultLanding(principal));
  }, [status, principal, next, router]);

  const toggleRole = (role: DevLoginRole, on: boolean) =>
    setRoles((current) =>
      on ? [...new Set([...current, role])] : current.filter((r) => r !== role),
    );

  const onDevSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!sub.trim()) return setError('Enter a subject (user id).');
    if (roles.length === 0) return setError('Choose at least one role.');
    setBusy(true);
    try {
      const scope = studies
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await signInDev({ sub: sub.trim(), roles, studies: scope.length ? scope : null });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reason = signOutReason ? REASON_TEXT[signOutReason] : null;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-2 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
          >
            S
          </span>
          <span className="text-sm font-semibold">SHRIII Behavioural Games</span>
        </div>
        <CardTitle className="text-lg">Sign in to the research console</CardTitle>
        <CardDescription>
          Access is role-based and study-scoped. Every data access is audited.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {reason && (
          <Alert variant="info">
            <AlertTriangleIcon />
            <AlertDescription>{reason}</AlertDescription>
          </Alert>
        )}
        {configError && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Sign-in is misconfigured</AlertTitle>
            <AlertDescription>{configError}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" data-testid="login-error">
            <AlertTriangleIcon />
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {config?.mode === 'oidc' && (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              signInOidc(safeReturnTo(next)).catch((err: unknown) => {
                setError(errorMessage(err));
                setBusy(false);
              });
            }}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            Sign in with your organisation
          </Button>
        )}

        {config?.mode === 'dev' && (
          <form onSubmit={onDevSubmit} className="space-y-4" aria-label="Development sign-in">
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Development sign-in</AlertTitle>
              <AlertDescription>
                Issues a local signed JWT from the API (ENV=dev only). Production uses OIDC.
              </AlertDescription>
            </Alert>
            <div className="grid gap-2">
              <Label htmlFor={subId}>Subject</Label>
              <Input
                id={subId}
                name="sub"
                autoComplete="username"
                value={sub}
                onChange={(e) => setSub(e.target.value)}
                required
              />
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Roles</legend>
              {USER_ROLES.map((role) => {
                const id = `${subId}-role-${role}`;
                return (
                  <div key={role} className="flex items-start gap-2.5 rounded-md border p-2.5">
                    <Checkbox
                      id={id}
                      checked={roles.includes(role)}
                      onCheckedChange={(v) => toggleRole(role, v === true)}
                      className="mt-0.5"
                    />
                    <Label htmlFor={id} className="flex-col items-start gap-0.5 font-normal">
                      <span className="font-medium">{ROLE_LABELS[role]}</span>
                      <span className="text-xs text-muted-foreground">
                        {ROLE_DESCRIPTIONS[role]}
                      </span>
                    </Label>
                  </div>
                );
              })}
            </fieldset>
            <div className="grid gap-2">
              <Label htmlFor={studiesId}>Study scope (optional)</Label>
              <Input
                id={studiesId}
                name="studies"
                placeholder="All studies, or comma-separated study ids"
                value={studies}
                onChange={(e) => setStudies(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
              Sign in
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
