# SHRIII Kiosk Behavioural Games

A research-grade behavioural assessment system for public kiosks in India: short, touch-first,
voice-optional games at a golden-hour village market fair, whose behaviour is turned into **candidate
indicators** for 17 constructs and validated against a standard psychometric criterion battery before
anything is ever reported to a player.

> Treat the system as a scientific measurement instrument first and a game second.

Key documents:

- [`docs/BUILD_DECISIONS.md`](docs/BUILD_DECISIONS.md) — binding decisions for this build iteration.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — scientific source of truth (feature IDs such as `ENG-07`, `SCR-01`).
- [`docs/reference/agent-implementation-spec.md`](docs/reference/agent-implementation-spec.md) — product shape (routes, DB domains, dashboards).

## Five data layers (never mixed)

1. **Raw events** — append-only, `packages/contracts/schemas/event-envelope.v1.schema.json`.
2. **Behavioural indicators** — versioned scoring dictionary, `scoring/dictionary/*.yaml`.
3. **Criterion scale scores** — versioned keys, `content/instruments/*.yaml`.
4. **Validated trait estimates** — only after the gates in `scoring/gates.yaml` pass.
5. **Participant interpretations** — banded, strengths-framed, release-gated (`ReportArtefact`, `ReleasePack`).

Scientific thresholds live only in YAML (`scoring/*.yaml`); reports stay disabled until the battery gate
passes in at least two language groups (fail closed).

## Repository layout

```
apps/
  kiosk/                 Vite + React kiosk shell (Electron-ready offline build; electron/ scaffold)
  web/                   Next.js: /kiosk, /research/*, /admin/*          (later iteration agent)
  api/                   FastAPI service + worker (Python, uv workspace member)
packages/
  contracts/             Canonical JSON Schema 2020-12 + generated TS types, constants, Ajv validators, fixtures
  kiosk-game/            React + PixiJS game library; src/core/contracts.ts is the shared engine interface
python/
  shriii_contracts/      Pydantic v2 models generated from the same schemas + jsonschema validation
  shriii_scoring/        Layer 2 indicator engine and layer 3 criterion scoring
  shriii_validation/     Psychometric validation engine
  shriii_simulator/      Synthetic players with known latent traits
scoring/
  dictionary/            shared.yaml (17 constructs), dictionary.A.yaml, dictionary.B.yaml
  hypotheses.yaml        Pre-registration registry
  gates.yaml             Battery and trait gate rules
content/
  instruments/           Criterion instrument registry (structure, keys, licensing; no copyrighted wording)
  i18n/lines.yaml        Voice-line catalogue (pre-recorded clips; en-IN reference text for scripts only)
  games/                 Module/episode configs with per-level timing and budget estimates; session-plan.json
docs/
```

## Prerequisites

- Node 24 (`.nvmrc`) and pnpm 12 (`corepack enable` or a global pnpm 12).
- Python 3.13+ (developed on 3.14) and [uv](https://docs.astral.sh/uv/) (`pip install uv`; if `uv` is not on
  `PATH`, use `python -m uv`).
- Docker Desktop for PostgreSQL 18.

## Getting started

```bash
pnpm install                 # JS workspace (apps/*, packages/*)
uv sync                      # Python workspace -> .venv (all members + dev tools)
cp .env.example .env         # development settings
docker compose up -d postgres            # PostgreSQL 18 (db shriii, user/password dev)
docker compose --profile tools up -d     # + Adminer on http://localhost:8080
```

## Everyday commands

| Task | Command |
|---|---|
| Kiosk dev server | `pnpm --filter @shriii/kiosk dev` (http://localhost:5173) |
| All dev servers | `pnpm dev` |
| Build | `pnpm build` (also fails if generated contract code drifted) |
| Type-check | `pnpm typecheck` or `pnpm -r typecheck` |
| JS tests | `pnpm test` |
| Lint / format (JS, JSON) | `pnpm lint` / `pnpm format` (Biome) |
| Python tests | `uv run pytest` (contracts, scoring dictionary, content, member smoke tests) |
| Python lint / types | `uv run ruff check . && uv run ruff format --check . && uv run mypy` |
| Regenerate TS contracts | `pnpm contracts:generate` |
| Regenerate Pydantic models | `uv run python python/shriii_contracts/src/shriii_contracts/codegen.py` |

Dev-only switches for the kiosk (`.env`, never honoured by production builds):
`VITE_DEV_VOICE_PLACEHOLDER=true` (Web Speech placeholder with a "DEV VOICE" banner) and
`VITE_DEV_OVERLAY=true` (seed/trial/frame-timing overlay).

## Contracts workflow

1. Edit a schema in `packages/contracts/schemas/` (restricted 2020-12 profile: no `if/then/else`,
   `unevaluated*`, `$dynamicRef`; every `oneOf` needs a `discriminator`).
2. Minor versions add optional fields only; a breaking change needs a new major file plus an upcaster.
3. Run both generators (table above), add or adjust fixtures in `packages/contracts/fixtures/`, then run
   `pnpm test` and `uv run pytest`. Both sides validate the same fixtures (strict writers, tolerant readers).

## Scientific content workflow

- The dictionary, hypotheses and gates are **v0 drafts**. Freezes happen through signed governance records
  (PLT-09); after a freeze, thresholds change only by amendment. `uv run pytest scoring` checks schema
  validity, the 17-construct count, matrix rules, cross-references to instruments, hypotheses and voice lines.
- Instrument YAML never contains copyrighted item wording; item text is loaded at administration time
  from the licensed source file referenced by `item_text_source`.
- Game configs carry budget estimates that `uv run pytest content` recomputes against the
  plan section 4.4 session budget (see `content/games/README.md`).
