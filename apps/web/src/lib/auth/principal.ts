/**
 * The signed-in principal and the pure access checks the UI uses (role-, permission- and
 * study-scoped). Mirrors `Principal.has` / `Principal.can_access_study` in the API; the API still
 * enforces every check, the UI only hides what would be refused.
 */
import type { MeResponse } from '@/lib/api/types';
import {
  ALL_STUDIES,
  isPermission,
  isUserRole,
  type Permission,
  type UserRole,
} from './permissions';

export interface Principal {
  readonly sub: string;
  readonly kind: string;
  readonly roles: readonly UserRole[];
  /** Study scope; contains `*` for unscoped principals. */
  readonly studies: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

export function principalFromMe(me: MeResponse): Principal {
  return {
    sub: me.sub,
    kind: me.kind,
    roles: me.roles.filter(isUserRole),
    studies: [...me.studies],
    permissions: new Set(me.permissions.filter(isPermission)),
  };
}

export function hasRole(principal: Principal | null, role: UserRole): boolean {
  return principal?.roles.includes(role) ?? false;
}

export function isAdmin(principal: Principal | null): boolean {
  return hasRole(principal, 'admin');
}

export function hasPermission(principal: Principal | null, permission: Permission): boolean {
  return principal?.permissions.has(permission) ?? false;
}

/** True when the principal may touch `studyId` (admins and `*` scopes see every study). */
export function canAccessStudy(principal: Principal | null, studyId: string | null): boolean {
  if (!principal) return false;
  if (studyId === null || isAdmin(principal) || principal.studies.includes(ALL_STUDIES)) {
    return true;
  }
  return principal.studies.includes(studyId);
}

export function isStudyScoped(principal: Principal | null): boolean {
  return principal !== null && !isAdmin(principal) && !principal.studies.includes(ALL_STUDIES);
}

/**
 * An access requirement: every permission in `all`, at least one in `any`, a role in `roles`,
 * and access to `study` when given. Empty requirement = any signed-in principal.
 */
export interface Requirement {
  readonly all?: readonly Permission[];
  readonly any?: readonly Permission[];
  readonly roles?: readonly UserRole[];
  readonly study?: string | null;
}

export function satisfies(principal: Principal | null, requirement: Requirement): boolean {
  if (!principal) return false;
  if (requirement.all && !requirement.all.every((p) => principal.permissions.has(p))) return false;
  if (
    requirement.any &&
    requirement.any.length > 0 &&
    !requirement.any.some((p) => principal.permissions.has(p))
  ) {
    return false;
  }
  if (
    requirement.roles &&
    requirement.roles.length > 0 &&
    !requirement.roles.some((r) => principal.roles.includes(r))
  ) {
    return false;
  }
  if (requirement.study !== undefined && !canAccessStudy(principal, requirement.study)) {
    return false;
  }
  return true;
}

/** Filter study ids down to those the principal may see. */
export function visibleStudies<T extends { readonly study_id: string }>(
  principal: Principal | null,
  studies: readonly T[],
): T[] {
  return studies.filter((s) => canAccessStudy(principal, s.study_id));
}
