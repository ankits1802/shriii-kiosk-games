# web: unified Next.js app

`/kiosk` (mounts `@shriii/kiosk-game` client-side), `/research/*` and `/admin/*` (spec §1 routes), with role-based, study-scoped access.

Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript 7 (strict), Tailwind CSS v4, shadcn/ui components on `radix-ui`, TanStack Query and TanStack Table v9, ECharts 6 (tree-shaken thin wrapper), and openapi-fetch with types generated from `apps/api/openapi.json`.

## Run

```bash
pnpm --filter web dev            # http://localhost:3000 (API proxied from API_PROXY_TARGET, default :8000)
pnpm --filter web build          # next build (runs tsc on the whole project)
pnpm --filter web test           # vitest unit + component tests
pnpm --filter web test:e2e       # Playwright smoke tests (API mocked; reuses .next build if present)
pnpm --filter web api:generate   # regenerate src/generated/api-schema.ts from apps/api/openapi.json
pnpm --filter web api:check      # fail if the generated client types are stale
```

Copy `.env.example` to `.env.local` to configure the app. The backend for dev sign-in runs with `ENV=dev AUTH_MODE=dev` (see `apps/api/README.md`).

## Layout

| Path | What |
|---|---|
| `src/app/(app)/(console)/` | Console routes inside `AppShell` + `ConsoleGuard` + `StudyScopeProvider` |
| `src/app/(app)/login`, `auth/callback`, `no-access` | Sign-in (dev JWT or OIDC PKCE), OIDC redirect, no-role page |
| `src/app/kiosk/` | Full-screen kiosk (`dynamic(..., { ssr: false })`, no console providers) |
| `src/lib/nav.ts` | Route registry: one table drives the sidebar, breadcrumbs, guard and tests |
| `src/lib/auth/` | Permissions (mirrors `rbac.py`, parity-tested), principal checks, token store, OIDC, `AuthProvider` |
| `src/lib/api/` | `createApiClient`, `unwrap`, `ApiError`, schema aliases (`Schema<'StudyOut'>`) |
| `src/lib/export/` | CSV (RFC 4180, BOM, formula-injection safe) and Parquet (hyparquet-writer) with a justification gate and audit sink |
| `src/lib/stats/` | Display helpers for charts: t/normal quantiles, OLS + CI band, KDE, histogram, Bland–Altman |
| `src/components/ui/` | shadcn/ui primitives |
| `src/components/data/` | `DataTable`, `ExportMenu`, `AuditStamp`/`TimeStamp`/`CopyId`, `StatusBadge`, `PageHeader`/`Section`, `EmptyState`/`ErrorState`/`LoadingState`/`QueryState` |
| `src/components/charts/` | `HeatmapChart`, `ScatterRegressionChart`, `ForestPlot`, `BarCiChart`, `DistributionChart`, `LoadingPlot`, `BlandAltmanPlot` (pure option builders in `options/`) |
| `src/components/auth/` | `Can`, `RequirePermission`, `usePermission`, `useStudyAccess`, `ConsoleGuard` |

`/design-system` shows every building block with synthetic data. It is on in dev builds, and in production only when `NEXT_PUBLIC_ENABLE_UI_GALLERY=true`.

## Conventions for feature pages

- **Data:** use `useApi()` with TanStack Query: `useQuery({ queryKey, queryFn: () => unwrap(api.GET('/api/v1/...', { params })) })`. Render loading, error and empty states with `QueryState` or `DataTable`.
- **Access:** guard actions with `<Can all={[...]} study={studyId}>`. The route guard comes from `nav.ts`, and the API enforces the same rules on its side. Field administrators never see score-bearing pages (PRV-08).
- **Study focus:** read the study from `useStudyScope()`. It holds the study selected in the top bar, and only studies inside the principal's scope can be selected.
- **Audit:** every record shows who and when through `<AuditStamp record={row} />`. It understands `created_by`, `recorded_by`, `linked_by`, `approved_by`, `updated_*` and similar fields.
- **Statistics:** every figure shows N, its uncertainty, exclusions and provenance, passed in through `provenance`. Thresholds such as reliability targets or salience cut-offs come from the server or YAML config as `referenceLines` or `salience`. They are never constants in the UI. The kiosk never shows numbers.
- **Colour:** categorical slots are used in a fixed order. Scatter-type charts use at most 3 identity colours, and any further groups fold into "Other". Status colours always appear with an icon and a label.

## Kiosk at `/kiosk`

- `kiosk-game` reads Vite's `import.meta.env`. `next.config.ts` defines `DEV`, `PROD`, `MODE` and `VITE_DEV_VOICE_PLACEHOLDER`, and `src/types/import-meta-env.d.ts` types them.
- The dev voice placeholder is forced off in production builds.
- `NEXT_PUBLIC_KIOSK_*` mirrors the `VITE_*` settings of `apps/kiosk`.
- If `NEXT_PUBLIC_KIOSK_API_BASE` is empty, the kiosk runs offline and the outbox persists in IndexedDB.
- `/kiosk/session`, `/kiosk/play` and `/kiosk/results` mount the same runtime. The session statechart decides which screen to show.

## Export audit

`ExportMenu` asks for a justification above `NEXT_PUBLIC_EXPORT_JUSTIFICATION_ROWS` rows (default 50, PRV-08). It then reports an `ExportRecord` to the `ExportAuditSink` set by `<ExportAuditProvider>`. The default sink only writes a structured console line, because the API has no endpoint for client export records yet.
