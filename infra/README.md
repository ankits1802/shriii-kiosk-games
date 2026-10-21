# infra

| Path | What |
|---|---|
| `docker/api.Dockerfile` | Backend image: target `api` (FastAPI via uvicorn, default) and target `worker` (job worker). uv, python-slim, non-root uid 10001, healthcheck. |
| `docker/web.Dockerfile` | `frontend/apps/web` as a Next.js standalone server (needs `output: "standalone"` and `outputFileTracingRoot` in `next.config`; the pnpm package name is read from `frontend/apps/web/package.json`; `API_PROXY_TARGET` is a build arg because Next.js bakes rewrite destinations into the build). Non-root. |
| `docker/kiosk.Dockerfile` | `frontend/apps/kiosk` static browser build served by unprivileged nginx (strict CSP, no remote origins); `--target dist` exports the bundle. |
| `docker/healthcheck.py` | `shriii-healthcheck http <url>` / `db` probes for slim images. |
| `docker/r-psychometrics.Dockerfile` | R backend image (owned by the psychometrics stream). |
| `compose/compose.full.yml` | Full local / 2-VM pilot stack: postgres 18, migrate (one-shot), api, worker, web, kiosk, adminer. |
| `tofu/` | OpenTofu for AWS ap-south-1 (see `tofu/README.md`). |

Every Dockerfile builds from the repository root and has a `<name>.Dockerfile.dockerignore` next to it.

## Local full stack

```bash
docker compose -f infra/compose/compose.full.yml up --build -d
curl http://localhost:8000/healthz    # {"status":"ok",...}
curl http://localhost:8000/readyz     # database, identity database and migration checks
open http://localhost:3000            # web (/kiosk, /research, /admin)
open http://localhost:5173            # kiosk browser build
open http://localhost:8080            # Adminer (server "postgres", user "shriii", password "shriii-dev")
docker compose -f infra/compose/compose.full.yml down -v
```

- `migrate` runs `shriii-api migrate && shriii-api seed --demo` once (idempotent); `api` and `worker` start after it
  succeeds. The identity vault has its own database (`shriii_identity`, created by `compose/postgres-init`).
- Env files in `compose/env/` are development defaults (`ENV=dev`: dev login and keys derived from the dev secret).
  Put overrides in `compose/env/local.env` (git-ignored). Never reuse them outside a laptop or pilot VM.
- Host ports: `POSTGRES_HOST_PORT` (55433), `API_HOST_PORT` (8000), `WEB_HOST_PORT` (3000), `KIOSK_HOST_PORT`
  (5173), `ADMINER_HOST_PORT` (8080). Browser builds call the API at `PUBLIC_API_BASE_URL`
  (default `http://localhost:8000`, baked in at build time).
- PostgreSQL and Adminer listen on 127.0.0.1 only (well-known dev credentials); set `BIND_ADDRESS=0.0.0.0` to expose them.
- To bring up the stack without the web app: `docker compose -f infra/compose/compose.full.yml up --build -d
  postgres migrate api worker kiosk adminer`.

## CI/CD (`.github/`)

| Workflow | Purpose |
|---|---|
| `ci.yml` | plan-lint + trial budget, Biome / typecheck / Vitest / build, ruff / mypy / pytest with a postgres:18 service, small recovery run, Playwright smoke, compose stack health, OpenTofu validate + region policy |
| `schema-compat.yml` | contract backward/forward compatibility against the merge base (`cicd/scripts/schema_compat.py`) |
| `nightly-sim.yml` | full simulated-player recovery report + slow statistical tests |
| `kiosk-release.yml` | deploy-order gate, reproducible kiosk build (web bundle + Electron shell), CycloneDX SBOM, cosign signatures, GitHub release with the version tuple |
| `deploy.yml` | build api / worker / web / kiosk images, push to ECR, cosign-sign, run the `migrate` ECS task (`cicd/scripts/ecs_migrate.sh`, must exit 0), then OpenTofu plan and apply |
| `codeql.yml`, `osv-scanner.yml` | static analysis and dependency vulnerability scanning |

Repository settings the workflows expect: variables `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REGISTRY`, `TOFU_STATE_BUCKET`,
optional `COSIGN_KEYLESS`, `PRODUCTION_CONTRACTS_REF`; secrets `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`
(placeholders until the signing ceremony; releases fail closed without signing material); GitHub environments
`staging` and `production` (production requires reviewers). Renovate (`.github/renovate.json`) applies updates after
soak periods: 7 days by default, 21 days for the scientific Python stack and the kiosk runtime, 30 days for majors,
none for security fixes.
