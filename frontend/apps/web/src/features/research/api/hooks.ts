'use client';

/**
 * TanStack Query hooks for every research endpoint the console reads or writes. Keys live under
 * `['research', ...]` so a mutation can invalidate exactly what it changed.
 */
import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiClient, unwrap } from '@/lib/api/client';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import type { Permission } from '@/lib/auth/permissions';
import { hasPermission } from '@/lib/auth/principal';
import type {
  ConstructOut,
  DatasetOut,
  DeviationRow,
  EnrollmentOut,
  FeatureDefinition,
  GatesState,
  GroupIndicator,
  ImportOut,
  ImportRowOut,
  InstrumentOut,
  InstrumentVersionDetail,
  MatchedRecord,
  ModelOut,
  PredictionRow,
  RunOut,
  SessionOut,
  StudyDesign,
} from './types';

export const researchKeys = {
  all: ['research'] as const,
  study: (studyId: string) => ['research', 'study', studyId] as const,
  quotas: (studyId: string) => ['research', 'study', studyId, 'quotas'] as const,
  enrollments: (studyId: string) => ['research', 'study', studyId, 'enrollments'] as const,
  deviations: (studyId: string) => ['research', 'study', studyId, 'deviations'] as const,
  sessions: (studyId: string | null) => ['research', 'sessions', studyId ?? '*'] as const,
  participants: (studyId: string | null) => ['research', 'participants', studyId ?? '*'] as const,
  participant: (pid: string) => ['research', 'participant', pid] as const,
  consents: (pid: string) => ['research', 'participant', pid, 'consents'] as const,
  erasure: (requestId: string) => ['research', 'erasure', requestId] as const,
  matched: (studyId: string) => ['research', 'matched', studyId] as const,
  instruments: () => ['research', 'instruments'] as const,
  instrumentVersions: (id: string) => ['research', 'instrument', id, 'versions'] as const,
  instrumentVersion: (id: string, version: string) =>
    ['research', 'instrument', id, 'version', version] as const,
  licensing: (id: string) => ['research', 'instrument', id, 'licensing'] as const,
  importBatch: (importId: string) => ['research', 'import', importId] as const,
  importRows: (importId: string) => ['research', 'import', importId, 'rows'] as const,
  constructs: () => ['research', 'constructs'] as const,
  indicatorDefinitions: () => ['research', 'indicator-definitions'] as const,
  featureDefinitions: () => ['research', 'feature-definitions'] as const,
  indicatorValues: (studyId: string) => ['research', 'indicator-values', studyId] as const,
  groupIndicators: (studyId: string) => ['research', 'group-indicators', studyId] as const,
  datasets: (studyId: string) => ['research', 'datasets', studyId] as const,
  dataset: (snapshotId: string) => ['research', 'dataset', snapshotId] as const,
  runs: (snapshotId: string) => ['research', 'runs', snapshotId] as const,
  run: (runId: string) => ['research', 'run', runId] as const,
  models: (snapshotId: string | null) => ['research', 'models', snapshotId ?? '*'] as const,
  modelDetail: (modelId: string, part: string) => ['research', 'model', modelId, part] as const,
  gates: () => ['research', 'gates'] as const,
  norms: () => ['research', 'norms'] as const,
  contentVersions: () => ['research', 'content-versions'] as const,
  scores: (studyId: string) => ['research', 'scores', studyId] as const,
};

/**
 * Loosely typed view of the API client for endpoints that the generated schema does not list yet
 * (`/features/group-indicators`, `/validation/datasets/{id}/gate-evaluation`). openapi-fetch handles
 * any path at runtime; the response is validated by the caller's type.
 */
interface LooseInit {
  readonly params?: {
    readonly query?: Readonly<Record<string, unknown>>;
    readonly path?: Readonly<Record<string, string>>;
  };
  readonly body?: unknown;
}
interface LooseResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}
interface LooseClient {
  GET(path: string, init?: LooseInit): Promise<LooseResult>;
  POST(path: string, init?: LooseInit): Promise<LooseResult>;
}
export function loose(api: ApiClient): LooseClient {
  return api as unknown as LooseClient;
}

/** True when the principal holds every listed permission (one hook call, safe in any order). */
function useCan(...permissions: Permission[]): boolean {
  const { principal } = useAuth();
  return permissions.every((p) => hasPermission(principal, p));
}

// ------------------------------------------------------------------ studies

export function useStudyDesign(studyId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.study(studyId ?? ''),
    enabled: Boolean(studyId),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/studies/{study_id}', { params: { path: { study_id: studyId ?? '' } } }),
      )) as unknown as StudyDesign,
  });
}

export function useEnrollments(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('participants.read', 'studies.read');
  return useQuery({
    queryKey: researchKeys.enrollments(studyId ?? ''),
    enabled: Boolean(studyId) && allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/studies/{study_id}/enrollments', {
          params: { path: { study_id: studyId ?? '' } },
        }),
      ) as Promise<EnrollmentOut[]>,
  });
}

export function useDeviations(studyId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.deviations(studyId ?? ''),
    enabled: Boolean(studyId),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/studies/{study_id}/deviations', {
          params: { path: { study_id: studyId ?? '' } },
        }),
      )) as unknown as DeviationRow[],
  });
}

/** Every page of sessions for a study (the API caps a page at 1000). */
export async function fetchAllSessions(
  api: ApiClient,
  studyId: string | null,
  maxRows = 20_000,
): Promise<{ items: SessionOut[]; total: number }> {
  const items: SessionOut[] = [];
  let total = 0;
  for (let offset = 0; offset < maxRows; offset += 1000) {
    const page = await unwrap(
      api.GET('/api/v1/sessions', {
        params: { query: { limit: 1000, offset, ...(studyId ? { study_id: studyId } : {}) } },
      }),
    );
    items.push(...page.items);
    total = page.total;
    if (items.length >= page.total || page.items.length === 0) break;
  }
  return { items, total };
}

export function useSessions(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('sessions.read');
  return useQuery({
    queryKey: researchKeys.sessions(studyId),
    enabled: allowed,
    queryFn: () => fetchAllSessions(api, studyId),
  });
}

export function useMatchedRecords(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('participants.read', 'datasets.read');
  return useQuery({
    queryKey: researchKeys.matched(studyId ?? ''),
    enabled: Boolean(studyId) && allowed,
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/validation/matched-records', {
          params: { query: { study_id: studyId ?? '' } },
        }),
      )) as unknown as MatchedRecord[],
  });
}

/** Per-study queries for the studies in scope (overview aggregates across them). */
export function useStudyDesigns(studyIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: studyIds.map((id) => ({
      queryKey: researchKeys.study(id),
      queryFn: async () =>
        (await unwrap(
          api.GET('/api/v1/studies/{study_id}', { params: { path: { study_id: id } } }),
        )) as unknown as StudyDesign,
    })),
  });
}

export function useEnrollmentsFor(studyIds: readonly string[]) {
  const api = useApi();
  const allowed = useCan('participants.read');
  return useQueries({
    queries: studyIds.map((id) => ({
      queryKey: researchKeys.enrollments(id),
      enabled: allowed,
      queryFn: () =>
        unwrap(
          api.GET('/api/v1/studies/{study_id}/enrollments', {
            params: { path: { study_id: id } },
          }),
        ) as Promise<EnrollmentOut[]>,
    })),
  });
}

export function useMatchedRecordsFor(studyIds: readonly string[]) {
  const api = useApi();
  const allowed = useCan('participants.read', 'datasets.read');
  return useQueries({
    queries: studyIds.map((id) => ({
      queryKey: researchKeys.matched(id),
      enabled: allowed,
      queryFn: async () =>
        (await unwrap(
          api.GET('/api/v1/validation/matched-records', {
            params: { query: { study_id: id } },
          }),
        )) as unknown as MatchedRecord[],
    })),
  });
}

// ------------------------------------------------------------------ participants

export function useParticipants(studyId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.participants(studyId),
    queryFn: async () => {
      const items = [];
      let total = 0;
      for (let offset = 0; offset < 20_000; offset += 1000) {
        const page = await unwrap(
          api.GET('/api/v1/participants', {
            params: { query: { limit: 1000, offset, ...(studyId ? { study_id: studyId } : {}) } },
          }),
        );
        items.push(...page.items);
        total = page.total;
        if (items.length >= page.total || page.items.length === 0) break;
      }
      return { items, total };
    },
  });
}

export function useParticipant(pid: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.participant(pid ?? ''),
    enabled: Boolean(pid),
    queryFn: () =>
      unwrap(api.GET('/api/v1/participants/{pid}', { params: { path: { pid: pid ?? '' } } })),
  });
}

export function useConsents(pid: string | null) {
  const api = useApi();
  const allowed = useCan('consent.read');
  return useQuery({
    queryKey: researchKeys.consents(pid ?? ''),
    enabled: Boolean(pid) && allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/participants/{pid}/consents', { params: { path: { pid: pid ?? '' } } }),
      ),
  });
}

// ------------------------------------------------------------------ instruments

export function useInstruments() {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.instruments(),
    queryFn: () => unwrap(api.GET('/api/v1/instruments')) as Promise<InstrumentOut[]>,
  });
}

export function useInstrumentVersion(instrumentId: string | null, version: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.instrumentVersion(instrumentId ?? '', version ?? ''),
    enabled: Boolean(instrumentId && version),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/instruments/{instrument_id}/versions/{version}', {
          params: { path: { instrument_id: instrumentId ?? '', version: version ?? '' } },
        }),
      ) as Promise<InstrumentVersionDetail>,
  });
}

export function useInstrumentVersions(instrumentId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.instrumentVersions(instrumentId ?? ''),
    enabled: Boolean(instrumentId),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/instruments/{instrument_id}/versions', {
          params: { path: { instrument_id: instrumentId ?? '' } },
        }),
      )) as unknown as {
        instrument_id: string;
        version: string;
        key_version: string;
        status: string;
        source_path: string | null;
        created_at: string;
      }[],
  });
}

export function useLicensing(instrumentId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.licensing(instrumentId ?? ''),
    enabled: Boolean(instrumentId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/instruments/{instrument_id}/licensing', {
          params: { path: { instrument_id: instrumentId ?? '' } },
        }),
      ),
  });
}

export function useImportBatch(importId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.importBatch(importId ?? ''),
    enabled: Boolean(importId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/assessment-responses/imports/{import_id}', {
          params: { path: { import_id: importId ?? '' } },
        }),
      ) as Promise<ImportOut>,
  });
}

export function useImportRows(importId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.importRows(importId ?? ''),
    enabled: Boolean(importId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/assessment-responses/imports/{import_id}/rows', {
          params: { path: { import_id: importId ?? '' } },
        }),
      ) as Promise<ImportRowOut[]>,
  });
}

// ------------------------------------------------------------------ traits and features

export function useConstructs() {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.constructs(),
    queryFn: () => unwrap(api.GET('/api/v1/features/constructs')) as Promise<ConstructOut[]>,
    staleTime: 5 * 60_000,
  });
}

export function useIndicatorDefinitions() {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.indicatorDefinitions(),
    queryFn: () => unwrap(api.GET('/api/v1/features/definitions')),
    staleTime: 5 * 60_000,
  });
}

export function useFeatureDefinitions() {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.featureDefinitions(),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/features/feature-definitions'),
      )) as unknown as FeatureDefinition[],
    staleTime: 5 * 60_000,
  });
}

export function useIndicatorValues(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('features.read');
  return useQuery({
    queryKey: researchKeys.indicatorValues(studyId ?? ''),
    enabled: Boolean(studyId) && allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/features', {
          params: { query: { study_id: studyId ?? '', limit: 1000 } },
        }),
      ),
  });
}

export function useGroupIndicators(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('features.read');
  return useQuery({
    queryKey: researchKeys.groupIndicators(studyId ?? ''),
    enabled: Boolean(studyId) && allowed,
    queryFn: async () =>
      (await unwrap(
        loose(api).GET('/api/v1/features/group-indicators', {
          params: { query: { study_id: studyId ?? '' } },
        }),
      )) as GroupIndicator[],
  });
}

export function useContentVersions() {
  const api = useApi();
  const allowed = useCan('admin.content');
  return useQuery({
    queryKey: researchKeys.contentVersions(),
    enabled: allowed,
    queryFn: () => unwrap(api.GET('/api/v1/admin/content-versions')),
  });
}

// ------------------------------------------------------------------ validation

export function useDatasets(studyId: string | null) {
  const api = useApi();
  const allowed = useCan('datasets.read');
  return useQuery({
    queryKey: researchKeys.datasets(studyId ?? ''),
    enabled: Boolean(studyId) && allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/validation/datasets', { params: { query: { study_id: studyId ?? '' } } }),
      ) as Promise<DatasetOut[]>,
  });
}

export function useRuns(snapshotId: string | null) {
  const api = useApi();
  const allowed = useCan('validation.read');
  return useQuery({
    queryKey: researchKeys.runs(snapshotId ?? ''),
    enabled: Boolean(snapshotId) && allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/validation/runs', {
          params: { query: { snapshot_id: snapshotId ?? '' } },
        }),
      ) as Promise<RunOut[]>,
    // Runs are queued jobs; keep polling while any is still working.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.status === 'queued' || r.status === 'running')
        ? 5000
        : false,
  });
}

/** Full run records (with results) for the given run ids. */
export function useRunDetails(runIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: researchKeys.run(runId),
      queryFn: () =>
        unwrap(
          api.GET('/api/v1/validation/runs/{run_id}', { params: { path: { run_id: runId } } }),
        ) as Promise<RunOut>,
      staleTime: 60_000,
    })),
  });
}

export function useGates() {
  const api = useApi();
  const allowed = useCan('gates.read');
  return useQuery({
    queryKey: researchKeys.gates(),
    enabled: allowed,
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/admin/gates', { params: { query: { include_history: true } } }),
      )) as unknown as GatesState,
  });
}

export function useNormTables() {
  const api = useApi();
  const allowed = useCan('norms.read');
  return useQuery({
    queryKey: researchKeys.norms(),
    enabled: allowed,
    queryFn: () => unwrap(api.GET('/api/v1/norms/tables')),
  });
}

// ------------------------------------------------------------------ models

export function useModels(snapshotId: string | null) {
  const api = useApi();
  const allowed = useCan('models.read');
  return useQuery({
    queryKey: researchKeys.models(snapshotId),
    enabled: allowed,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/models', {
          params: { query: snapshotId ? { snapshot_id: snapshotId } : {} },
        }),
      ) as Promise<ModelOut[]>,
  });
}

export function useModelEvaluations(modelIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: modelIds.map((id) => ({
      queryKey: researchKeys.modelDetail(id, 'evaluations'),
      queryFn: () =>
        unwrap(
          api.GET('/api/v1/models/{model_id}/evaluations', {
            params: { path: { model_id: id } },
          }),
        ),
    })),
  });
}

export function useTrainingRuns(modelIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: modelIds.map((id) => ({
      queryKey: researchKeys.modelDetail(id, 'training-runs'),
      queryFn: () =>
        unwrap(
          api.GET('/api/v1/models/{model_id}/training-runs', {
            params: { path: { model_id: id } },
          }),
        ),
      refetchInterval: (query: { state: { data?: readonly { status: string }[] | undefined } }) =>
        (query.state.data ?? []).some((r) => r.status === 'queued' || r.status === 'running')
          ? 5000
          : false,
    })),
  });
}

export function usePredictions(modelId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: researchKeys.modelDetail(modelId ?? '', 'predictions'),
    enabled: Boolean(modelId),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/models/{model_id}/predictions', {
          params: { path: { model_id: modelId ?? '' } },
        }),
      )) as unknown as PredictionRow[],
  });
}

// ------------------------------------------------------------------ helpers

/** Invalidate everything under one research key prefix after a write. */
export function invalidate(client: QueryClient, key: readonly unknown[]): Promise<void> {
  return client.invalidateQueries({ queryKey: key });
}

export { useMutation, useQueryClient };
