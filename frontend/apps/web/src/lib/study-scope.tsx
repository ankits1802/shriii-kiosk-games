'use client';

import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useAuth } from '@/lib/auth/auth-context';
import { canAccessStudy, hasPermission } from '@/lib/auth/principal';
import { queryKeys } from '@/lib/query';

export type StudySummary = Schema<'StudyOut'>;

export interface StudyScopeValue {
  /** Studies the principal may see (API list filtered by study scope). */
  readonly studies: readonly StudySummary[];
  readonly isLoading: boolean;
  readonly error: unknown;
  /** The study pages should focus on, or null for "all studies in scope". */
  readonly studyId: string | null;
  readonly study: StudySummary | null;
  setStudyId(studyId: string | null): void;
}

const StudyScopeContext = createContext<StudyScopeValue | null>(null);

const storageKey = (sub: string) => `shriii.study-scope.${sub}`;

function readStored(sub: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(sub));
  } catch {
    return null;
  }
}

function writeStored(sub: string, studyId: string | null): void {
  try {
    if (studyId) window.localStorage.setItem(storageKey(sub), studyId);
    else window.localStorage.removeItem(storageKey(sub));
  } catch {
    // Remembering the selection is a convenience only.
  }
}

/** Current study selection for the console; persisted per user in this browser. */
export function StudyScopeProvider({ children }: { readonly children: ReactNode }) {
  const { principal, api } = useAuth();
  const canRead = hasPermission(principal, 'studies.read');
  const query = useQuery({
    queryKey: queryKeys.studies(),
    queryFn: () => unwrap(api.GET('/api/v1/studies')),
    enabled: canRead,
  });
  const studies = useMemo(
    () => (query.data ?? []).filter((s) => canAccessStudy(principal, s.study_id)),
    [query.data, principal],
  );
  const [studyId, setStudyIdState] = useState<string | null>(null);

  useEffect(() => {
    if (principal) setStudyIdState(readStored(principal.sub));
  }, [principal]);

  // Drop a remembered study that is no longer visible (scope changed, study removed).
  useEffect(() => {
    if (studyId && query.isSuccess && !studies.some((s) => s.study_id === studyId)) {
      setStudyIdState(null);
    }
  }, [studyId, studies, query.isSuccess]);

  const setStudyId = useCallback(
    (id: string | null) => {
      setStudyIdState(id);
      if (principal) writeStored(principal.sub, id);
    },
    [principal],
  );

  const value = useMemo<StudyScopeValue>(
    () => ({
      studies,
      isLoading: canRead && query.isPending,
      error: query.error,
      studyId,
      study: studies.find((s) => s.study_id === studyId) ?? null,
      setStudyId,
    }),
    [studies, canRead, query.isPending, query.error, studyId, setStudyId],
  );
  return <StudyScopeContext.Provider value={value}>{children}</StudyScopeContext.Provider>;
}

export function useStudyScope(): StudyScopeValue {
  const ctx = useContext(StudyScopeContext);
  if (!ctx) throw new Error('useStudyScope must be used inside <StudyScopeProvider>');
  return ctx;
}
