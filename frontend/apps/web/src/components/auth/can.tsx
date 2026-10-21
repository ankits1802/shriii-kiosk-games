'use client';

import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/data/states';
import { useAuth } from '@/lib/auth/auth-context';
import type { Permission, UserRole } from '@/lib/auth/permissions';
import { canAccessStudy, type Requirement, satisfies } from '@/lib/auth/principal';

export interface CanProps extends Requirement {
  readonly children: ReactNode;
  /** Rendered when the requirement is not met (default: nothing). */
  readonly fallback?: ReactNode;
}

/**
 * Render children only when the signed-in principal meets the requirement. UI gating only: the API
 * enforces every permission and study scope independently.
 *
 * ```tsx
 * <Can all={['validation.run']} study={studyId}><RunButton /></Can>
 * ```
 */
export function Can({ children, fallback = null, ...requirement }: CanProps) {
  const { principal } = useAuth();
  return <>{satisfies(principal, requirement) ? children : fallback}</>;
}

/** Hook form of {@link Can}. */
export function usePermission(requirement: Requirement): boolean {
  const { principal } = useAuth();
  return satisfies(principal, requirement);
}

export function useHasPermission(permission: Permission): boolean {
  return usePermission({ all: [permission] });
}

export function useHasRole(role: UserRole): boolean {
  return usePermission({ roles: [role] });
}

export function useStudyAccess(studyId: string | null): boolean {
  const { principal } = useAuth();
  return canAccessStudy(principal, studyId);
}

/** Block a section with an explanation instead of hiding it. */
export function RequirePermission({
  children,
  title = 'You do not have access to this section',
  description,
  ...requirement
}: Requirement & {
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: ReactNode;
}) {
  const { principal } = useAuth();
  if (satisfies(principal, requirement)) return <>{children}</>;
  const needs = [...(requirement.all ?? []), ...(requirement.any ?? [])];
  return (
    <EmptyState
      icon={LockIcon}
      title={title}
      description={
        description ??
        (requirement.study !== undefined && !canAccessStudy(principal, requirement.study ?? null)
          ? 'This study is outside your study scope.'
          : needs.length
            ? `Requires ${requirement.any?.length ? 'one of ' : ''}${needs.join(', ')}.`
            : 'Your role does not include this section.')
      }
    />
  );
}
