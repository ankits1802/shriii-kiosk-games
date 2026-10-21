# Kiosk Behavioural Games (SHRIII): Implementation Plan

> **Status:** Revision 2. It replaces the first draft and addresses every issue raised by the design review. Approve it before any code is written.
> **Reference:** *Kiosk Behavioural Games Concept Note* (SHRIII, Oct 2026). Planned on 2026-10-21.
> **Calendar assumption:** project month P1 = June 2026. The Months 1–3 progress report is dated 31 Aug 2026, which puts today in P5 and the project end at **P24 (May 2028)**. The stakeholders should confirm this mapping (§11, Q12).

---

## How to use this plan (for the implementing agent)

1. **Work by milestone, then by feature ID.** Every feature header reads `ID · title — priority · milestone · deps`. Build a feature only once all its `deps` are merged. `cicd/plan-lint` (PLT-08) parses these headers and fails CI on a dependency cycle, a dependency on a later milestone, or a dependency on a lower priority.
2. **Priorities.** **P0** is needed for Stage 1 (think-aloud) and the MVP Pathway B. **P1** is needed for the Stage 2–3 pilot. **P2** is needed for Stage 4–5 and field use. **PG** means post-grant or optional. It is specified so the design leaves room for it, but it is not built inside P24.
3. **Acceptance criteria (AC) are the definition of done.** Every AC needs an automated test unless it says *manual*, *drill* or *study*. Statistical ACs use tolerances or equivalence tests, never "p > .05".
4. **Do not change scientific rules in code.** Thresholds, hypotheses, gate rules, indicator definitions and minimum trial counts live in `stats/measurement-model/dictionary/*.yaml` and `stats/measurement-model/hypotheses.yaml`. Once frozen (§7.1), they change only through a signed amendment (PLT-09). If a test fails against a frozen threshold, report it. Do not "fix" the threshold.
5. **Fail closed.** If a gate, consent, signature or policy check is missing, expired or unreachable, the safe result applies: no report, no upload of unconsented data, no camera, no mic.
6. **Versions** are given as major lines. Verify and pin the exact versions in M0 (PLT-08) against official release pages and what AWS RDS actually offers.
7. **Defaults for open questions** are in §1.4. They are configurable settings. Do not hard-code them.
8. Use the **source IDs** (`src:`) to trace a feature back to the domain research inputs. You do not need them to implement the feature.

---

## Table of contents

1. [Goal, scope and defaults](#1-goal-scope-and-defaults)
2. [Architecture and tech stack](#2-architecture-and-tech-stack)
3. [Monorepo layout](#3-monorepo-layout)
4. [Evidence-centred design: traceability matrix and session budgets](#4-evidence-centred-design-traceability-matrix-and-session-budgets)
5. [Feature list](#5-feature-list)
   - [5.1 PLT Platform](#51-plt-platform-foundations) · [5.2 KSK Kiosk](#52-ksk-kiosk-shell-hardware-and-fleet) · [5.3 VOX Audio and speech](#53-vox-audio-speech-and-localisation) · [5.4 ONB Onboarding](#54-onb-onboarding-and-consent-ux) · [5.5 ENG Engine](#55-eng-game-engine) · [5.6 MG Micro-games](#56-mg-pathway-b-micro-games-and-carousel) · [5.7 EPI Episodes](#57-epi-pathway-a-episodes-arms-co-play-and-pathway-c) · [5.8 ING Ingestion](#58-ing-logging-contract-ingestion-and-data-management) · [5.9 SCR Scoring](#59-scr-scoring-dictionary-and-indicator-engine) · [5.10 CRT Criterion](#510-crt-criterion-battery-linkage-and-study-management) · [5.11 VAL Validation](#511-val-validation-analytics-and-gates) · [5.12 REP Reports](#512-rep-player-report) · [5.13 PRV Privacy](#513-prv-privacy-security-and-governance) · [5.14 QA Testing](#514-qa-testing-and-quality)
6. [Data model and logging contract](#6-data-model-and-logging-contract)
7. [Psychometric validation pipeline and gates](#7-psychometric-validation-pipeline-and-gates)
8. [Roadmap (project months P4–P24)](#8-roadmap-project-months-p4p24)
9. [Testing and quality strategy](#9-testing-and-quality-strategy)
10. [Risks and mitigations](#10-risks-and-mitigations)
11. [Open questions and assumed defaults](#11-open-questions-and-assumed-defaults)
12. [Appendix A: feature counts](#appendix-a-feature-counts)
13. [Appendix B: review issues and where each is resolved](#appendix-b-review-issues-and-where-each-is-resolved)

---

## 1. Goal, scope and defaults

### 1.1 Goal

Build a **15-minute-maximum battery** of linked behavioural games for **public kiosks in India**, aiming for **9–10.5 minutes of scorable play**. Behaviour in the games becomes indicators for **17 constructs**: the 15 traits in the note, plus risk preference and executive persistence. The **backend validates those indicators against a standard psychometric criterion battery**, checking reliability, convergent and discriminant validity, test–retest stability, measurement invariance, DIF, mode effects and norms.

**Report release rule** (note p.11): no report reaches a player until the **battery** has passed reliability and fairness checks in **at least two language groups** and that pass is signed off (`battery_release_gate`, §7.7). Only after that can individual trait × language × pathway gates release bands. A language that has not passed the battery gate always gets the thank-you screen only.

**Set expectations now.** The literature puts behavioural task vs self-report correlations at roughly .05–.20, and task retest reliability at about .3–.6. Expect **only a subset of the 17 constructs** to become reportable, and possibly none in the first wave. The plan says so explicitly and gives a pre-registered `research_only` path (§7.8). Stakeholders are told in M0.

Build order (as in the note):
1. **Pathway B** is the micro-game carousel and the validated core.
2. **Pathway A** is the village market fair: 3 linked episodes that reuse B's paradigm code. Pathway A meets the note's preference for "2–3 linked games".
3. **Pathway D** (co-play): the scripted partner first. A **supervised live-dyad substudy** runs in Stage 2 because teamwork needs a partner rating.
4. **Pathway C** (voiced SJT) is a post-grant alternative.
5. The pilot compares **B against A directly** with **2 randomised arms**, both completing the full criterion battery.

### 1.2 In scope

- Kiosk runtime: onboarding, games, episodes, report delivery and walkaway handling.
- Interaction that needs no reading. **Touch first**. Closed-vocabulary speech is an opt-in per prompt after an ASR bake-off. All audio is pre-recorded and multilingual (3 pilot languages, extensible to the 22 scheduled languages).
- Logging contract and scoring dictionary, frozen before data collection (evidence-centred design / stealth assessment).
- Backend: ingestion, scoring, criterion-battery capture and linkage, study and quota management, the psychometric validation pipeline (Stages 1–5), norming and report gating.
- Strengths-framed banded reports (spoken, printed picture page and QR), released only through gates.
- DPDP Act 2023 compliance: purpose-scoped consent, separate opt-ins, erasure and retention set **before** the first data collection, no audio kept, adults only.
- Fleet operations, security, observability, CI/CD and testing, including simulation-based parameter recovery.

**Scope note.** The concept note puts backend storage out of scope and only "what the backend receives" in scope. The user's request (backend data must validate the game traits against a standard psychometric battery) **extends** that scope to a storage and analytics backend. The **logging contract (ING-01) remains the boundary the note defines**: the kiosk side never depends on backend internals.

### 1.3 Out of scope (enforced in code and config)

- Clinical diagnosis, and using game scores alone for hiring or any other high-stakes decision.
- **Camera, facial expression and acoustic voice tone** as trait signals. These are **compiled out** of game builds. There is no code path, and no `camera` consent kind exists in the v1 schemas (the name is reserved). They could come back only with a stakeholder decision, a DPIA and a signed validation-evidence record (PRV-01).
- Runtime TTS. All voice is pre-recorded by native speakers.
- Keyboard and free-text input of any kind.
- Criterion scales at public kiosks. Criterion capture happens only at supervised sites, on administrator devices.
- **Minors.** The minimum age is 18 everywhere (§1.4, PRV-12).
- An always-listening microphone. The mic stays closed before consent (PRV-03).

### 1.4 Defaults for the note's open questions

Every default is a **signed, versioned setting** in `DeploymentPolicy` (PRV-01), except where it says *locked*.

| Open question | Default | Config key | Why |
|---|---|---|---|
| Minimum age | **18+ everywhere**. Selecting an under-18 band ends the session politely and nothing is kept. | `minimum_age=18`, `allow_minors=false` (*locked*; changing it needs the PRV-12 preconditions) | DPDP §9 requires verifiable parental consent and bars behavioural monitoring of children. Integrity content needs a higher age floor. BFI-2 and DERS-16 are adult instruments. |
| 3 pilot languages | Placeholder `hi-IN`, `mr-IN`, `ta-IN` (two families, two scripts) | `enabled_languages[]` | Adding a language needs content only. Stakeholders decide the final three. |
| Supervised vs open kiosks | **Stages 1–3 at supervised sites.** Open public kiosks run in **thank-you mode** for the unattended-mode substudy (VAL-18). Reports at open kiosks need the VAL-18 pass. | `site_mode ∈ {supervised, open_public}` | The note says unattended kiosk administration is essentially unstudied. |
| What decisions the report informs | "Personal reflection only" | `report_use_statement_key` | Spoken in consent. Any institutional use needs re-consent and IRB review. |
| Camera / voice tone | **Compiled out** | *n/a* (no flag in builds) | Out of scope. Stall tone is a tapped choice. |
| Private-dice design | **Mode (a)**: the true roll is never logged. Integrity is estimated **at group level only**. | `integrity_dice_mode=a` | Keeps the privacy claim true. Dice never enters individual scores. |
| Scripted partner disclosure | Introduced as "pretend helpers" | `partner_disclosure` | Ethics-board decision. |
| Report bands | 3 strengths-framed bands, plus "not enough to say" by the SEM rule (§7.7) | `band_count=3` | |
| Pilot arms | **2 arms: `B_fixed` vs `A_narrative`**, randomised 1:1 within quota cells. Each arm uses **one fixed task order**, and **both arms complete the criterion battery**. | `pathway_mix` | Keeps the comparison direct and powered. B_adaptive, A+D and C are later waves. |
| Calibration level in the pilot | Scored modules run at **fixed L2** for the criterion cohort. **L1 only** for `practice_struggle` or an accessibility choice (flagged, analysed separately). A forced-level subsample (size set by VAL-02) estimates level effects. Common anchor trials link levels for later field use. | `calibration_policy` | Keeps scores on one scale. Decided before the dictionary v1 freeze (former open question 10). |
| Teamwork criterion | **Provisional interim criterion:** BFI-2 Agreeableness plus an administrator-rated observed cooperation task. A partner rating comes from the live-dyad substudy (EPI-06). This is recorded as a **gate exception**. | `hypotheses.yaml` | A scripted partner cannot give a rating. |
| Phone number confirmation | Picture-digit tiles on screen, or audio through a **headset only**. Never through speakers. | `contact_readback_mode` | Onlookers. |
| Retest reminders | **Pre-recorded native-speaker IVR call** by default. SMS is optional. | `reminder_channel` | Non-literate players (text gave 0% completion in Medhi et al.). |

### 1.5 Resolved design choices

| Topic | Decision |
|---|---|
| Kiosk shell | **Electron**, current stable major, pinned. Its bundled Chromium keeps timing and Web Audio behaviour identical across kiosks. |
| Kiosk OS | **One OS: Ubuntu Core 24 + Ubuntu Frame.** No Windows fallback during Stages 2–4. Any SKU or OS change is a new `timing_profile` and needs an invariance check (VAL-08). |
| Contracts | **JSON Schema 2020-12 in a restricted, linted profile** is canonical. **Ajv** is the canonical TS validator. TS types and Zod (for ergonomics only) and Pydantic v2 are generated from it. **Backend deploys first.** |
| Backend | **Python FastAPI.** The `scoring` package is shared between live scoring and research. |
| Database | **PostgreSQL 18** (latest RDS minor in ap-south-1). |
| Orchestration | **Dagster** only. R runs as an R package called through Dagster Pipes. |
| Criterion capture | **ODK Central (self-hosted, India) + ODK Collect** on managed Android tablets for questionnaires and ratings. A physical Tower of London board, with results entered in ODK. A small **Capacitor + SQLite** card-sort app with persistent storage. There is no custom tablet PWA. |
| Content and translation workflow | **git + YAML + spreadsheet review** round-trip with CI checks. No CMS. |
| Staff auth | **AWS Cognito (ap-south-1)** with MFA. Kiosks use mTLS device certificates from a small internal CA (step-ca). |
| Observability | OTel collector → **CloudWatch** (metrics, logs, alarms) plus **one Grafana** for dashboards. |
| Research dashboards | **Metabase** on `research_views` plus Quarto reports. Gate sign-off, wave freeze and policy approval go through **signed YAML in a governance git repo** (PLT-09). |
| Criterion scoring | **Python only.** R reads the scores. |
| Deferred (P2/PG) | Adaptive selector (ENG-12), trial reallocation (ENG-13), SIEM and hash-chained audit (PRV-13), SLSA provenance, Pathway C, the 22-language scale-out. |
| IDs | UUIDv7 for `event_id`, `session_id` and `batch_id`. **Ordering and partitioning never use kiosk wall time.** Order by `(session_id, seq)`, partition by server receive date. |
| Touch targets | ≥ 20 mm with ≥ 8 mm spacing. |
| Idle and walkaway | Re-prompt **8 s** after the response window. "Still there?" at **20 s**. Countdown at **45 s**, then **10 s** to abandon. Configurable per state and trial type. |
| Offline capacity | Sized for 30 days. An operations alert fires at 7 days unsynced. |
| Minimum samples per indicator | **No upper cap.** Each indicator's minimum comes from VAL-02 (Spearman–Brown plus simulation with literature priors). |
| Norming | **cNORM or GAMLSS on a post-stratified weighted sample**, with age and education as continuous predictors. Full norms are likely post-grant. Pilot norms are labelled *provisional*. |

---

## 2. Architecture and tech stack

### 2.1 Components

1. **Kiosk app (Electron, Ubuntu Core).**
   - Main process: SQLite outbox with per-session envelope encryption, ESC/POS printer, updater, device mTLS, telemetry. The P1 sherpa-onnx ASR addon is loaded only when policy and consent allow.
   - Renderer: React for onboarding and report, PixiJS for games, XState for the session orchestrator, trial runner, timing and calibration.
2. **Signed content packs**, versioned separately from app code: per-language audio (Opus) and manifests, pictograms, ASR grammars, game YAML bundles, the scoring dictionary, and the **release pack** (gate status, composite weights, band cut-points, expiry).
3. **Criterion capture** (supervised sites only): ODK Collect forms, the physical ToL board scored in ODK, and the card-sort app. Linked to kiosk sessions by a pid QR.
4. **Backend API (FastAPI).** Ingest, consent, linkage, study and quota config, device config, gate registry, release-pack builder and report token API.
5. **Data platform.**
   - PostgreSQL 18 schemas: `kiosk_raw`, `scored`, `criterion`, `consent`, `linkage`, `identity_vault` (separate DB), `study`, `validation`, `governance`, `research_views`.
   - S3 holds raw batches encrypted per session (no compliance-mode lock) and Parquet wave snapshots.
   - DuckDB for ad-hoc work.
6. **Pipelines (Dagster).** raw → events → trials → indicators → linked analysis dataset → reliability, validity, invariance, DIF, mode effects and norms → gate evaluation → release pack. Python steps use polars. R steps (lavaan, semTools, mirt, lme4/glmmTMB, brms, cNORM/gamlss, psych) run through Pipes.
7. **Reports:** Quarto stage reports and technical manuals.
8. **Platform services:** Cognito, step-ca, KMS, CloudWatch + Grafana, Metabase, OpenTofu, GitHub Actions.

### 2.2 Data flow

```
 ┌──────────────────────────── KIOSK (Electron on Ubuntu Core, offline-first) ─────────────────────────────┐
 │ Attract (touch only, MIC CLOSED) → Language faces → Consent (audio + TAP) → Bands (age, literacy, edu,   │
 │ gender, device use) → Practice+Warm-up ≤60 s → Pathway B carousel | Pathway A: Stall→Weighing→Road        │
 │ → Report (release pack gated) / thank-you → micro-survey → optional contact opt-in → wipe → Attract      │
 │ XState ─ Logger SDK ─► SQLite outbox (seq allocated in-txn; payload encrypted with per-session DEK,      │
 │                         DEK sealed to backend public key) ─► Uploader (session-ordered, consent first)   │
 │ ASR (P1, opt-in per prompt, after consent only) ─► {label, confidence}                                  │
 └──────────────────────────────────────────────┬──────────────────────────────────────────────────────────┘
                                                │ HTTPS mTLS · gzip NDJSON · batch_id If-None-Match
 ┌──────────────────────┐  pid QR               ▼
 │ ODK Collect + ToL    │──────────► ┌─────────────────────── BACKEND (AWS ap-south-1) ──────────────────────┐
 │ board + card-sort app│  item-level│ Ingest: verify sha → S3 raw (key=batch_id, cond. put) → Ajv/Pydantic    │
 │ (supervised only)    │  responses │ → event_dedup(event_id PK) → events (partition: server_received_date)   │
 └──────────────────────┘            │ → consent parking → DLQ │ Consent ledger │ Linkage (HMAC pid) │ Vault  │
                                     │ Study/quota │ Device config │ Gate registry │ Release-pack builder       │
                                     └──────────────────────────────┬──────────────────────────────────────────┘
                                                                    ▼
 ┌──────────────────────────────── DAGSTER (partitions: language × wave) ──────────────────────────────────┐
 │ trials_canonical → indicators_long (dictionary vX per pathway, frozen) → style_indices → session_quality │
 │ → criterion_scale_scores (Python) → analysis_wide → Parquet snapshot                                     │
 │ → R: reliability (per-type) · ICC(A,1) · MTMM pattern · hierarchical slopes · explanatory-IRT invariance │
 │   · GLMM DIF · site_mode invariance · weighted norms                                                     │
 │ → ValidationResult → asset checks → battery_release_gate + trait gates → signed release pack → kiosks   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Tech stack

Exact patch versions are pinned in M0 (PLT-08).

| Layer | Choice | Version line | Notes |
|---|---|---|---|
| Kiosk OS | Ubuntu Core 24 + Ubuntu Frame | Core 24 | Single OS and SKU for Stages 2–4 |
| App shell | Electron | current stable major, pinned per wave | `kiosk:true`, power-save blocker |
| Language / build | TypeScript 5.x/6.x for builds and lint; `tsgo` (TS 7 native) only for fast type-checks until its API stabilises | — | Protects typescript-eslint and Vite plugins |
| Bundler | Vite | current major | |
| UI shell | React | 19.x | Onboarding and report |
| Game rendering | PixiJS | 8.x | WebGL |
| Trial and session logic | XState | 5.x | Statecharts are the spec. Model-based tests. |
| Timing | `performance.now`, rAF, `PointerEvent.timeStamp`, Web Audio clock | platform | Per-SKU offsets from photodiode, tapper and audio loopback |
| Audio | Opus 48 kHz mono, −16 LUFS, ffmpeg | ffmpeg 7.x | |
| ASR (P1) | sherpa-onnx with a **keyword spotter or small intent classifier**, or IndicConformer with custom constrained decoding, **whichever wins the bake-off**; Silero VAD inside prompt windows only | pin in M0 | Opt-in per prompt |
| Local store | SQLite (better-sqlite3), WAL, per-session payload encryption | 3.4x/3.5x | |
| Printing / QR | ESC/POS raster 80 mm, `qrcode` | — | No printer-native Indic text |
| OTA | electron-updater rings, signed content manifests, snap refresh windows | — | Wave freeze |
| Contracts | JSON Schema 2020-12 (restricted profile) → Ajv, TS types, Zod; Pydantic v2; OpenAPI 3.1 | — | Forward-compatibility test |
| Backend | Python 3.13, FastAPI, SQLAlchemy 2, psycopg 3, Alembic, uvicorn | latest minors | |
| Database | PostgreSQL on RDS | **18, latest RDS minor** | pg_partman for events by server date |
| Object storage | S3 ap-south-1 (DR ap-south-2), versioning, MFA delete, conditional writes | — | No compliance-mode Object Lock on raw data |
| Analytics | Parquet + DuckDB | 1.x | |
| Feature engineering | polars, scipy, statsmodels | latest | |
| Psychometrics | R with lavaan, semTools, mirt, lme4, glmmTMB, brms (cmdstanr), psych, cNORM, gamlss, irr, boot, arrow; renv | R latest release, pinned image | |
| Orchestration | Dagster | 1.x latest | Assets, partitions, asset checks, Pipes |
| Reports | Quarto | latest GA | |
| Criterion capture | ODK Central + ODK Collect; Capacitor + SQLite card-sort app | latest | Audio prompts per language, audit logs |
| Research BI | Metabase (self-hosted) | latest | Read-only on `research_views` |
| Auth | AWS Cognito (staff, MFA); step-ca (kiosk mTLS) | — | |
| Secrets / KMS | AWS KMS | — | Envelope encryption |
| Observability | OpenTelemetry → CloudWatch; Grafana | OTel JS 2.x / Py 1.x | |
| Infra | ECS Fargate, RDS, S3, OpenTofu; pilot alternative: 2 VMs + Docker Compose | — | No Kubernetes |
| Monorepo | pnpm + Turborepo; uv workspaces; renv; Node LTS | current majors | |
| Testing | Vitest, Playwright (Electron), fast-check, pytest + hypothesis, testthat, Schemathesis | current | Golden sessions, simulated players |
| CI/CD | GitHub Actions, Renovate (soak periods), cosign signing, CycloneDX SBOM, CodeQL, osv-scanner | — | Release tags record app × content × dictionary |

---

## 3. Monorepo layout

> **Layout reorganised (October 2026).** The tree below is the original planning layout and is kept as historical
> text. The repository is now grouped by responsibility: `frontend/` (kiosk, Electron shell, web app and their
> packages), `backend/api`, `stats/` (scoring, validation, simulator, R psychometrics, measurement model YAML,
> reports, pre-registration), `contracts/`, `content/`, `infra/`, `cicd/`, `tools/` and `docs/`. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the current layout and the old-to-new path map.

```
shriii-kiosk-games/
├─ package.json  pnpm-workspace.yaml  turbo.json  pyproject.toml (uv)  renv.lock
├─ apps/
│  ├─ kiosk/
│  │  ├─ main/            # outbox, per-session crypto, printer, updater, mTLS, HAL, telemetry, watchdog, (P1) ASR addon
│  │  ├─ preload/         # typed minimal IPC bridge (contextIsolation, sandbox)
│  │  └─ renderer/
│  │     ├─ shell/        # attract, session statechart, walkaway, admin/pilot/think-aloud modes
│  │     ├─ onboarding/   # language faces, consent+tap, bands (incl. literacy), practice+warm-up
│  │     ├─ engine/       # timing, RNG, scheduler, calibration, module runtime, logger SDK
│  │     ├─ games/        # dont-tap, card-sort, tower, balloon, share-pot, wait-or-now, steady-hands, four-stalls, private-dice
│  │     ├─ episodes/     # stall, weighing-post, road-home, coplay, orchestrator
│  │     └─ report/       # release-pack reader, band → audio segments, bitmap page, QR, demo mode
│  ├─ card-sort-app/      # Capacitor + SQLite criterion card sort (supervised only)
│  └─ api/                # FastAPI: ingest, consent, linkage, study, device, gates, release packs, report tokens, erasure
├─ packages/
│  ├─ contracts/          # JSON Schema 2020-12 (restricted profile) + profile linter
│  ├─ contracts-ts/       # generated Ajv validators + TS types + Zod (do not edit)
│  ├─ api-client/         # generated from OpenAPI
│  ├─ ui/                 # icon-first components, pictograms, tokens
│  └─ game-kit/           # Pixi helpers, timing utils, audio player, SayOrTouch
├─ python/
│  ├─ contracts_py/       # generated Pydantic v2
│  ├─ scoring/            # indicators (polars), style engine, quality flags, criterion keys, band lookup reference
│  ├─ simulator/          # synthetic players + criterion + retest + DIF (ground truth)
│  └─ pipelines/          # Dagster assets, checks, Pipes launchers, release-pack builder
├─ r/psychometrics/       # R package + testthat
├─ reports/               # Quarto templates
├─ scoring/
│  ├─ dictionary/         # dictionary.B.yaml, dictionary.A.yaml, shared.yaml (versioned, frozen per pathway)
│  ├─ hypotheses.yaml     # pre-registration (primary/exploratory families, thresholds, targets)
│  └─ gates.yaml          # battery + trait gate rules (frozen per wave)
├─ content/
│  ├─ games/  audio-packs/<lang>/  asr-grammars/<lang>/  variants/<lang>/<variant>/  odk-forms/<lang>/
│  └─ translation/        # spreadsheet round-trip exports + ITC state YAML
├─ governance/            # signed approvals: policy, dictionary freeze, gate sign-offs, wave freeze, amendments
├─ tools/  audio-pipeline/  codegen/  timing-calibration/  replay/  trial-budget/  plan-lint/
├─ infra/  tofu/  docker/  kiosk-image/ (snapcraft, model assertion, Frame config)
└─ .github/workflows/  ci.yml  schema-compat.yml  kiosk-release.yml  deploy.yml  nightly-sim.yml
```

---

## 4. Evidence-centred design: traceability matrix and session budgets

### 4.1 Construct kinds

- **E (executive/regulatory):** performance under controlled demands.
- **S (style):** within-person variability across repeated comparable trials and deliberate context changes.
- **M (social/moral):** needs an agent, a temptation and a consequence.

**Classification note.** The note's first grouping lists decisiveness and expressive restraint among the style traits. This plan scores them as **E** because each has a standard criterion: GDMS for decisiveness and ERQ-suppression for restraint. The note's p.7 also narrows "style" to consistency, persistence of style and stability. Even so, **within-person variability indices** (RVI, §5.9 SCR-10) are also computed for decisiveness (time-to-commit) and restraint (inter-tap interval) and reported as **exploratory** style indicators.

### 4.2 Tiers and pathway coverage

- **Tier 1 (confirmatory, one primary hypothesis per construct):** self-control, adaptability, problem solving, decisiveness, risk preference, persistence (E), teamwork (provisional criterion), emotional regulation (**Pathway A only**).
- **Tier 2 (exploratory, pre-registered, BH-FDR):** composure, task organisation, expressive restraint, initiative, judgement/accountability (**A only**), and the style traits (validated through retest plus pre-registered nomological predictions).
- **Group-level only:** integrity via Private Dice. Individual integrity uses Weighing Post dilemmas only, and is *restricted* and Tier 2.
- **A-only constructs:** emotional regulation (2) and judgement (12). Their **B gates are permanently `withheld`**. The note rates B as partial (◐) on emotional regulation, but B has no provocation paradigm that fits the 60–120 s module budget. A frustration probe after an unfair loss in Share-the-Pot is recorded as an **exploratory** B indicator (`emotional_regulation.tone_after_unfair_loss_B`). It is not used for gates.

### 4.3 Matrix (17 constructs)

| # | Construct | Kind | Tier | Pathway B module | Pathway A episode | Key indicators | Convergent criterion (battery block) | Discriminant |
|---|---|---|---|---|---|---|---|---|
| 1 | Self-control | E | 1 | Don't-Tap (GNG), Wait-or-Now (slot) | Stall don't-serve | `self_control.nogo_commission_rate`, `.ezd_drift_nogo` (EZ-diffusion), `.delay_discount_logk`, `.effort_discount`, `.choice_consistency` | BSCS (X); BFI-2 Conscientiousness (X) | BFI-2 Extraversion; GDMS spontaneous |
| 2 | Emotional regulation | E | 1 (A only) | *withheld*; exploratory `.tone_after_unfair_loss_B` | Stall rude-customer run | `emotional_regulation.tone_after_provocation`, `.mirroring` (match between chosen tone and the customer's tone level), `.drift_slope_difficult_run` (person random slope) | DERS-16 (−, X); ERQ reappraisal (+, block A) | CFI; HEXACO-HH |
| 3 | Composure under pressure | E | 2 | Don't-Tap / Card Sort pressure blocks | Stall timed rush | `composure.pressure_slope_accuracy` and `.pressure_slope_rt` (person random slopes, hierarchical), `.error_type_shift` | BFI-2 Negative Emotionality (−); DERS-16 (−) | HEXACO-HH; Grit-S |
| 4 | Response consistency | S | 2 | Balloon, Don't-Tap, Four Stalls (slot), probe trials | Cross-episode probes | `response_consistency.rt_rvi` (relative variability index), `.loc_scale_sigma` (person residual SD), `.choice_entropy_repeats` | Retest ICC; nomological: Conscientiousness (−ISD) | BFI-2 Openness |
| 5 | Task organisation | E | 2 | Tower (illegal moves) | Road Home multi-errand | `task_organisation.errand_order_efficiency`, `.revisits`, `.idle_time`, `.illegal_move_attempts` | BFI-2 Conscientiousness (organisation); GDMS rational | ERQ suppression |
| 6 | Decisiveness | E | 1 | Balloon time-to-collect | Weighing Post | `decisiveness.time_to_commit`, `.reversals_before_confirm`, `.info_gathered`; exploratory `.commit_rvi` | GDMS avoidant (−) and rational (X) | DERS-16 |
| 7 | Adaptability / flexibility | E | 1 | Card Sort (unannounced switch + reversal) | Road Home reversal; Weighing new rule | `adaptability.perseverative_errors`, `.trials_to_reacquire`, `.switch_cost_slope` (hierarchical), `.rule_compliance_post_shift` | Criterion card sort (X); CFI (block B) | HEXACO-HH; Grit-S |
| 8 | Persistence of response style | S | 2 | All modules' style vector | All 3 episodes | `persistence_of_style.cross_segment_style_r` (≥ 4 comparable segments), `.lag1_autocorr`, `.post_loss_adjustment` | Retest ICC; nomological predictions | — |
| 9 | Stability under situational change | S | 2 | Card Sort switch; pressure blocks | A1 rude run, A2 new rule, A3 reversal | `stability.shift_slope` (hierarchical, standardised within person) | Retest ICC; BFI-2 Negative Emotionality (−) | Openness |
| 10 | Expressive restraint | E | 2 | Don't-Tap premature/extra taps; Steady Hands (slot) | Stall premature serves | `expressive_restraint.premature_taps`, `.extra_taps`, `.held_vs_free_slope`; exploratory `.iti_rvi` | ERQ suppression (block A); BFI-2 Extraversion (−) | CFI |
| 11 | Teamwork | M | 1 (provisional) | Share-the-Pot (scripted partners, error round) | Road Home fuel pot; **D live dyads** | `teamwork.mean_contribution`, `.response_to_partner_defection`, `.response_to_partner_error`, `.turn_waiting` and `.interruptions` (D), `.coplay_credit_share` (D) | **Interim:** BFI-2 Agreeableness (X) + administrator-rated observed cooperation task; **partner rating** (D substudy) | BSCS |
| 12 | Judgement / accountability | M | 2 (A only) | *withheld* | Weighing Post (assistant mistake, fraud found) | `judgement.credit_taking`, `.blame_shifting`, `.consistency_across_dilemmas` (≥ 3 per dilemma type) | HEXACO-HH; moral identity (block A) | GDMS spontaneous |
| 13 | Problem solving | E | 1 | Tower of London | Road Home route and replan | `problem_solving.excess_moves`, `.planning_time`, `.recovery_after_failure`, `.excess_route_cost` | Criterion ToL board (X); BFI-2 Openness (intellect) | ERQ |
| 14 | Integrity | M | 2, *restricted* | Private Dice (slot): **group level only** | Weighing Post (bribe, overpayment) | Individual: `integrity.bribe_acceptance`, `.overpayment_return` (≥ 3 each). Group only: `.dice_overreport_rate`, `.report_distribution_skew` | HEXACO-HH (X); individual MTMM uses Weighing indicators only. Dice validated as over-report by HH tertile | BSCS; CFI |
| 15 | Initiative and planning/organising | E | 2 | Tower planning-before-acting; Share-the-Pot unprompted share | Road Home optional actions | `initiative.optional_actions_unprompted`, `.planning_time_before_first_move`, `.unprompted_share` | BFI-2 Conscientiousness/assertiveness; Grit-S | DERS-16 |
| 16 | Risk preference | E | 1, *restricted* | Balloon (BART) | Weighing gamble inspection | `risk_preference.adjusted_pumps`, `.explosion_rate`, `.gamble_rate` | General risk-taking single item (X); BSCS (−, weak) | HEXACO-HH |
| 17 | Persistence (executive) | E | 1 | Tower unsolvable; Wait-or-Now effort (slot) | Road Home blocked-road retries | `persistence.time_on_unsolvable` (≥ 2 unsolvable items per pathway), `.retries_on_blocked_route`, `.effort_completion_rate` | Grit-S (X) | ERQ |

**Matrix rules.**
- Each construct has ≥ 2 indicators from ≥ 2 tasks within at least one pathway. Constructs that fall short of this in a pathway are `withheld` for that pathway.
- **Indicators resting on one or two events are not scored individually.** They are either given more items (as above) or marked `group_only`.
- **Difference-based indicators** (composure, stability, switch cost, held-vs-free, distractor cost) are estimated as **person-level random slopes** in hierarchical models (lme4/glmmTMB/brms) or as diffusion parameters. Their model-based reliability is reported. The pre-registration states that **difference-based constructs may stay `research_only`**.
- **Speed–accuracy:** Don't-Tap, Card Sort and Stall go/no-go also get **EZ-diffusion** drift and boundary estimates. The boundary (caution) is reported as a **style** indicator and is not mixed into self-control or composure.
- **Dice indicators never feed individual scores or other constructs.**
- The expected convergent r is **.10–.30** (from the literature). There is **no upper bound**. The confirmatory test is that the **lower CI bound exceeds the pre-registered minimum (.10)**, plus the own > discriminant pattern (§7.7).
- Integrity and risk bands are capped at "broad style" or withheld.

### 4.4 Session time budgets (checked in CI by ONB-08 and the `cicd/trial-budget` sheet)

Budgets are at L2 and measured in seconds. The **trial-time budget spreadsheet** (`cicd/trial-budget`, SCR-03) is built in M0 from measured seconds per trial × the required trials per indicator (from VAL-02). It is the source of truth. The numbers below are design targets.

| Segment | Pathway B | Pathway A | Scorable? |
|---|---|---|---|
| Language + consent + bands (ONB-01/02/04) | ≤ 90 | ≤ 90 | No |
| Practice + warm-up/calibration (ONB-05, ENG-10) | ≤ 60 | ≤ 60 | No (`scorable=false`) |
| Scored play | 5 core modules × 90–115 + 1 planned-missingness slot × 60–100 ≈ **570–620** | Stall 200 + Weighing 200 + Road 200 ≈ **600** | Yes |
| Hub bridges / episode transitions | ≤ 30 | ≤ 30 | No |
| Report or thank-you + micro-survey | ≤ 90 | ≤ 90 | No |
| Contact opt-in + number entry (optional, after report) | ≤ 30 | ≤ 30 | No |
| **Total (cap 900)** | **≤ 890** | **≤ 890** | |

- **Each B module is 60–120 s at every level** (ENG-05 AC). The carousel has **6 modules per session**: 5 fixed core modules plus 1 slot.
- **Planned missingness:** the slot module is **randomly assigned at session start** (seeded, logged) from {Wait-or-Now, Steady Hands, Four Stalls, Private Dice}. This is a 4-form design, so the missingness is MCAR by design and FIML or multiple imputation is valid.
- **Every scorable 60 s slice must yield indicators for ≥ 2 constructs** (ENG-04 build check).
- **Fixed order is a deliberate departure** from the note's adaptive selector. Selector-driven missingness is non-random and would bias validation. The selector (ENG-12) is post-grant.

---

## 5. Feature list

Prefixes: **PLT** platform · **KSK** kiosk · **VOX** audio, speech and localisation · **ONB** onboarding · **ENG** engine · **MG** micro-games · **EPI** episodes and pathways · **ING** ingestion · **SCR** scoring · **CRT** criterion and studies · **VAL** validation and gates · **REP** reports · **PRV** privacy, security and governance · **QA** testing.

Header format: `#### ID · Title — Priority · Milestone · deps: … · src: …`. Milestones are defined in §8: M0 P5–P7, M1 P6–P9, M2 P6–P10, M3 P8–P11, M4 P12–P18, M5 P17–P21, M6 P20–P24, PG post-grant.

### 5.1 PLT: Platform foundations

#### PLT-01 · Monorepo scaffold — P0 · M0 · deps: — · src: KIOS-01, GAME-01, DATA-01
Set up pnpm + Turborepo, uv workspaces and renv with the §3 layout. Boundary lint: `engine/` has no DOM or Pixi imports, and `games/` cannot import `main/`. A browser dev mode shows a debug overlay with seed, trial, condition and frame timing.
- AC: From a clean clone on Linux and Windows dev machines, `pnpm i && pnpm build && uv sync` succeeds.
- AC: The boundary lint fails the build when `engine` imports DOM or Pixi.
- AC: A second CI build with no changes is a cache hit and takes under 60 s.

#### PLT-02 · Canonical contracts: restricted JSON Schema profile, Ajv, Pydantic — P0 · M0 · deps: PLT-01 · src: DATA-01, DATA-04, GOV-20
`contracts` holds JSON Schema 2020-12 for event, batch, session-context, consent, criterion response, content manifest, deployment policy, release pack, report payload and the dictionary schema. A **profile linter** bans keywords outside the supported subset: `$dynamicRef`, `unevaluatedProperties`, `if/then/else` and non-discriminated `oneOf`. Discriminated unions use `event_type` with a `const`. Generated outputs: Ajv standalone validators (canonical in TS), TS types, Zod (ergonomics only) and Pydantic v2.

**Compatibility policy:**
- Minor versions add optional fields only.
- The **backend deploys first** and accepts minor N+1 fields: unknown optional fields are stored in `payload_ext` and not rejected.
- Kiosks keep `additionalProperties:false` for their own outgoing events.
- A major version needs a new file plus a backend upcaster.

- AC: Codegen is deterministic and CI fails on drift.
- AC: Ajv and Pydantic accept the same 200 valid fixtures and reject the same 50 malformed fixtures, all within the profile.
- AC: **Forward-compatibility test:** an event at minor N+1 is accepted by backend N+1 and by backend N in "N+1-aware" mode. A deploy order check in CI blocks a kiosk release whose schema minor is ahead of production.
- AC: Payload schemas forbid any field named `text|free_text|transcript|audio`.

#### PLT-03 · Version tuple and content manifest stamping — P0 · M0 · deps: PLT-02 · src: DATA-05, KIOS-25, GOV-17
Every session records: `app_version`, `content_pack_version`/`bundle_hash`, `audio_manifest_hash`, `variant_pack_id`, `scoring_dict_version` (per pathway), `indicator_set_version`, `protocol_version`, `policy_version`, `release_pack_version`, `device_profile_id`, `hardware_sku`, `timing_profile_version`. The manifest registry maps stimulus, audio and layout IDs to semantic attributes, including **customer tone level** (voice clip variant and face asset) for the Stall. Sessions with an unknown manifest are parked in `awaiting_manifest`.
- AC: 100% of trials join to stimulus attributes.
- AC: Uploading a manifest unparks the waiting sessions.
- AC: Release tags record the `app × content × dictionary × release-pack` tuple.

#### PLT-04 · CI/CD pipeline — P0 · M0 · deps: PLT-01, PLT-02 · src: GOV-20
GitHub Actions stages: lint and types → unit and property tests → schema profile and compat checks → plan-lint (PLT-08) → scoring golden tests → content completeness → **small** simulated-player recovery run (n = 50 sessions per arm, analysis on precomputed fixtures) per PR, with the **full** run nightly → CodeQL, osv-scanner and CycloneDX SBOM → cosign-signed snap → container images to ECR → OpenTofu plan and apply to staging → Playwright E2E → manual ring promotion. Renovate applies updates with soak periods.
- AC: An incompatible schema PR fails unless it bumps the major version and includes migration notes.
- AC: Builds are cosign-signed and include an SBOM. The same commit gives the same web-asset hashes.
- AC: Staging rebuilds from IaC in under 30 minutes.

#### PLT-05 · Infrastructure in India regions (OpenTofu) — P0 · M0 · deps: PLT-04 · src: stack
VPC, RDS PostgreSQL 18 Multi-AZ, S3 (versioning, MFA delete, SSE-KMS, conditional writes), ECS Fargate (api, dagster webserver and daemon, metabase, grafana, odk-central), KMS keys, Cognito user pool. DR goes to ap-south-2. A Docker Compose profile covers local work and the 2-VM pilot alternative.
- AC: `tofu apply` creates staging from zero. *Drill:* a quarterly DR restore into ap-south-2.
- AC: A policy-as-code check confirms no resource exists outside the India regions.

#### PLT-06 · Observability: product, timing and data quality — P0 · M0 · deps: PLT-05 · src: DATA-35, GOV-19
OTel runs in Electron main and renderer, FastAPI and Dagster, scrubbing PII at the SDK, and exports to CloudWatch, with Grafana for dashboards. Panels:
- funnel and walkaway histogram
- input mode share
- indicator valid-trial counts against each indicator's minimum
- frame-time p99 and audio underruns
- outbox depth and last-upload age
- DLQ and parked-session rates by build
- calibration-level distribution
- session duration against budget
- would-play-again by pathway

Alarms: kiosk offline > 30 min, unsynced > 24 h, clock offset > 2 s (from sync estimates), DLQ > 0.5%, consent-parked events > 72 h, pipeline failure.
- AC: Every panel is populated by a synthetic fleet of 10 kiosks (QA-02).
- AC: A scanner over 10k sampled spans finds no audio, contact details or free text.
- AC: Each alarm fires in a chaos test.

#### PLT-07 · Research dashboards (Metabase) — P1 · M2 · deps: PLT-06, PRV-08, ING-06 · src: PSYC-29, stack
Metabase, read-only on `research_views`. Dashboards: recruitment and quota fill, linkage rate, retest progress, QC flags, validation scorecards, MTMM heatmaps (rendered from Quarto artefacts), the gate matrix (read from `validation.gate_registry`), and the consent and erasure queue (counts only). Sign-off actions are **not** done here. They go through PLT-09.
- AC: Quota cards refresh within 5 minutes of a sync.
- AC: The Metabase DB user can read only `research_views`. A permission test confirms this.

#### PLT-08 · Plan lint, dependency graph and version verification — P0 · M0 · deps: PLT-01 · src: review
`cicd/plan-lint` parses the feature headers in this document (or its `features.yaml` mirror). It fails on unknown IDs, cycles, a dependency whose milestone starts later than the feature's, or a dependency with a lower priority (P0 < P1 < P2 < PG). It also produces a topological build order. **Version verification task:** check every stack entry against official release pages and RDS engine versions, then write `docs/VERSIONS.md` with the exact pins.
- AC: The CI job is green on this plan. Introducing a cycle makes it fail.
- AC: `VERSIONS.md` exists before any M1 feature is merged.

#### PLT-09 · Governance sign-off repository — P0 · M0 · deps: PLT-04 · src: GOV-08, review
`governance/` holds signed YAML records: policy approvals, dictionary freezes, hypothesis and gate freezes, wave freezes, amendments, gate promotions and battery-gate sign-offs. CODEOWNERS requires approval from named roles (PI/ResearchLead plus EthicsOfficer for gates; two people for policy). Commits are signed (sigstore or gitsign). The pipeline imports only records whose signatures verify. This replaces a dashboard sign-off UI and gives an auditable history.
- AC: An unsigned or single-approver gate record is ignored by the gate service, with a logged reason.
- AC: Every imported record carries a commit SHA and a signer identity.

### 5.2 KSK: Kiosk shell, hardware and fleet

#### KSK-01 · Electron kiosk shell — P0 · M0 · deps: PLT-01 · src: KIOS-01, GAME-01
A single fullscreen `kiosk:true` window. contextIsolation, sandbox, strict CSP (no remote origins), devtools compiled out, power-save blocker. Right-click, zoom, swipe-navigate and text inputs are disabled. A watchdog relaunches to attract. **No camera APIs are compiled in**: the build plugin strips `getUserMedia({video})` and the permission handler denies video.
- AC: Builds produce a signed snap.
- AC: CSP blocks `fetch` to external URLs.
- AC: Killing the renderer relaunches to attract within 5 s and logs `session.abandoned{reason:crash_recovery}`.
- AC: Cold start takes under 6 s on the reference hardware.
- AC: A static check confirms no video capture call sites exist in the bundle.

#### KSK-02 · Session lifecycle statechart — P0 · M0 · deps: KSK-01 · src: KIOS-02
XState states: attract → languageSelect → consent → bands → practiceWarmup → play (carousel or episodes, as a typed actor) → report → survey → contactOptIn (optional) → farewell → wipe. Every transition emits `session.state_changed`. Each state has a hard ceiling, and the session has a hard cap of 15 minutes with a graceful wrap-up. **Crash policy: abandon and keep consented events. There is no resume.**
- AC: Model-based tests cover every path, including walkaway from every state.
- AC: A property test over 10k random event sequences shows `play` is never reachable without `consent.granted{tap_confirmed:true}`.
- AC: Timers use statechart delays and are tested with a simulated clock.

#### KSK-03 · Attract loop and touch-only start — P0 · M1 · deps: KSK-02, VOX-01 · src: KIOS-03
The guide animates in a loop. Greetings rotate through the enabled languages, at most one every 20 s, with a volume cap and quiet hours. **A session starts only by touch, or by the optional non-imaging presence sensor (which only triggers the greeting). There is no wake word.** The microphone stream is **closed** in attract, languageSelect, consent and bands (PRV-03).
- AC: A first touch starts onboarding within 300 ms.
- AC: Quiet hours are honoured (mock clock).
- AC: A 72 h soak shows memory growth under 50 MB.
- AC: An integration test confirms no audio input track exists in attract, languageSelect or the pre-consent states.

#### KSK-04 · Idle, walkaway and abandon — P0 · M1 · deps: KSK-02, KSK-07 · src: KIOS-04, GAME-11, GOV-03
Inactivity means no touch and no sensor presence. VAD counts only inside consented ASR prompt windows. Inactivity is counted only after the trial's response window. Sequence: 8 s re-prompt; 20 s "still there?"; 45 s countdown, then abandon at 10 s. Abandoning wipes screen and memory and keeps the consented events. A pause marks the trial `interrupted=true`, and that trial is excluded from latency indicators. Walkaway is disabled in think-aloud mode.
- AC: A screenshot diff shows no trace of the previous player within 1 s of the countdown ending.
- AC: `session.abandoned` carries `last_state`, `module`, `trial`, `elapsed_ms` and `reason ∈ {timeout, explicit_exit, consent_declined, crash_recovery, under_age}`.
- AC: Interrupted trials are excluded in the dictionary fixtures.

#### KSK-05 · Icon-first, no-reading UI kit and "never voice" rule — P0 · M0 · deps: KSK-01 · src: KIOS-05, GOV-14
`packages/ui`: BigTap (≥ 20 mm), HoldButton, SayOrTouch (icon first; the mic ring appears only when ASR is enabled), ChoiceGrid (2–4 options), ConfirmTick/Cross, ReplayAudio, Exit/Help, and **PictureDigitPad** (digits shown as picture tiles plus spoken digits through a headset only). Every interactive element has an audio key. No flashing above 3 Hz.

**Never-voice checklist** (lint plus a manifest flag `voice_forbidden`): phone digits, private-report choices, dice outcomes, bribe decisions and report content when "show privately" is on. None of these is ever played through the speakers.
- AC: A lint fails any interactive element without an audio key.
- AC: Target ≥ 20 mm and spacing ≥ 8 mm at the configured DPI.
- AC: No flashing above 3 Hz in recorded E2E video.
- AC: The audio router refuses to play `voice_forbidden` clips on the speaker output, tested with headset absent and present.

#### KSK-06 · Accessibility and inclusive design — P0 · M1 · deps: KSK-05 · src: KIOS-16, GAME-34, GOV-25
- Colour-blind-safe tokens. Colour is never the only cue.
- Contrast ≥ 4.5:1.
- A slower-pace choice maps to **L1**, which is flagged.
- Volume boost and headset support.
- A pictogram storyboard for hard-of-hearing players.
- Targets in the lower two-thirds of the screen.
- Configurable hold thresholds.

`a11y.profile` is logged as a covariate.
- AC: Colour-vision simulation gives ΔE ≥ 20 between paired categories.
- AC: The kiosk lint passes for every screen.
- AC (*study*): think-aloud includes ≥ 6 participants aged 60+, with completion ≥ 80%.

#### KSK-07 · Offline-first outbox with per-session encryption — P0 · M0 · deps: KSK-01, PLT-02 · src: KIOS-17, DATA-07
SQLite in WAL mode. Tables: sessions, events (append-only), consents, outbox, session_keys.

**Per-session data key (DEK).** Each session gets a random DEK. Event payloads are encrypted with AES-GCM. The DEK is sealed to the **backend public key** (X25519 sealed box) and to the kiosk TPM for local purge. **`seq` is allocated in the same SQLite transaction as the event row.**

**Uploader** (main process):
- **session-ordered batches**, so a session's `consent.granted` always comes before its scorable events
- ≤ 500 events or ≤ 256 kB, gzipped, sha256, `batch_id` UUIDv7
- exponential backoff with jitter (1 s to 15 min), mTLS
- **paused during play**

Terminal per-event statuses from the server: `accepted`, `duplicate`, `rejected_terminal` (the server has already copied the event to the DLQ). These are purged locally after a grace period. `retryable` events stay. When the quota is reached, new sessions stop. Data is never silently dropped.
- AC: Pulling power mid-trial loses at most the in-flight event, and `integrity_check` passes.
- AC: Replaying a batch 5 times stores one copy.
- AC: A 48 h offline soak with 200 sessions uploads with zero loss.
- AC: No upload activity occurs during play.
- AC: Unsynced data survives app updates.
- AC: `seq` is gapless per session in the local DB under fuzzed crashes.

#### KSK-08 · Hardware abstraction layer and single reference SKU — P1 · M2 · deps: KSK-01 · src: KIOS-21
One SKU for Stages 2–4: PCAP touchscreen 21.5–27" (IK08), speakers, headset detection, USB mic, 80 mm ESC/POS printer with paper sensor, optional mmWave presence sensor, optional NFC reader. Boot self-test, per-device status and heartbeat.
- AC: If touch or speakers fail, the kiosk shows an "out of service" screen.
- AC: Paper-low reaches the heartbeat within 60 s and the report falls back to QR.
- AC: Device model and firmware are recorded in `session.context`.
- AC: A nightly hardware-in-the-loop job runs.

#### KSK-09 · OS lockdown and tamper resistance (Ubuntu Core) — P1 · M3 · deps: KSK-01, KSK-07 · src: KIOS-24, GOV-14
Model assertion with Frame and the app snap: no desktop, USB storage disabled, secure boot, TPM-backed full-disk encryption. Provisioning rebuilds a locked kiosk from bare hardware.
- AC (*manual*): an escape checklist (edge swipes, multi-finger gestures, long-press, USB keyboard, power button) does not reach the OS.
- AC: After power loss, the kiosk returns to attract with no operator action.
- AC: Provisioning is reproducible on a clean device.

#### KSK-10 · Fleet provisioning, heartbeat and remote commands — P1 · M3 · deps: KSK-07, PRV-07 · src: GOV-15, KIOS-25
Zero-touch enrolment by QR token gives a keypair, a step-ca mTLS certificate and a site and policy assignment. A heartbeat every 60 s reports versions, disk, power, temperature, network, **clock offset estimate**, touch self-test, printer, unsynced count and frame-time p99. Remote commands: lock, wipe, restart, pull scrubbed logs, sync.
- AC: Boxed to session-ready in under 20 minutes.
- AC: Remote lock applies within 2 minutes when online, or at the next boot.
- AC: The heartbeat carries no participant identifiers.

#### KSK-11 · Signed OTA with rings and wave freeze — P1 · M3 · deps: KSK-10, PLT-03, PRV-01 · src: KIOS-25, GOV-17
App updates through electron-updater rings (lab → 1 kiosk → 10% → all). Content, dictionary, policy and **release packs** have their own signed manifests. Updates apply only in attract, and a failed health check rolls back. A **wave freeze** pins app, content and dictionary versions. **T1 and T2 retest sessions run inside the same frozen wave.** Emergency overrides need a PLT-09 record.
- AC: A forced update during play does not interrupt play.
- AC: Rollback within 5 minutes.
- AC: Unsigned or downgraded packs are rejected.
- AC: Pushing a different dictionary during a freeze is blocked.

#### KSK-12 · Privacy from onlookers — P1 · M3 · deps: VOX-01, ENG-06, KSK-08 · src: KIOS-20, GOV-14
Privacy filter film on the screen. Private-report steps use an "own corner" interaction: headset whisper when available, dimmed periphery, brief outcome display. A "someone watching?" icon hides the screen and logs it. The never-voice checklist (KSK-05) is enforced. The end wipe clears screen, audio buffers and cache. The report has "show privately" and auto-clears after 60 s.
- AC: A per-language snapshot checklist confirms private screens and phone confirmation never use the speakers.
- AC: `onlooker_reported` and `headset` flags are on private-report events.
- AC: In `open_public` mode, private-report trials require a headset or are skipped (logged).

#### KSK-13 · Pilot and admin mode — P1 · M2 · deps: KSK-02, ENG-07, CRT-06 · src: KIOS-19
Hidden unlock by NFC card, or corner long-press plus a rotating picture PIN. Admin can set study, site, quota display and forced level (forced-level subsample only), and can scan a pid QR. A coloured bezel strip shows admin mode, and `mode` is logged on every session. Five failed unlocks lock admin mode for 15 minutes.
- AC: Pairing is unavailable in public mode.
- AC: The arm and seed are reproducible.
- AC: All unlock attempts are logged.

#### KSK-14 · Low-spec performance hardening — P1 · M3 · deps: ENG-01, VOX-01 · src: GAME-34
Texture atlases, per-episode preload, memory caps. **Degrade mode keeps stimulus durations in milliseconds** (the frame count is recomputed at 30 Hz). Trials whose duration error exceeds a frame are **excluded from timing-sensitive indicators**, not just flagged.
- AC: P95 frame time ≤ 16.7 ms in the Stall rush on the reference kiosk.
- AC: In degrade mode, timing-sensitive indicators exclude affected trials (fixture test).

### 5.3 VOX: Audio, speech and localisation

#### VOX-01 · Pre-recorded audio playback engine — P0 · M0 · deps: KSK-01, VOX-02 · src: KIOS-09, GAME-12
Web Audio engine with per-episode Opus pre-decode, gapless sequencing, ducking, a 30 ms fade on interrupt and a replay API. Clips are resolved by key through the manifest. Output routing respects `voice_forbidden`. No TTS. Onset is scheduled on `AudioContext.currentTime`, and **the per-SKU audio output latency (ENG-02 loopback) is applied** to `audio_onset` and `prompt_audio_end`.
- AC: `audio.played` carries key, manifest version, sha256, duration and `completed|interrupted`.
- AC: The dependency audit finds no TTS library.
- AC: Zero underruns in a 50-session soak.
- AC: Corrected onset error SD ≤ 10 ms on the loopback rig.

#### VOX-02 · Audio asset pipeline — P0 · M0 · deps: PLT-01 · src: KIOS-10
Node + ffmpeg CLI: clipping and noise-floor checks, silence trim and pad, two-pass loudnorm to −16 LUFS / −1 dBTP, Opus 48 kbps, sha256 and duration. Per-language manifests list key, file, hash, duration, speaker, take, script version and review state. Packs are ed25519-signed.
- AC: −16 ± 0.5 LUFS and ≤ −1 dBTP on re-measure.
- AC: The production build fails on a missing or unapproved key.
- AC: Clips longer than 1.5× the source-language duration are flagged.

#### VOX-03 · Guide character presentation — P0 · M1 · deps: VOX-01, ENG-04 · src: GAME-12
One guide across onboarding, hub and episodes, with timing-track mouth sync and a sprite-sheet fallback. Every instructional state has an audio cue and a replay button.
- AC: An automated check finds an audio cue for every player-facing state.
- AC: `instruction_replay` is logged.

#### VOX-04 · Closed-vocabulary ASR, opt-in per prompt — P1 · M3 · deps: KSK-01, VOX-05, VOX-06, PRV-03 · src: KIOS-11, GOV-04, GAME-11
Runs only when: policy `asr_enabled`, core consent granted, the prompt passed VOX-06, and noise is below the threshold. The mic opens **only inside a consented prompt window** and closes at its end. The engine is the bake-off winner: sherpa-onnx keyword spotter, small intent classifier, or IndicConformer with custom constrained decoding. ASR only **proposes**: the icon highlights and a tap or high-confidence voice commits. **Consent, opt-ins and private reports are touch only.** Audio lives in a RAM ring buffer and is discarded after decoding.

**Production logs:** `input_mode`, `asr_label`, `asr_confidence`. Confidence is justified under core consent because quality flags need it. **No top-k alternatives.** They are logged only under the supervised ASR-evaluation consent (VOX-06).

**Latency:** voice-answered trials are **excluded from latency indicators**. Choice indicators keep them, and `input_mode` is modelled as a covariate.
- AC: voiceOptions ⊆ touchOptions for every SayOrTouch (CI).
- AC: A filesystem, DB, log and crash-dump scan after 100 voice sessions finds no audio signatures.
- AC: The mic track exists only between `prompt_window_open` and `prompt_window_close` events (integration test).
- AC: The production event schema has no `asr_alternatives` field.

#### VOX-05 · Noise-robust audio front end — P1 · M2 · deps: KSK-08 · src: KIOS-12
AEC, noise suppression, and a per-session noise floor (`env.noise_dbfs`), measured inside the first consented prompt window only. Above the threshold the session switches to touch only. A headset reroutes output.
- AC: With recorded 75 dBA market noise, false accepts ≤ 3% and zero self-triggers.
- AC: `asr_enabled` is logged per session.

#### VOX-06 · ASR evaluation harness, bake-off and fairness policy — P1 · M1 · deps: VOX-07, CRT-08 · src: KIOS-27
Collects closed-vocabulary samples only, under separate supervised consent, encrypted, with a deletion timer (PRV-05). Compares candidate engines. Policy: a prompt is voice-enabled only if accuracy ≥ 90% at 10 dB SNR **and** the age and gender gap ≤ 5 pp, with ≥ 30 held-out speakers per language. Otherwise the prompt is touch only.
- AC: A per-language report gives accuracy by age, gender and SNR with confidence intervals.
- AC: The policy is written into the ASR config of the language pack.
- AC: If no engine passes, the pilot runs touch only with no code change.

#### VOX-07 · Localisation and ITC adaptation workflow (git + YAML + spreadsheet) — P0 · M0 · deps: VOX-02 · src: KIOS-26, GOV-16
Content units: lines, consent scripts, report phrases, pictograms, cultural props, criterion item audio and ODK form labels. ITC states live in YAML: draft → forward_translated → back_translated → expert_reviewed → recorded → audio_qc → think_aloud_tested → approved (or flagged_for_revision). `tools/translation` exports and imports review spreadsheets. CI validates state transitions, roles and recording sheets (tone, target duration ±15%).
- AC: Production packs contain only `approved` content. Pilot packs may include `think_aloud_tested` and are marked as such.
- AC: The ITC trail exports per language.
- AC: Regional pictogram variants keep the same key.

#### VOX-08 · Cultural variants as forms — P1 · M3 · deps: ENG-04, VOX-07 · src: GAME-32
Overlays for foods, currency imagery, attire, gestures and rule-switch metaphors. The schema **forbids changes to scored parameters**. **Every `variant_pack_id` is a form.** In the pilot, **one variant per language** is allowed. Later, several variants within a language are pooled only after DIF and invariance checks across variants (VAL-08/09).
- AC: An overlay touching scored parameters fails validation.
- AC: The pilot policy rejects a second variant for an enabled language.

#### VOX-09 · Scale-out to 22 scheduled languages — P2 · PG · deps: ONB-01, VOX-07, VOX-06 · src: KIOS-30
Paged language-face grid. Touch-only languages are allowed and flagged. Noto fonts for admin text.
- AC: In CI, a 4th test language is added with zero code changes.

### 5.4 ONB: Onboarding and consent UX

#### ONB-01 · Language selection by speaking faces — P0 · M1 · deps: KSK-05, VOX-01, VOX-07 · src: KIOS-06, GAME-13
Native-speaker faces in randomised order (logged). A tap plays a confirmation with tick and cross. A globe icon allows switching before consent. A switch after consent is logged.
- AC: Selection takes ≤ 2 taps, with median under 15 s (*study*).
- AC: Events carry the BCP-47 code, pack version and manifest hash.

#### ONB-02 · Spoken consent with mandatory tap (adults only) — P0 · M1 · deps: KSK-02, VOX-01, PRV-02 · src: KIOS-07, GOV-02, GAME-13
Pre-recorded consent in 3–4 pictogram segments: what we play, what we keep, no audio kept, stop anytime, erasure, report use, snapshot not diagnosis. A QR on the bezel gives the fiduciary and grievance contact. **Only a tap commits consent.** The ASR is not even open at this point. Each segment can be replayed. Declining keeps only an anonymous counter. **There is no guardian branch.** The archive opt-in is a separate tick here (default no).
- AC: Play is unreachable without `consent.granted{tap_confirmed:true}`, checked on the client and at ingest.
- AC: The decline path stores no session row.
- AC: `consent_version_hash` resolves to the exact audio played.

#### ONB-03 · Post-report contact opt-in and retest token — P1 · M3 · deps: ONB-02, KSK-12, PRV-04 · src: KIOS-08, GOV-02
Runs **after the report or thank-you**, so it does not eat into the play budget. One yes/no for later contact (default no). On yes, the number is entered on the PictureDigitPad. **Confirmation uses picture-digit tiles on screen, or audio through a headset only. It is never spoken on the speakers.** The number goes to the vault. A pseudonymous retest token is printed or shown as a QR.
- AC: A timeout or skip counts as "no".
- AC: Contact data never appears in event tables.
- AC: Scanning the token later sets `linked_prior_session_token`.
- AC: With no headset, the speaker output receives zero digit clips (test).

#### ONB-04 · Bands by picture: age, literacy, education, gender, device use, played before — P0 · M1 · deps: KSK-05, VOX-01 · src: KIOS-13, GAME-13
- Life-stage figures with spoken age ranges. **An under-18 selection ends the session politely and nothing is kept.**
- **Literacy question:** "Can you read a letter or a newspaper?" with pictorial options: easily / with difficulty / not at all.
- Schooling-stage pictures.
- Optional gender.
- Smartphone use: never / sometimes / daily.
- "Played this before?"

Every question has "prefer not to say". Band enums are versioned and shared with norming.
- AC: Zero persisted data after an under-18 selection.
- AC: Answers are logged with latency and changes.
- AC: The `literacy_band` field exists in SessionContext and the quota engine.

#### ONB-05 · Practice integrated with warm-up — P0 · M1 · deps: KSK-05, VOX-01, ENG-10 · src: KIOS-14, GAME-13
Tap, hold and choice practice is merged into the ≤ 60 s warm-up (ENG-10). Each skill needs two passes, capped at 4 attempts. Hitting the cap sets `practice_struggle` and the session runs at L1 (flagged). `practice.summary` records motor covariates. **Warm-up is not scorable.**
- AC: Practice and warm-up events carry `scorable=false` and never reach indicators.

#### ONB-06 · In-session stop and withdrawal — P0 · M1 · deps: ONB-02, PRV-06a · src: GOV-03
A persistent "hand" icon offers "keep" or "delete". Delete purges local rows and shreds the session DEK, then queues a **tombstone keyed by `session_id`** that covers events already uploaded and events not yet uploaded.
- AC: Local purge completes within 1 s.
- AC: The server confirms deletion of all of the session's events at the next sync, including those uploaded earlier.

#### ONB-07 · Would-play-again and experience micro-survey — P0 · M1 · deps: KSK-05, ENG-07 · src: KIOS-23
Enjoyment on 3 faces, and play-again as tick or cross. In pilot mode, a confusion map links hard episodes to audio keys. Skippable, with a 10 s timeout.
- AC: Aggregates by language, literacy, age and education can be computed.
- AC: Confusion hits link to audio keys.

#### ONB-08 · Session time budget enforcement and timeline simulation — P0 · M1 · deps: KSK-02, ENG-10, QA-02 · src: review
Encodes the §4.4 budgets as config. A CI simulation runs both pathways with **slow bots at L1** (90th-percentile latency, maximum replays, contact opt-in yes).
- AC: The total including report, survey and opt-in is ≤ 900 s in 100% of 1,000 slow-bot sessions.
- AC: Onboarding (to the end of bands) ≤ 90 s and warm-up ≤ 60 s at the median bot.
- AC: Scorable play is 540–630 s at the median bot.

### 5.5 ENG: Game engine

#### ENG-01 · High-resolution timing service — P0 · M0 · deps: PLT-01 · src: GAME-02, KIOS-15, DATA-03
Records `requested_onset`, `presented_onset` (rAF after commit, **plus the per-SKU display offset**), `audio_onset` and `prompt_audio_end` (**plus the per-SKU audio offset**). Responses use `PointerEvent.timeStamp` **minus the per-SKU touch offset**. Latency is computed from a named anchor (`visual_onset|audio_end|go_signal`); spoken prompts default to `audio_end`. **Latency is signed.** A response before the anchor gives a negative value with `barge_in=true`. `null` is used **only for timeouts**. Stimulus durations are stored in milliseconds.
- AC (*rig*): after subtracting the constant per-SKU offset, presented-vs-photodiode **jitter SD ≤ 1 frame** over 1,000 trials.
- AC: Timeouts give `latency_ms=null`. Early responses give a signed value with `barge_in=true`.
- AC: `seq` strictly increases and `t_mono_ms` never decreases.

#### ENG-02 · Timing calibration rig and SKU certification — P1 · M2 · deps: ENG-01, KSK-08 · src: GOV-23
`tools/timing-calibration` drives a photodiode, a solenoid tapper and an audio loopback, and produces the per-SKU constant offsets and jitter (`timing_profile_version`). The touch threshold is set from measured data.
- AC (*rig*): visual jitter SD ≤ 1 frame; **touch latency SD ≤ 15 ms** (solenoid); audio output jitter SD ≤ 10 ms after offset correction.
- AC: Any SKU, OS or firmware change creates a new `timing_profile_version` and blocks data collection until it is certified.
- AC: The emulator regression detects an injected 50 ms delay.

#### ENG-03 · Deterministic seeded RNG with named substreams — P0 · M0 · deps: PLT-01 · src: GAME-03
PCG32 substreams. The session seed comes from `crypto.getRandomValues` and is logged. `pnpm replay <seed> <bundleHash>` replays a session.
- AC: The same seed and bundle give an identical schedule over 10k seeds.
- AC: Substreams are independent.

#### ENG-04 · Content-as-config bundles with scientific build checks — P0 · M0 · deps: PLT-02 · src: GAME-04
YAML for games, schedules, variants, cues, calibration tables and indicator declarations. `pnpm content:build` checks:
- references resolve (audio for every enabled language)
- each indicator's `min_valid_trials` is met at **every level** (no upper cap)
- **every module and every scorable 60 s slice of each pathway schedule declares indicators covering ≥ 2 constructs**
- module duration is 60–120 s at each level (B)
- no decision requires reading digits (`requires_numeracy:false` on every decision node)
- signed allowlist

- AC: Each failure is reported by path, and a planted slice with a single construct fails.
- AC: A new balloon variant can be added through YAML alone.
- AC: The kiosk refuses a bundle that is not on the allowlist.

#### ENG-05 · Game module contract — P0 · M0 · deps: ENG-01, ENG-03, ENG-04 · src: GAME-05, KIOS-15
`GameModule` has a manifest (id, paradigms, `emittedIndicators[]`, duration budget), `createMachine(config, rng, ctx)` and a renderer binding. Lifecycle: intro → trials → contextShift? → outro. A soft cap triggers a graceful wrap-up and a hard cap ends the module with `ended_reason:'time_cap'`. `GameTrialSpec` covers trial_id, condition, response window, vocabulary, audio keys, `private_report`, `anchor_trial` and `form_id`.
- AC: Any module runs headlessly with a scripted bot.
- AC: Paradigm logic packages are shared between B and A (manifest diff).
- AC: Every B module lasts 60–120 s at L1, L2 and L3 under median and slow bots.

#### ENG-06 · Unified input layer (touch primary) — P0 · M1 · deps: ENG-05 · src: GAME-11, KIOS-15
Tap, hold, drag and choice. Extra and premature taps are recorded, never debounced. Multi-touch with ≥ 2 points is logged as interference (except in co-play zones). Palm and ghost touches are filtered. A voice adapter plugs in from VOX-04 (P1).
- AC: A premature tap is logged with its phase and offset.
- AC (*rig*): touch timestamp SD ≤ 15 ms, consistent with ENG-02.

#### ENG-07 · Logger SDK — P0 · M0 · deps: PLT-02, ENG-01, KSK-07 · src: DATA-06, GAME-06, KIOS-18
Typed helpers fill the envelope (§6). **Every event is validated with Ajv before it is written.** An invalid event is replaced by a placeholder row (`event_type=invalid`, reason code, no payload) **using the same `seq`**, so `seq` stays gapless. A privacy guard strips non-schema fields, and no API accepts audio. Logging failures never crash gameplay. Emits `session.context`.
- AC: `seq` is gapless per session, including with invalid events.
- AC: A crash leads to `session.abandoned{crash_recovery}` with the consented events kept (no resume path exists).
- AC: The SDK is under 25 kB gzipped, and a lint bans hand-built events.
- AC: An NDJSON export replays screens and audio keys in order.

#### ENG-08 · Indicator declarations bound to the frozen dictionary — P0 · M1 · deps: ENG-04, ENG-07, SCR-01 · src: GAME-07
Each module declares indicator id, construct, minimum samples, direction and convergent scale. The build checks these against the pinned pathway dictionary. A preview scorer exists for QA and for the REP-01 release-pack band computation. It is never shown to players in its raw form.
- AC: An undeclared indicator, or one with too few samples, fails the build.
- AC: The preview scorer matches Python on golden fixtures (counts exact, continuous values within 1e-8).

#### ENG-09 · Constraint-based trial scheduler — P0 · M1 · deps: ENG-03, ENG-04 · src: GAME-08
Blocks, condition counts, max-consecutive no-go, a switch-position window, probe groups (`probe_group_id`), one context shift per episode, **anchor trials shared across levels**, and **forms** (`form_id`, for parallel forms and planned-missingness slots). Seeded rejection or repair.
- AC: All 10k seeds satisfy the constraints.
- AC: Every indicator meets its minimum at every level.
- AC: The shift index is logged and falls within its window.
- AC: Anchor trials are byte-identical across levels.

#### ENG-10 · Warm-up calibration and level policy — P0 · M1 · deps: ENG-05, ENG-09 · src: GAME-09, KIOS-14
A ≤ 60 s warm-up, merged with practice, measures RT, accuracy and hold control. `calibration_policy` options: `fixed_L2_with_L1_fallback` (pilot default), `classifier` (field) and `forced` (counterbalanced subsample). The level is locked for the session, logged, and **locked to the T1 level at retest**.
- AC: Exactly one level per session.
- AC: With the pilot policy, only `practice_struggle` or an a11y choice gives L1.
- AC: A retest session uses the T1 level (linked by token or pid).
- AC: No hard-coded timers; every load parameter comes from the level table.

#### ENG-11 · No visible score; numerals never required — P0 · M1 · deps: ENG-05 · src: GAME-10
A renderer guard rejects numeric text in player scenes except allowlisted **decorative** numerals (dice pips, scale markings). Quantities that matter are shown as **balance needles, pan positions, piles or pictured tokens**, with spoken quantities from pre-recorded clips. Progress shows only as a position on the journey map.
- AC: In dev, the guard throws on a non-allowlisted digit.
- AC: With numerals hidden, a bot that uses only needle position and audio reaches the same decision accuracy as a bot that reads numerals (content test).
- AC (*study*): the think-aloud exit check finds no decision that needs reading digits (§7.3).

#### ENG-12 · Adaptive selector (Pathway B) — P2 · PG · deps: ENG-08, MG-10, SCR-02 · src: GAME-23, DATA-34
A pure function `(state, priors, budget, rng) → moduleId` that maximises information on high-SE traits under coverage minimums. It is validated only in a later dedicated wave, because its missingness is non-random.
- AC: The backend replays decisions deterministically.
- AC: 1,000 simulations meet coverage minimums.

#### ENG-13 · Indicator health toggles and trial reallocation — P2 · M6 · deps: ENG-08, ENG-09, VAL-12 · src: GAME-33
Per-bundle indicator status (`indicator_set_version`) and trial reallocation from backend reliability estimates. **Applied only in the next wave.** Never within a frozen wave.
- AC: Reallocation respects every indicator minimum and the §4.4 budgets.
- AC: Pushing it into a frozen wave is blocked.

#### ENG-14 · Retest parallel forms and T2 lock — P1 · M3 · deps: ENG-09, ENG-04 · src: review
For novelty-dependent paradigms, T2 uses a **parallel form**:
- different rule dimensions and reversal timing (Card Sort, Road Home)
- a different unsolvable-item identity (Tower)
- different rude-customer scripts at equal tone levels (Stall)
- a different new-rule content (Weighing)

Forms are counterbalanced (T1 = form 1 or form 2 at random). The T2 level is locked to T1's.
- AC: Form equivalence on simulated bots (equal difficulty parameters within tolerance).
- AC: `form_id` is logged on every trial, and the retest analysis models form.

### 5.6 MG: Pathway B micro-games and carousel

All modules use ENG-05/08/09/10/11 and last 60–120 s at every level. Trial counts are L2 defaults. The final counts come from VAL-02 and the trial-budget sheet.

#### MG-01 · Balloon Pump (BART) — P0 · M1 · deps: ENG-05, ENG-09, ENG-11 · src: GAME-14
Tap to pump, collect to bank (a jar fills; no numbers). Seeded explosion points, 2 risk colours, **15–20 balloons** with fast pumping (≈ 5 s per balloon). Indicators: `risk_preference.adjusted_pumps`, `.explosion_rate`, `decisiveness.time_to_collect`, `response_consistency.pump_rvi`, `persistence_of_style.post_loss_adjustment`.
- AC: The explosion schedule matches the configured distribution exactly for each seed (count check on a fixed seed table).
- AC: Golden bot values reproduce.
- AC: Duration is within 60–120 s.

#### MG-02 · Don't-Tap (Go/No-Go) with pressure block — P0 · M1 · deps: ENG-01, ENG-05, ENG-09 · src: GAME-15
**GNG only in the MVP. SSRT is removed** (see MG-11). About 80 trials with **≥ 20 no-go** (the final minimum from VAL-02). The second half is a pressure block (timer plus noise, Meta-T style), tagged `condition='pressure'` and logged as a `context_shift`. Indicators: `self_control.nogo_commission_rate`, EZ-diffusion drift and boundary, `expressive_restraint.premature_taps` (< 150 ms or during ISI), `.extra_taps`, composure pressure slopes, `response_consistency.rt_rvi`.
- AC: The no-go count meets its minimum at every level.
- AC: The EZ-diffusion fit is recovered on simulated data (§9.2).

#### MG-03 · Card Sort with unannounced switch and reversal — P0 · M1 · deps: ENG-05, ENG-09 · src: GAME-16
Dimensions are colour (paired with pattern), shape and count. The rule switches after 6 correct, twice per session, including one reversal, with **≥ 10 post-switch trials per switch**. Indicators: perseverative errors, trials to reacquire, switch-cost slope (hierarchical), stability shift slope, EZ-diffusion parameters.
- AC: The switch is logged as `context_shift`.
- AC: Perseverative classification matches the reference implementation.
- AC: Duration is within 60–120 s.

#### MG-04 · Tower Puzzle (Tower of London) — P0 · M1 · deps: ENG-05, ENG-09, ENG-06 · src: GAME-17
Drag pots between 3 baskets. 4 solvable problems (2–5 minimum moves) and **2 unsolvable items** (a skip icon appears after 15 s), with order fixed per form. Indicators: excess moves, planning time, recovery after failure, `initiative.planning_before_acting`, `persistence.time_on_unsolvable`, `.give_up`, `task_organisation.illegal_move_attempts`.
- AC: A build-time solver verifies the minimum moves and proves unsolvability.
- AC: Move events carry from, to and a legal flag.
- AC: Duration is within 60–120 s.

#### MG-05 · Share-the-Pot (public goods) — P0 · M1 · deps: ENG-05, ENG-09, ENG-06 · src: GAME-18
8 rounds with pictured tokens. Scripted seeded partners (cooperative, free-rider, error round). After an unfair loss round, an exploratory tone choice (`emotional_regulation.tone_after_unfair_loss_B`). Indicators: mean contribution, response to defection and to error, `initiative.unprompted_share`.
- AC: Partner policies are deterministic and logged per round.
- AC: The error round falls inside its window.

#### MG-06 · Private Dice (group level only) — P1 · M3 · deps: ENG-05, ENG-11, KSK-12 · src: GAME-19
Planned-missingness slot module. A cupped-hand reveal, then a picture report; 10 reports. **Mode (a): the true outcome is never logged.** Outputs feed **only** the group-level integrity estimates (over-report rate, distribution skew, and over-report by HEXACO-HH tertile).
- AC: Memory and log tests confirm the true outcome is never stored.
- AC: The dictionary marks every dice indicator `group_only`, and the individual scorers reject them.

#### MG-07 · Wait-or-Now (delay and effort discounting) — P1 · M3 · deps: ENG-05, ENG-06 · src: GAME-20
Slot module. Delay shown as sun and moon cycles, effort as hold-to-earn. A short seeded titration of 12 choices. Indicators: log k (hierarchical Bayesian fit with population priors), effort discount, choice consistency, effort completion.
- AC: k is recovered with r ≥ √rel − .05 against the simulated latent.
- AC: Duration is within 60–120 s.

#### MG-08 · Steady Hands (free vs held responding) — P1 · M3 · deps: ENG-01, ENG-05 · src: GAME-21
Slot module. Counterbalanced free and held blocks with distractors, about 80 s. Indicators: held-vs-free slope, extra taps when held, distractor slope (composure).
- AC: Distractor onset jitter is ≤ 1 frame after offset correction.

#### MG-09 · Four Stalls (IGT-lite) — P1 · M3 · deps: ENG-05, ENG-09 · src: brief
Slot module. Four vendor stalls with seeded pictorial payoffs and repeated identical situations. Indicators: choice entropy on repeats, disadvantageous-choice rate, win-stay/lose-shift.
- AC: ≥ 10 repeated-probe samples.
- AC: Schedules are reproducible from the seed.

#### MG-10 · Carousel hub: fixed order, planned-missingness slot — P0 · M1 · deps: ONB-05, ENG-10, MG-01, MG-02, MG-03, MG-04, MG-05 · src: GAME-22
A guide-hosted hub. **One fixed order** for all scored sessions: Don't-Tap → Card Sort → Balloon → Tower → Share-the-Pot → slot. **There is no Latin square** (an order-effects substudy is optional and post-grant). Slot assignment is seeded, randomised and logged (`slot_form`). Audio bridges are ≤ 5 s. Cross-module probe trials support the style traits (≥ 4 comparable segments).
- AC: The carousel has 6 modules per session and the session fits the §4.4 budget (ONB-08).
- AC: Slot allocation counts are exactly balanced within each block of 4 sessions per kiosk (block randomisation).
- AC: Module order is identical across scored sessions.

#### MG-11 · Stop-signal dedicated block (substudy) — P2 · PG · deps: MG-02, ENG-02 · src: GAME-15, review
An optional supervised substudy block with **≥ 50 stop trials** (Verbruggen et al., 2019 consensus), a frame-unit SSD staircase and SSRT by the integration method with go-omission replacement. Outside the 15-minute budget.
- AC: The staircase converges to about 50% stop success in simulation.
- AC: SSRT is computed only with valid assumptions (P(respond|signal) between .25 and .75, go omission < 25%).

### 5.7 EPI: Pathway A episodes, arms, co-play and Pathway C

#### EPI-01 · Episode 1: The Stall (Table for One) — P1 · M3 · deps: MG-02, VOX-03, ENG-09 · src: GAME-24
The player serves a customer queue: GNG with MG-02 logic, where spoiled or out-of-turn items are no-go. **Customer tone is a stimulus property**: pre-recorded voice variants and animated face assets at manifest-defined tone levels (calm → hostile). It is **not sensing of the player**. The player chooses a tone by tapping smile, neutral or firm faces. A timed rush adds timer and crowd noise. **Context shift:** a run of rude customers.

Indicators: commission rate, `tone_after_provocation`, **`mirroring`** (agreement between the chosen tone and the customer tone level, modelled as a person-level slope of chosen tone on customer tone), drift slope over the difficult run, composure slopes, premature serves, stability slope.
- AC: Runs 3.3 ± 0.3 min.
- AC: GNG ≥ 30 with ≥ 8 no-go, provocations ≥ 8, tone choices ≥ 12 across ≥ 3 customer tone levels.
- AC: Exactly one shift.
- AC: No forked scoring code.

#### EPI-02 · Episode 2: The Weighing Post (Weighmaster) — P1 · M3 · deps: MG-06, VOX-03, ENG-09, ENG-11 · src: GAME-25
The player weighs goods shown on a **balance needle and pans, with spoken quantities** (no numerals needed). Decisions: approve, warn or fine, with "inspect more". Dilemmas (**≥ 3 per type**): bribe, overpayment return, assistant's mistake (own or shift blame), fraud found (share or take credit). There is a gamble inspection. Luck tokens reuse the private-report logic (group level only). **Context shift:** a new market rule announced by voice.
- AC: ≥ 12 weighing decisions, with reversals and inspection logged.
- AC: ≥ 6 trials after the shift.
- AC: Integrity outputs are `restricted`, and token outputs are `group_only`.
- AC: `requires_numeracy:false` on every decision.

#### EPI-03 · Episode 3: The Road Home (MindShift) — P1 · M3 · deps: MG-03, MG-04, MG-05, ENG-09 · src: GAME-26
Route planning on a pictured map with limited fuel (shown as a fuel gauge) and errands. A road blocks mid-route. There is an **unannounced rule reversal**. A partner shares the fuel pot and makes a scripted error. Optional actions count towards initiative.
- AC: A solver confirms every map is solvable at each level.
- AC: No audio cue refers to the reversal.
- AC: Idle gaps over 3 s and revisits are logged.
- AC: Every indicator meets its minimum.

#### EPI-04 · Pathway A orchestrator and cross-episode probes — P1 · M3 · deps: EPI-01, EPI-02, EPI-03, ONB-05, ONB-08 · src: GAME-27
Timeline in minutes: 0–1.5 onboarding, 1.5–2.5 warm-up, 2.5–5.8 Stall, 5.8–9.1 Weighing, 9.1–12.4 Road, 12.4–14 report and survey, 14–14.5 opt-in. The guide and visual items carry over (never as a score). Identical probes run in all episodes, and each episode has ≥ 2 comparable probe segments (≥ 4 segments in total for the style traits). Optional beats are trimmed while every minimum is protected.
- AC: A scripted session reaches the report at 12.4 ± 0.5 min.
- AC: Trimming never drops an indicator below its minimum (slow bots).
- AC: `probe_group_id` is present in all episodes.

#### EPI-05 · Pilot arm assignment (2 arms) — P1 · M3 · deps: MG-10, EPI-04, CRT-07 · src: GAME-28, PSYC-09
Pilot arms are **`B_fixed` and `A_narrative`** only, randomised 1:1 by blocks within quota cells (language × age × gender × education × literacy). The server list has a seeded offline fallback. **Every randomised participant in the criterion cohort completes the criterion battery.** Arm, source and stratum are logged. Shared paradigm indicator IDs are identical across arms, which lets the analysis **pool shared-paradigm indicators across arms** if VAL-02 shows the per-arm n is short. `B_adaptive`, `A_D` and `C` are reserved enum values for later waves.
- AC: The arm is assigned before onboarding ends.
- AC: Within-cell balance stays within ±1 per block.
- AC: The manifest diff confirms shared IDs.

#### EPI-06 · Pathway D co-play: scripted partners and live-dyad substudy — P1 · M3 · deps: MG-05, EPI-03, ONB-02, KSK-13 · src: GAME-29, KIOS-29
**Placement:** an optional **4th episode after Road Home**, at supervised sites only. Sessions are extended to ≤ 20 min under the substudy consent.

**Scripted library:** cooperative, conditional cooperator, free-rider, error-prone.

**Live dyads** (Stage 2 substudy, target ≥ 120 dyads pooled across languages, drawn from the A arm):
- split-screen, `player_slot` on events
- separate consent per player, linked by `coplay_group_id`

**Indicators:**
- turn-taking: `turn_waiting` (waits for the partner's turn), `interruptions` (acting in the partner's turn window)
- a co-play **credit/blame round**: after a joint success or failure, each player privately allocates credit or blame
- contribution dynamics

Afterwards comes a private pictorial **partner rating**, with each player rating while the other looks away. This is the teamwork criterion (CRT-09).
- AC: Cross-zone touches are attributed correctly.
- AC: Ratings carry `rater_role` and both pids. Self-rating is impossible.
- AC: The episode is unavailable when `site_mode=open_public`.

#### EPI-07 · Pathway C voiced SJT carousel (alternative) — P2 · PG · deps: ENG-05, VOX-07, MG-02, MG-03 · src: concept note, GOV-16
The existing 30-scenario SJT pool, voiced by native speakers with pictorial options. It adds **timed choices** (response windows per scenario) and **carry-over consequence state** (earlier choices change later scenario context), plus **2 embedded micro-games** for executive traits (Don't-Tap and Card Sort modules, reused unchanged). It shares onboarding, the voice layer, the logging contract and the report. **Faking risk** is documented: SJT choices are more transparent than behavioural paradigms, so social-desirability checks and the dissimulation flag are added to SCR-12.
- AC: Scenarios run through the module contract and emit declared indicators.
- AC: The carry-over state is logged and replayable.

### 5.8 ING: Logging contract, ingestion and data management

#### ING-01 · Event envelope and event-type catalogue — P0 · M0 · deps: PLT-02 · src: DATA-02, KIOS-18, GAME-06
See §6. Responses are closed codes. Stimulus attributes are joined by ID. Practice and warm-up events are tagged `scorable=false`. **This contract is the boundary defined by the note.**
- AC: Every dictionary indicator's required fields exist in the schema.
- AC: Fixtures for all modules and episodes validate.
- AC: Docs are generated from the schemas.

#### ING-02 · Ingestion API — P0 · M0 · deps: PLT-02, PLT-05, PRV-07 · src: DATA-08
`POST /v1/batches` over mTLS. Steps:
1. Verify sha256.
2. **Write raw to S3 with key `raw/{kiosk}/{batch_id}` using `If-None-Match:*`**, so a retry writes nothing new.
3. Unwrap the session DEKs (ING-08).
4. Validate with Pydantic.
5. **Insert into the unpartitioned `kiosk_raw.event_dedup(event_id PK, server_received_at)` with `ON CONFLICT DO NOTHING`.** Only new events go on to `kiosk_raw.events`, which is **partitioned by `server_received_date`**.
6. **Consent parking:** scorable events with no core consent yet are held in `kiosk_raw.consent_parking` until consent arrives. After 72 h with no consent they go to the DLQ as `no_consent` and are purged.
7. Send invalid events to the DLQ.

Returns a per-event status: `accepted|duplicate|parked|rejected_terminal|retryable`. Records `server_received_at` and **estimates the kiosk clock offset per batch** (`kiosk_t_wall` vs server time). Kiosk wall time is never used for ordering or partitioning.

**Schema versions:** the server **never refuses a build that belongs to an active frozen wave**. Upcasters stay deployed until that wave is archived. A 426 is returned only for builds outside any active wave, and those events stay on the kiosk with an operations alert.
- AC: Schemathesis contract tests pass.
- AC: 20 parallel clients and replayed batches produce zero duplicates, including when a kiosk clock is set to 1970 or drifts by +3 days.
- AC: p95 < 300 ms for a 500-event batch with 50 kiosks.
- AC: Events split across batches with consent arriving second are accepted after unparking.
- AC: A build from an active wave is never given a 426.

#### ING-03 · Upcasters and wave-safe schema support — P0 · M0 · deps: ING-02 · src: DATA-04
Majors N and N−1 are accepted, plus every major used by an active wave. Older versions are stored raw and flagged `needs_upcast`.
- AC: v1 fixtures upcast to v2 give identical indicator values.

#### ING-04 · Dead-letter queue, triage and replay — P0 · M0 · deps: ING-02 · src: DATA-09
Each dead letter records reason code, schema path, encrypted payload, kiosk and build. Grouping CLI and replay. DLQ entries follow the retention and erasure rules.
- AC: Replay keeps the original `event_id` and `seq`.
- AC: An alert fires when a build's DLQ rate exceeds 0.5%.

#### ING-05 · Session reconstruction and integrity checks — P0 · M0 · deps: ING-02, PLT-03 · src: DATA-11
A Dagster asset builds `trials_canonical`, ordered by `(session_id, seq)`. It checks seq gaps (placeholders count as present), duplicates, missing `trial_end`, orphans and completion. Labels: `complete|partial|abandoned`, with a scorability flag per module or episode.
- AC: Injected gaps and out-of-order uploads are reconstructed and flagged.
- AC: Practice and warm-up trials never appear in the main phase.

#### ING-06 · Analysis snapshot builder — P1 · M2 · deps: ING-05, SCR-02, CRT-04, PRV-02, PRV-06a · src: PSYC-13
Joins indicators, trials, criterion scores, links and context. Applies the quality, consent and erasure exclusions and writes de-identified Parquet with a manifest. **When an erasure lands, rebuilding affected snapshots is an explicit pipeline step** (PRV-06).
- AC: The same DB state gives the same statistics within 1e-8 (no byte-equality requirement), with fixed BLAS and thread counts.
- AC: The exclusion report is broken down by reason, language and literacy.
- AC: Erased pids are absent, and stale snapshots are tombstoned.

#### ING-07 · Session replay and timeline viewer — P0 · M1 · deps: ING-05, SCR-02 · src: DATA-26
A role-protected, single-session timeline showing stimuli, prompt spans, responses, input mode, shifts, flags, indicators and think-aloud notes. Built with server-rendered pages in the API app (no SPA).
- AC: Every event is shown in order, and indicators link to their trials.
- AC: Every view is audited.

#### ING-08 · Raw store with per-session encryption — P0 · M0 · deps: ING-02, PRV-07 · src: review, GOV-07
Raw batches are lists of **per-session encrypted chunks**. The backend unwraps each session DEK with its private key (held in KMS) and stores it **re-wrapped under KMS** in `consent.session_keys`. That table's backups have a retention period ≤ the erasure SLA (§5.13 PRV-06). S3 raw has versioning and MFA delete but **no compliance-mode Object Lock**. Erasing a session deletes its wrapped DEK (crypto-shredding), which makes every raw copy, including old S3 versions, unreadable.
- AC: After DEK deletion, decrypting any raw object version for that session fails.
- AC: A retried upload does not create a second raw object.

### 5.9 SCR: Scoring dictionary and indicator engine

#### SCR-01 · Dictionary schema, per-pathway freezes and v0 before Stage 1 — P0 · M0 · deps: PLT-02, PLT-09 · src: DATA-12
The dictionary has `shared.yaml` (competency model, 17 constructs) plus `dictionary.B.yaml` and `dictionary.A.yaml`. Fields per indicator: id, construct, direction, formula ref, unit, `min_valid_trials`, exclusions, aggregation, **`reliability_method`** (§7.6), **`kind ∈ {raw, difference_slope, model_parameter, group_only, single_event_unscorable}`**, **`level_rule`** (SCR-11), expected r (lower bound), status `provisional|validated|dropped|research_only`, sensitivity and tier.

**Freeze sequence:**
- **v0** is frozen and hashed **before Stage 1** (PLT-09 record).
- **v1-B** is frozen at Stage 1 exit, **v1-A** at Stage 1b exit, both through the documented amendment path.
- The pre-registration is filed after both v1 freezes and before Stage 2.
- **v2** is frozen **only after Stage 3** (VAL-12). Between Stage 2 and v2, only scoring-only amendments are allowed. Task and trial changes go to the next wave.

`bg-score freeze --pathway B --stage v1`. Scoring without a frozen hash runs as `--exploratory` with labelled outputs.
- AC: Every formula ref resolves to a tested function.
- AC: Freezing without a governance record fails.
- AC: An HTML dictionary is generated.

#### SCR-02 · Indicator registry and computation framework — P0 · M0 · deps: SCR-01, ING-05 · src: DATA-14
Pure polars functions `(trials, ctx) → IndicatorResult(value, n_valid, se, flags)`. Hierarchical and model-based indicators (random slopes, EZ-diffusion, log k) are computed in a **batch model step** per wave partition (Python with R through Pipes), with person estimates and posterior SDs written back. Minimums are enforced (null plus `insufficient_trials`).
- AC: Each indicator is unit-tested against hand-computed fixtures.
- AC: Output is invariant to row order.
- AC: 10k sessions score in under 5 min on a laptop (excluding the hierarchical model step, which is benchmarked separately).

#### SCR-03 · Dictionary v0 content and trial-time budget sheet — P0 · M0 · deps: SCR-01, VAL-02 · src: DATA-13, review
Populate v0 from §4. Build `cicd/trial-budget`: measured seconds per trial (from prototypes or the literature) × required trials per indicator from VAL-02, summed per module and per pathway against §4.4. Where the budget cannot be met, the indicator is demoted (Tier 2, `research_only`) or the trait is withheld for that pathway. **The count is fixed at 17 constructs** across the dictionary, hypotheses and simulator.
- AC: Each construct has ≥ 2 indicators in at least one pathway, or is withheld for that pathway with a reason.
- AC: Summed minimum durations fit §4.4 for both pathways.
- AC: The construct count is 17 in all three files (CI check).

#### SCR-04 · Executive indicators: inhibition, discounting, risk, diffusion — P0 · M1 · deps: SCR-02 · src: DATA-15
- GNG: commission, omission, go-RT.
- **EZ-diffusion** (drift, boundary, non-decision time) for GNG and choice tasks, plus a balanced integration score as a robustness check.
- BART adjusted pumps and explosion rate.
- Hierarchical log k.
- Effort slope.
- AC: Recovery on simulated data: r(est, latent) ≥ √rel − .05 at the minimum trial count.
- AC: BART matches the published example.

#### SCR-05 · Planning and problem-solving indicators — P0 · M1 · deps: SCR-02 · src: DATA-16
- ToL: excess moves, planning time, first-attempt solve, recovery.
- Errands: edit distance to the solver optimum, revisits, idle proportion, efficiency.
- Replan latency.
- AC: Optimal bots score 0 excess moves.
- AC: Scoring fails fast if the solver output is missing.

#### SCR-06 · Flexibility indicators (hierarchical) — P0 · M1 · deps: SCR-02 · src: DATA-17
Perseverative and non-perseverative errors, trials to criterion, and **switch cost as a person random slope** (RT ~ post-switch + trial-in-run + (1 + post-switch | person)). The switch point comes **only from the `context_shift` event**. The raw difference-score reliability is reported too, computed from its components: (r_xx + r_yy − 2r_xy)/(2 − 2r_xy).
- AC: Rigid and flexible bots separate with d > 2.
- AC: Null with fewer than 10 post-switch trials.
- AC: A missing shift event is an error.

#### SCR-07 · Decisiveness, persistence and initiative indicators — P0 · M1 · deps: SCR-02 · src: DATA-18
Time to commit, reversals (`revisions[]`), inspections, retries, time on unsolvable items, give-up, unprompted optional actions. Actions within 2 s after a prompt that mentions them are excluded.
- AC: `revisions[]` is present on every confirmable choice.
- AC: Give-up is counted only on items flagged unsolvable.

#### SCR-08 · Social and moral indicators — P1 · M3 · deps: SCR-02 · src: DATA-19
- Contribution, conditional cooperation slope, sharing.
- **Turn-waiting, interruptions and co-play credit share** (D).
- Credit and blame proportions and cross-dilemma consistency (≥ 3 per type).
- Bribe acceptance and overpayment return (≥ 3 each).
- **Dice: group estimators only** (no individual likelihood score is produced).
- All marked `sensitivity=high`.
- AC: The group estimator is ≈ 0 (TOST within ±.03) for an honest simulated population.
- AC: Dice outputs cannot be joined to individual MTMM tables (schema-level separation).

#### SCR-09 · Emotional regulation, composure and restraint indicators — P0 · M1 · deps: SCR-02 · src: DATA-20
- Tone as an ordinal code.
- **Mirroring** as a person slope of chosen tone on customer tone level.
- Drift as a person random slope over the difficult run.
- **Composure as person random slopes** for accuracy and RT, pressure on vs off.
- Restraint: premature and extra taps, held-vs-free slope.
- Model-based reliability is reported for every slope.
- AC: Mirroring is recovered on simulated data (§9.2).
- AC: Each slope's model-based reliability and posterior SD are written.

#### SCR-10 · Style-trait engine (mean-adjusted variability) — P1 · M3 · deps: SCR-04, SCR-05, SCR-06, SCR-07, SCR-09 · src: DATA-21
- **Consistency:** relative variability index (RVI, Mestdagh et al., 2018) and **location-scale mixed models** (person-level residual SD). Raw CV and ISD are not used as primary indicators.
- **Persistence of style:** a per-segment style vector (speed, caution from diffusion boundary, revision rate, risk) and cross-segment r, computed only with **≥ 4 comparable segments**.
- **Stability:** shift slopes across A1, A2, A3 and B switch and pressure blocks.
- All detrended on trial index.
- Pre-registered **nomological predictions** (e.g. RT location-scale σ correlates negatively with BFI-2 Conscientiousness).
- AC: Stable and volatile bots separate with d > 1.5.
- AC: Null with fewer than 4 segments.
- AC: RVI is uncorrelated with mean RT in simulation (|r| < .1).
- AC: Pure linear fatigue does not inflate variability.

#### SCR-11 · Calibration-level handling rules (mandatory) — P0 · M1 · deps: SCR-02 · src: DATA-22
Each indicator **must** declare `level_rule ∈ {fixed_level_only, anchor_linked, level_covariate}` **before the v1 freeze**. The pilot default is `fixed_level_only` (L2). L1 sessions are analysed separately. `anchor_linked` uses common anchor trials (IRT linking) for field use.
- AC: Mixing levels without a declared rule is a build and pipeline error.
- AC: `analysis_wide` carries `calibration_level`.

#### SCR-12 · Data-quality flag engine — P0 · M1 · deps: ING-05 · src: DATA-23, GOV-26
Flags:
- careless: RT < 150 ms runs, same position ≥ 90%, zero variance
- walkaway
- ASR low confidence
- device: frame drops, underruns, uncertified timing profile
- possible assistance or onlooker (heuristic, never punitive)
- repeat play
- dissimulation (Pathway C)

Grades: `usable|caution|exclude`, plus `valid_for_validation` and `valid_for_report`.
- AC: Every flag is unit-tested with trigger and non-trigger cases.
- AC: Differential exclusion by **language, literacy, education, age, gender and device familiarity** above a threshold raises a fairness warning.
- AC: Flagged sessions get only a thank-you.

#### SCR-13 · Reproducible scoring runs with lineage — P0 · M1 · deps: SCR-02, PLT-05 · src: DATA-24
`ScoringRunManifest`: dictionary sha per pathway, git sha, image digest, lock hashes, partition hashes, seeds, BLAS and thread settings, erasure receipts. `bg-score rerun` and `bg-score diff`.
- AC: Rerun values match within 1e-8, modulo documented erasures.
- AC: Every row carries `scoring_run_id`.

### 5.10 CRT: Criterion battery, linkage and study management

#### CRT-01 · Research data model — P0 · M0 · deps: PLT-05 · src: PSYC-01
Alembic migrations for studies, cohorts, sites, participants (pid only), instruments, items, language versions, keys, responses, scale scores, links, retest schedules, analysis runs, results, decisions, norms and gates. Append-only with `supersedes_id`, and RLS by role.
- AC: Migrations upgrade and downgrade.
- AC: A PII column lint passes.
- AC: UPDATE or DELETE on response tables is rejected.
- AC: The analyst role cannot read `linkage` or `identity_vault`.

#### CRT-02 · Instrument bank and planned-missingness criterion battery — P0 · M0 · deps: CRT-01 · src: PSYC-02, review
**Core block X** (everyone, read-aloud ≈ 12–15 min):
- BFI-2-XS (15)
- BSCS (13)
- DERS-16 (16)
- Grit-S (8)
- HEXACO-HH (10)
- GDMS rational + avoidant subscales (10)
- general risk-taking item (1)
- **3 attention-check items**

**Rotating blocks** (each participant gets **one**, randomised, ≈ 4 min):
- A = ERQ (10) + Moral Identity (10)
- B = CFI (20)
- C = remaining BFI-2-S items (15) + remaining GDMS subscales (15)

**Performance:** a ToL short form (physical board, 8 problems) and a card sort (WCST-64-style, Capacitor app). The interim teamwork task is in CRT-09.

**Target total:** ≤ 35 min including a break, after the game. Each item has per-language text, audio, pictorial Likert anchors, scale mapping and reverse flag. Language versions follow the ITC states, and only approved versions can be administered.
- AC: Item counts match the published specs.
- AC: Administering an unapproved version returns 409.
- AC: Block assignment is balanced within cells.

#### CRT-03 · Licensing and permission tracker — P0 · M0 · deps: CRT-02 · src: PSYC-03
Records holder, licence, permission document, allowed use and expiry for each instrument and translation. **Licensing and adaptation start in M0** because they are on the critical path.
- AC: An instrument without granted permission cannot join a battery.
- AC: A warning shows 60 days before expiry.

#### CRT-04 · Criterion scoring keys (Python only) — P1 · M2 · deps: CRT-02, PLT-02 · src: PSYC-04, DATA-27
Versioned YAML keys define reverse scoring, mean or sum, prorating (≥ 80%), subscales, attention-check flags and planned-missingness indicators. **Scored in Python only. R reads the scale scores.** Records tagged read-aloud from a public-kiosk context are rejected.
- AC: Golden tests match published examples.
- AC: Too few items gives NA with reason `insufficient_items`.
- AC: Failed attention checks set `criterion_careless`.

#### CRT-05 · Criterion capture: ODK Central/Collect and card-sort app — P1 · M2 · deps: CRT-02, CRT-04, CRT-06 · src: PSYC-05, GOV-28
ODK forms (XLSForm) generated from the item bank per language, with audio prompts, pictorial anchors, a pid barcode scan, `administration_mode ∈ {self, read_aloud}`, administrator ID, timing and audit logs. ODK Collect runs offline on managed Android tablets. Physical ToL scoring is an ODK form. The card-sort app (Capacitor + SQLite, `navigator.storage.persist` not needed) syncs to the API with idempotency keys. An ODK → API connector imports submissions. **Blocked when `site_mode=open_public`.**
- AC: A full battery completes offline and syncs with no loss or duplication.
- AC: Mode, administrator and audio version are recorded per item.
- AC: The kiosk build contains no criterion item text (CI).

#### CRT-06 · Pseudonymous participant ID and linkage — P1 · M2 · deps: CRT-01, PRV-04 · src: PSYC-06, KIOS-19, GOV-05
The administrator generates a random pid. A QR card or 6-character Crockford base32 code with a check digit is scanned in kiosk pilot mode and in ODK. Manual linking needs two people. Keyed HMAC with a pepper held in KMS. Retest visits are linked by pid and visit number.
- AC: A one-character error is rejected.
- AC: A session links to at most one pid.
- AC (*dry run*): linkage ≥ 95% per language.

#### CRT-07 · Study, stage, cohort and quota engine — P1 · M2 · deps: CRT-01 · src: PSYC-09, GOV-27
Studies S1 (think-aloud B), S1b (think-aloud A), S2 (pilot), S3 (retest), S2-D (live dyads), S4u (unattended mode) and S5. Quota cells are language × age × gender × education × **literacy**. Block randomisation of arms and criterion blocks within cells. `prereg_id` and `protocol_version` are required from S2 onwards.
- AC: A "cell full" warning appears.
- AC: Arms are balanced within cells.
- AC: Analysis refuses an S2+ study without a prereg.

#### CRT-08 · Think-aloud mode with manual linkage — P0 · M1 · deps: KSK-02, ENG-07 · src: KIOS-28, GAME-31, PSYC-10
Kiosk: a researcher unlock gives module pick, beat jump (deterministic) and pauses, with walkaway disabled. The observer codes on a laptop or tablet form against a fixed codebook: confusion, misunderstood instruction, **reading-dependent screen**, **digit-dependent decision**, cultural mismatch, strategy. Linkage is **manual**: the researcher types the think-aloud participant code on both devices. Audio is recorded only under separate consent, with a deletion timer (PRV-05). **Report comprehension uses `report_mode=demo` only** (REP-02).
- AC: Marks align within 250 ms.
- AC: Unavailable in the public profile.
- AC: Per-participant export of events (NDJSON) plus observations (CSV).

#### CRT-09 · Performance and teamwork criteria — P1 · M2 · deps: CRT-05, CRT-06 · src: PSYC-11
- ToL board: excess moves, initial thinking time, solved within the limit.
- Card sort: perseverative errors, categories completed.
- **Teamwork:** an administrator-rated **observed cooperation task** (a 3-minute joint sorting task with a confederate or another participant, scored on a behaviourally anchored 5-item scale; inter-rater agreement is checked on 15% double-coded) as the interim criterion. A **partner rating** (5–6 pictorial items) from EPI-06 live dyads.
- AC: Self-rating is impossible.
- AC: Inter-rater ICC(A,1) is reported. Teamwork stays `provisional` while the ICC LB is below .60.

#### CRT-10 · Retest scheduler and contact vault — P1 · M3 · deps: CRT-06, PRV-02, PRV-04, ONB-03 · src: PSYC-08, GOV-29
For opt-in participants only. T2 is 14–28 days after T1, in the **same frozen wave**, using a **parallel form** (ENG-14) at the **same level**, plus a short criterion block (BFI-2-XS, BSCS, Grit-S). **Reminders default to pre-recorded native-speaker IVR calls**, with SMS optional. The channel is logged. **Target: 100 completed pairs per language** (about 160 invitations per language). The vault is purged at study end.
- AC: The send path refuses anyone without a contact opt-in.
- AC: Out-of-window pairs are flagged and excluded from the primary analysis.
- AC: The attrition analysis includes literacy and reminder channel.

#### CRT-11 · Pre-registration and hypothesis registry — P1 · M2 · deps: CRT-07, SCR-01, VAL-02 · src: PSYC-12
`hypotheses.yaml` contains:
- the **primary confirmatory family**: one hypothesis per Tier-1 construct, Holm-corrected, as a lower-bound test that the observed r CI excludes .10, on pooled languages and arms where invariance allows
- **secondary and exploratory families** (BH-FDR)
- discriminant pattern tests (the r_contrast-CV pattern statistic)
- retest, reliability and fairness thresholds
- **completion and play-again targets per language and arm**. Defaults: completion ≥ 85% supervised and ≥ 60% open public; play-again ≥ 70%.
- the teamwork gate exception
- `research_only` decision paths

It is frozen with `gates.yaml` before Stage 2 unblinding and exported to OSF. Amendments are timestamped PLT-09 records.
- AC: Every confirmatory result cites a `hypothesis_id`; anything else is labelled exploratory.
- AC: All 17 constructs are covered (confirmatory, exploratory, group-only or withheld).

### 5.11 VAL: Validation analytics and gates

#### VAL-01 · R psychometrics package and Dagster Pipes — P1 · M2 · deps: ING-06 · src: PSYC-14
`stats/r-psychometrics` is pinned with renv in a digest-pinned Docker image. Each run writes `analysis_run_id`. A Python sidecar recomputes key coefficients.
- AC: The pipeline runs on the fixture snapshot in Linux CI.
- AC: R and Python agree within 1e-6 on alpha, ICC(A,1) and r.
- AC: With fixed seeds, BLAS and threads, results match within 1e-8.

#### VAL-02 · Power, hypothesis count and trial budgets — P0 · M0 · deps: QA-02 · src: PSYC-15, DATA-25, review
Runs **before IRB and protocol sign-off**. It:
1. counts the **real** hypothesis families from the draft registry
2. computes n for the primary lower-bound tests (true r = .25 vs r₀ = .10, Holm over 8)
3. computes n per arm per language for the per-language consistency checks
4. computes retest CI half-widths
5. runs simsem/simulation power for the pattern statistic and the trial-level invariance and DIF models
6. projects Spearman–Brown trial counts from **literature priors** (GNG commission, BART, ToL, card sort, discounting)

Defaults it must confirm or revise:
- **Stage 2: 450 per language (225 per arm)**, 1,350 in total.
- Pooled per arm: 675. That covers .25 vs .10 at Holm α ≈ .00625, which needs ≈ 470.
- Per language and arm, 225 detects sign with LB > 0 for r = .25 (needs ≈ 100).
- **Retest: 100 pairs per language** (ICC .60 half-width ≈ .12; ≈ .07 pooled).
- **Live dyads: ≥ 120.**
- **Unattended substudy: ≥ 300 open-public sessions per language.**

If n is short, the options are: pool shared-paradigm indicators across arms (shared IDs), raise n per language, or demote constructs to exploratory. The chosen option is stated before the protocol is frozen.
- AC: The report states the n per arm per language that each gate actually needs, and the protocol cites it.
- AC: Its output feeds `min_valid_trials` in the dictionary and the trial-budget sheet.

#### VAL-03 · Descriptives and data-quality diagnostics — P1 · M2 · deps: VAL-01 · src: PSYC-16
For every indicator and scale, by language, literacy, education, age, gender, device familiarity, arm, level and variant: n, missingness (planned vs unplanned), moments, floor and ceiling, input-mode share. Also completion and play-again **against the pre-registered targets**.
- AC: Floor or ceiling above 15% is flagged.
- AC: Completion and play-again are shown against targets per language and arm.

#### VAL-04 · Reliability by indicator type — P1 · M2 · deps: VAL-01 · src: PSYC-17, DATA-28
Uses each indicator's `reliability_method`:
- **raw trial-exchangeable:** permutation split-half (5,000 splits) **stratified by condition and block or staircase phase**, Spearman–Brown, with CI
- **model parameters** (slopes, diffusion, log k): **model-based reliability** (posterior variance ratio) with bootstrap CI
- **composites:** **stratified alpha / Mosier composite reliability or omega** from indicator reliabilities and covariances
- **single-event:** not computed (`unscorable_individual`)

Omega for criterion scales per language and mode.
- AC: Simulated reliability .70 is recovered within ±.03 per method.
- AC: Difference-score reliability from components is reported next to the slope reliability.
- AC: Scales with omega < .60 in any language are flagged.

#### VAL-05 · Test–retest — P1 · M3 · deps: CRT-10, VAL-01 · src: PSYC-18, DATA-28
**Primary: ICC(A,1)** (two-way, absolute agreement, single measure; McGraw and Wong), with a 95% CI. Secondary: ICC(C,1). Also SEM and SDC from the same ICC, Bland–Altman, and practice effects (pre-registered expected direction and size; d > .3 flagged). Form is a factor in the model. Per language and pooled (when invariance holds).
- AC: n ≥ 30 pairs per cell, otherwise reported as insufficient.
- AC: Pearson r is never used for gates.
- AC: The out-of-window sensitivity analysis is reported.

#### VAL-06 · Convergent and discriminant validity (MTMM pattern) — P1 · M2 · deps: CRT-11, VAL-04 · src: PSYC-19, DATA-29
Observed r with bootstrap CIs. Primary lower-bound tests. The **pattern statistic r_contrast-CV** (Westen and Rosenthal) per construct, with a permutation CI, replacing the many pairwise Steiger tests. Partial r controlling level, education, literacy, device familiarity and input mode. FIML for planned-missing criterion blocks. Heatmaps per language and pooled. **Disattenuated r is secondary only**: retest reliability where available, with CIs that propagate reliability uncertainty (joint bootstrap). **It never feeds gates or reports.**
- AC: Every primary hypothesis gets a lower-bound and pattern result.
- AC: The gate input table contains observed estimates only (schema check).
- AC: Cross-language convergent comparisons run only after VAL-08a passes for the criterion scale involved.

#### VAL-07 · Factor structure (restricted) — P2 · M5 · deps: VAL-06 · src: PSYC-20
CFA/ESEM **only for criterion scales and for constructs with ≥ 3 coherent indicators**. lavaan MLR or WLSMV with FIML. Non-convergence and Heywood cases are reported.
- AC: The registry refuses CFA for constructs with fewer than 3 indicators.

#### VAL-08a · Criterion-scale invariance across languages and modes — P1 · M3 · deps: VAL-01, CRT-04 · src: PSYC-21, review
Multigroup CFA (semTools) for criterion scales across language versions and **self vs read-aloud** mode. Partial invariance rules are pre-registered (at most 20% of loadings or intercepts freed). Ordinal items use WLSMV thresholds. Bayesian approximate invariance is used for groups with n < 200. **This is a Stage 2 analysis prerequisite** for any cross-language convergent comparison.
- AC: Each scale gets a decision table (configural, metric, scalar, or partial with the freed parameters).

#### VAL-08 · Game measurement invariance (trial level) — P2 · M5 · deps: VAL-07, VAL-08a · src: PSYC-21, DATA-30
**Explanatory IRT / GLMMs** within each task. Trials or stimuli are items, with group × item interactions (lme4/glmmTMB for binary and RT; mirt for categorical). **Required groupings:** language, literacy, education, age band, gender, **device familiarity**, **input mode**, **variant form**, timing profile and **site_mode** (VAL-18). These same variables enter MTMM partial correlations as **covariates**. That is a single, stated decision: they are groupings for invariance and covariates for validity.

Moderated (non-uniform) MIMIC is used for small groups. Partial invariance rules are pre-registered (maximum share of freed item parameters: 20%).
- AC: A decision table per grouping and task.
- AC: The small-n fallback is automatic and logged.

#### VAL-09 · DIF with a purified matching variable — P2 · M5 · deps: VAL-01, VAL-02 · src: PSYC-22, DATA-30
The DIF unit is defined per task (stimulus_id or trial type). The **matching variable** is a purified latent trait from the same task, estimated with **iterative anchor purification**. Methods: logistic/ordinal regression DIF for categorical responses, **GLMM regression DIF** for continuous RT and rates, and **BH-FDR** across items. The warm-up proxy is used **only as a covariate sensitivity analysis**. Flagged stimuli are exported by `stimulus_id`, content version and variant.
- AC: Planted DIF is detected in **≥ 90%** of 100 replications, with false positives at or below nominal (the same target as §9.2).

#### VAL-10 · Incremental validity (Stage 5) — P2 · M6 · deps: VAL-06, CRT-04 · src: PSYC-23, DATA-33
Outcomes (supervisor or peer rating, observed task) enter as `instrument_type=outcome`. Model sequence: demographics → self-report → game traits. Outputs ΔR² with bootstrap CI and k-fold CV.
- AC: Refuses to run below the pre-declared n.

#### VAL-11 · Norming service (weighted) — P2 · M6 · deps: VAL-08, VAL-14 · src: PSYC-24, DATA-32, GOV-11
**cNORM (primary) or GAMLSS** on a **post-stratified/raked sample** weighted to census or NFHS margins (age, gender, education, literacy, urban/rural per language region). Age and education are continuous predictors, not cells.
- **Target Stage 5 n: 1,500–2,000 per language.** This is likely **beyond P24**.
- Within the grant, pilot-based norms are published as **provisional**, with SEM-based "not enough to say" (§7.7).
- Integrity is normed by age × gender if it is ever released.
- AC: No percentile crossing. A violation blocks publication.
- AC: Every report artefact records `norm_table_version` and `provisional` status.
- AC: Weights are trimmed and the effective n is reported.

#### VAL-12 · Indicator retention scorecard (provisional, then final) — P1 · M3 · deps: VAL-04, VAL-05, VAL-06 · src: PSYC-25, DATA-28
- **At Stage 2 exit:** **provisional flags only** (reliability by method, pattern, floor/ceiling, trial adequacy, B vs A). **No drops.**
- **After Stage 3:** the retain/revise/drop decision, with **retest ICC(A,1) as the primary criterion**, then reliability and pattern. Two researchers sign off (PLT-09). The **dictionary v2** freeze follows.
- **Stage 4:** a DIF/invariance re-gate can move an indicator to revise or drop.

Drops become a dictionary PR diff and are never applied silently.
- AC: Stage 2 output contains no `dropped` status (test).
- AC: Every indicator has a decision record before trait gate promotion.
- AC: A drop bumps the dictionary version.

#### VAL-13 · Pathway B vs A comparison — P1 · M3 · deps: CRT-07, VAL-06, EPI-05 · src: PSYC-26
Arm-randomised participants only. Reliability (Feldt and bootstrap), convergent r (Fisher z on shared constructs), completion and play-again (against targets), session time and DIF burden. **Emotional regulation and judgement are compared as A-only** (B is `withheld`). Produces a decision memo.
- AC: The table shows each construct with CIs for both arms, or "A only".

#### VAL-14 · Gate service: battery release gate and trait gates — P1 · M3 · deps: VAL-04, VAL-06, PLT-09 · src: PSYC-27, DATA-31, GOV-08
Implements §7.7 from the frozen `gates.yaml`.
- **`battery_release_gate`** per (language, pathway, site_mode): `closed | open`.
- **Trait status** per (trait, language, pathway): `unvalidated | research_only | validated_broad_style | validated_banded | withheld`.

**Evaluate-only mode** (before VAL-05/08/09 exist) computes partial evidence and **can never promote**. Promotion needs ValidationEvidence plus PLT-09 sign-off from two named people. Integrity and risk are capped at broad style. Regressions re-close gates automatically. Thresholds come only from the frozen `gates.yaml`; changes need an amendment. Outputs feed the release pack (REP-03).
- AC: With missing evidence, the service evaluates but never promotes.
- AC: **Property test** over random gate states: a trait is shown only if battery gate(language, pathway, site_mode) = open AND trait status ∈ {validated_banded, validated_broad_style} for that language and pathway. A language whose battery gate is closed shows thank-you only, even if other languages pass.
- AC: History is append-only.

#### VAL-15 · Quarto reproducible reports — P1 · M2 · deps: VAL-01 · src: PSYC-28
Stage reports S1–S5, the technical manual, per-language reliability and fairness reports, the B vs A memo, the ITC dossier, the unattended-mode report and the norm manual. Footers carry provenance hashes. Confirmatory and exploratory sections are separated. Completion and play-again are shown against targets.
- AC: All reports render on the fixture snapshot with no manual steps.

#### VAL-16 · Operational fairness watch — P2 · M5 · deps: VAL-14, QA-02 · src: GOV-30
Weekly comparisons conditioned on the purified latent, by language, literacy, education, age, gender, device model and familiarity, input mode, variant and site_mode. Cells with n < 30 are suppressed. Warnings link to gate demotion.
- AC: A planted shift raises a warning within one cycle.

#### VAL-17 · De-identified research export — P2 · M6 · deps: ING-06, PRV-02 · src: PSYC-30
CSV, Parquet and .sav with a codebook. k-anonymity ≥ 5. Archive-consent participants only. A data-use agreement record per recipient.
- AC: Re-importing reproduces the snapshot statistics within 1e-8.

#### VAL-18 · Supervised vs unattended mode equivalence — P2 · M5 · deps: VAL-08, VAL-09 · src: review
Compares `site_mode` supervised vs open_public (S4u, thank-you mode, core consent) on indicator distributions, quality-flag rates, completion and trial-level invariance (VAL-08 machinery), **with ability held constant** (purified latent plus warm-up covariates). `site_mode` is an invariance grouping.
- AC: The gate service keeps `battery_release_gate(site_mode=open_public)` closed until VAL-18 passes for that language and pathway.
- AC: A report per language and pathway.

### 5.12 REP: Player report

#### REP-01 · Composite and band service — P1 · M4 · deps: VAL-14, PLT-02 · src: PSYC-31, DATA-31, GOV-09
Composites of **retained** indicators (unit-weighted z or factor scores) are mapped through the norm table to 3 bands. "Not enough to say" applies when the **SEM-based 90% CI** (retest SEM) overlaps more than one band boundary, or the band width is < 2 SEM. Phrase keys come from a strengths-framed allowlist. The 3–5 most reliable released traits are shown, always with the disclaimer. **Single implementation:** the Python reference produces the release pack (weights, standardisation parameters, cut-points). The kiosk TS evaluator consumes it.
- AC: Property test: no numeric tokens, no negative keys, disclaimer always present.
- AC: A closed gate means no band.
- AC: **Parity:** TS and Python give identical bands on 10k golden sessions and composites within 1e-8.

#### REP-02 · Report delivery: thank-you, demo and player modes — P1 · M3 · deps: VOX-01, KSK-08 · src: KIOS-22, GOV-10
`report_mode ∈ {thank_you, demo, player_report}`:
- **thank_you:** the default, plus "what this game is about".
- **demo:** **fictional profiles, labelled "example" in audio and print, never computed from the participant's play**. Used only in think-aloud comprehension testing.
- **player_report:** only through the REP-03 release pack.

The spoken report is concatenated pre-recorded segments. A one-page pictogram summary is printed as an ESC/POS bitmap. The QR holds an opaque 128-bit token for a 72 h–7 day page with audio replay and "erase my data".
- AC: A gated E2E test confirms no trait information in thank_you mode.
- AC: Demo mode refuses any input from the session's indicators (enforced by the type system and a test).
- AC: Paper-out falls back to QR.
- AC (*study, demo mode*): ≥ 80% of non-readers can describe one strength from the example summary.

#### REP-03 · Signed, expiring release pack — P1 · M4 · deps: REP-01, VAL-14, KSK-11 · src: review
A signed content pack containing battery gate and trait statuses per language, pathway and site_mode, norm and band tables, composite parameters, phrase allowlist and **expiry** (default 14 days). It is distributed by OTA, so offline kiosks can report. The kiosk **fails closed** on an expired pack, an invalid signature or a version mismatch with the dictionary.
- AC: An expired or tampered pack gives thank-you only.
- AC: A gate regression produces a new pack within one pipeline cycle.

### 5.13 PRV: Privacy, security and governance

#### PRV-01 · Deployment policy (static signed file first) — P0 · M0 · deps: PLT-02, PLT-09 · src: GOV-01
A signed, versioned policy file per site or group with the §1.4 keys, timeouts, `integrity_dice_mode`, `partner_disclosure`, `report_mode`, retention overrides and `asr_enabled`. Before OTA exists (KSK-11), it is distributed in the image. Two-person approval through PLT-09. **Rejected combinations:** `allow_minors=true` without the PRV-12 preconditions; live D or criterion capture at `open_public`; `report_mode=player_report` without a valid release pack. **Camera and voice-tone flags do not exist.** Any future re-introduction needs a signed validation-evidence record plus a DPIA plus a code change.
- AC: The kiosk refuses to start with an invalid or expired signature.
- AC: `policy_version` is on every session.
- AC: Diffs are audited.

#### PRV-02 · Consent ledger and purpose enforcement — P0 · M0 · deps: CRT-01, ING-02 · src: GOV-02, PSYC-07, DATA-10
Immutable `ConsentArtefact` records (§6.3). Kinds: `core`, `archive`, `contact`, `research_audio`, `asr_eval`, `coplay_substudy`, `criterion`. Every derived table is tagged with its purpose. Play-only raw events are purged after 90 days (configurable).
- AC: Ingest parks or rejects scorable events without core consent (ING-02).
- AC: Sessions without archive consent are absent from exports.
- AC: Withdrawal stops sync and triggers erasure.

#### PRV-03 · Audio non-retention and microphone gating — P0 · M0 · deps: KSK-01 · src: GOV-04
The mic is **closed** in attract, languageSelect, consent, bands and every state without an open consented prompt window. No audio in storage, logs, crash dumps or telemetry, and scrubbers drop large audio-module fields. Research and ASR-evaluation audio only in supervised mode with separate consent, encrypted, with a deletion timer.
- AC: A state-machine integration test confirms zero `MediaStreamTrack(audio)` outside prompt windows.
- AC: Research audio cannot be enabled at `open_public`.

#### PRV-04 · Pseudonymisation and identity vault — P0 · M0 · deps: PRV-07 · src: GOV-05
Random pid. A separate vault DB with separate keys. The only link is an HMAC between contact and pid. Demographics are coarsened at capture. Re-linking needs IdentitySteward plus a justification, which is audited.
- AC: The analysis role cannot read the vault.
- AC: Rotating the pepper keeps links.

#### PRV-05 · Retention schedule engine — P0 · M0 · deps: PRV-04, PRV-07 · src: GOV-06
YAML rules per data class: raw, derived, consent, vault, research audio (deleted ≤ 30 days after coding), ASR eval samples, kiosk cache, telemetry 90 days, security logs 1 year, DB backups ≤ 14 days, `session_keys` backups ≤ 14 days. A nightly RetentionRun report. Legal holds. **In place before Stage 1.**
- AC: Backdated synthetic records and their derived data are purged.
- AC: A hold blocks purge.

#### PRV-06a · Minimal erasure (before Stage 1) — P0 · M0 · deps: PRV-04, PRV-05 · src: GOV-07, review
Local purge plus DEK shred on the kiosk, a server delete by session_id or pid across events, indicators, criterion and links, vault purge, and research-audio deletion. A signed receipt is issued.
- AC: Primary stores are cleared within 72 h (sweep query).
- AC: Research audio for a withdrawn participant is deleted.

#### PRV-06 · Full erasure with crypto-shredding — P1 · M3 · deps: PRV-06a, ING-08 · src: GOV-07, DATA-10
Extends PRV-06a with: deletion of the wrapped session DEK (making raw S3 objects and versions unreadable), DLQ purge, an **explicit snapshot rebuild step**, removal from the export recipient register, a replay guard that re-applies tombstones after a restore, and backup coverage through the ≤ 14-day backup retention. Reruns are documented as "reproducible modulo erasures".
- AC (*drill*): restoring a backup and re-applying tombstones gives zero readable rows for the pid.
- AC: Raw objects for the session cannot be decrypted after erasure.

#### PRV-07 · Encryption and key management — P0 · M0 · deps: PLT-05 · src: GOV-12, PSYC-32
TLS 1.3, kiosk mTLS (step-ca, short-lived certificates), TPM-sealed kiosk keys, the backend private key for session DEK unwrap in KMS, RDS encryption, column envelope encryption for the vault, S3 SSE-KMS, and separate backup keys.
- AC: sslyze shows TLS 1.3 only.
- AC: A revoked certificate fails within 5 minutes.
- AC: A disk pulled from a kiosk yields no readable data.

#### PRV-08 · RBAC and audit — P0 · M0 · deps: PRV-07 · src: GOV-13, PSYC-32
Cognito groups: Researcher, ResearchLead, FieldAdministrator, IdentitySteward, FleetOperator, ContentEditor, ContentReviewer, EthicsOfficer, DPO, Analyst-deidentified. MFA required. Enforced in the API and with Postgres RLS. The **append-only audit table** plus CloudTrail is exported daily to versioned S3. Exports over 50 rows need a justification.
- AC: A permission-matrix test runs in CI.
- AC: FieldAdministrator cannot read scores.

#### PRV-09 · Security hardening and threat model — P1 · M3 · deps: PRV-07, KSK-10 · src: GOV-14
STRIDE threat model with abuse cases (replay, fake sessions, malicious QR, theft, coaching). ASVS L2. Batch signatures plus in-transaction `seq` for replay protection. Dependency, SAST and container scans.
- AC: The ASVS L2 checklist passes before Stage 2.
- AC: Invalid batches are rejected with a reason.

#### PRV-10 · Incident response (DPDP) — P1 · M4 · deps: PRV-08, KSK-10 · src: GOV-18
CloudWatch alarms for anomalous exports, auth bursts, tamper, certificate misuse and vault reads. Workflow: scope query, containment (revoke, wipe, rotate), notification templates per language, a timeline against the DPDP Rules, and a post-mortem.
- AC (*drill*): a tabletop scopes the affected pids within 4 h.
- AC (*drill*): the stolen-kiosk drill passes.

#### PRV-11 · IRB and ethics evidence pack — P0 · M0 · deps: PRV-01, PRV-08, VOX-07 · src: GOV-27
A generator assembles, per study and wave: protocol and approvals, consent scripts (hashes, transcripts, back-translations), policies, dictionary and prereg hashes, DMP and **DPIA** (PRV-12), the VAL-02 power report, complaint log, erasure stats, gate history and training records. The **Stage 1 pack is needed by P7.** Deployed-artefact hashes are added once KSK-11 exists.
- AC: Content hashes match the deployed artefacts.
- AC: A complaint reaches the EthicsOfficer within 24 h.

#### PRV-12 · DPIA, age assurance and minors preconditions — P0 · M0 · deps: PRV-01 · src: review
The DPIA records:
- **age is self-declared** at the kiosk
- an under-18 band selection ends the session
- data is minimised for all public-mode sessions (no criterion, no contact unless opted in, thank-you mode)
- a **legal review of the DPDP Rules on age assurance for anonymous kiosks** is sought

**Preconditions before minors can ever be enabled:** verifiable parental consent, a legal opinion on the §9(3) behavioural-monitoring bar, an age-tiered module set **without integrity and accountability content**, and ethics approval.
- AC: The policy validator enforces the preconditions.
- AC: The DPIA document hash is in the IRB pack.

#### PRV-13 · Tamper-evident audit chain and SIEM (deferred) — P2 · M5 · deps: PRV-08, PRV-10 · src: GOV-13, GOV-18
A hash-chained audit with daily anchors, plus SIEM correlation (Wazuh or an equivalent), if the stakeholders or the hosting mandate require it.
- AC: The verifier detects a modified entry.

### 5.14 QA: Testing and quality

#### QA-01 · Scoring unit and property tests with parity — P0 · M1 · deps: SCR-02, PLT-04 · src: GOV-21
Every indicator has ≥ 1 golden fixture and ≥ 3 properties (monotonicity, abandoned → NA, duplicates have no effect, order invariance, covariates only as declared).
- AC: The TS preview scorer and Python agree (counts exact, continuous values within 1e-8) on 10k sessions.
- AC: Re-ingesting a session gives identical values.

#### QA-02 · Synthetic player simulator and parameter recovery — P0 · M0 · deps: ING-01, SCR-01, ENG-05 · src: DATA-25, GOV-22, GAME-30
See §9.2. Bots play the real headless engine with real bundles through the real ingest. Synthetic criterion, retest and DIF data come from the same latents. Data is labelled `synthetic=true`, and a DB constraint keeps it out of real tables. An early M0 version runs analytic simulation for VAL-02 before all games exist.
- AC: Recovery targets as in §9.2.

#### QA-03 · Golden-session fixtures — P0 · M1 · deps: QA-02, ENG-08 · src: GAME-30
Versioned event logs with expected indicators, content hash and dictionary version, shared between kiosk and backend.
- AC: CI fails on any silent drift.

#### QA-04 · End-to-end and hardware-in-the-loop tests — P1 · M3 · deps: PLT-04, VOX-07, KSK-08 · src: GOV-24
Playwright on Electron runs full B and A sessions in each pilot language: the touch-only path, voice prompts (once VOX-04 is enabled) under 60, 70 and 80 dB noise, walkaway at each module, a 7-day network drop, power cut, paper out, policy variants, erasure by QR, an expired release pack, and a kiosk clock skew. Nightly on one physical kiosk.
- AC: All journeys pass in 3 languages before each ring promotion.
- AC: `seq` continuity holds after a network drop.

#### QA-05 · Load and soak tests — P1 · M3 · deps: ING-02, KSK-07 · src: DATA-08, KIOS-03
Ingest load with k6, a 72 h kiosk soak, a 50-session audio soak.
- AC: The thresholds in KSK-03, VOX-01 and ING-02 are met.

---

## 6. Data model and logging contract

### 6.1 Event envelope (`schemas/event/v1.json`)

| Group | Fields |
|---|---|
| Identity and ordering | `event_id` (UUIDv7), `schema_version`, `event_type`, `seq` (int, gapless per session, allocated in the same transaction; `invalid` placeholders keep it gapless) |
| Session context | `session_id`, `participant_pid` (nullable until consent), `kiosk_id`, `site_id`, `site_mode`, `mode` (`think_aloud\|pilot\|retest\|public\|substudy`), `battery_arm`, `slot_form`, `language`, `player_slot` |
| Versions | `app_version`, `bundle_hash`, `audio_manifest_hash`, `variant_pack_id`, `scoring_dict_version`, `indicator_set_version`, `protocol_version`, `policy_version`, `release_pack_version`, `device_profile_id`, `hardware_sku`, `timing_profile_version` |
| Task position | `episode_id`, `module_id`, `block_id`, `trial_id`, `trial_index`, `probe_group_id?`, `form_id`, `anchor_trial` |
| Condition | `phase` (`practice\|warmup\|main\|pressure\|shift_pre\|shift_post`), `shift_active`, `timer`, `noise`, `calibration_level`, `variant_seed`, `partner_type?`, `customer_tone_level?` |
| Timing | `t_mono_ms` (session anchor), `kiosk_t_wall` (informational only, used for clock-offset estimation), `timing_flag`, `scorable`, `interrupted` |
| Server-added | `server_received_at`, `clock_offset_estimate_ms`, `batch_id` |
| Payload | Discriminated union on `event_type` |

**Response payload:** `stimulus_id`, `response_value` (closed code), `input_mode` (`touch|voice|voice_then_touch_confirm|timeout|none`), `latency_ms` (**signed**, nullable only on timeout), `latency_anchor`, `barge_in`, `hold_ms`, `tap_count`, `revisions[]`, `touch_xy_norm`, `asr_label?`, `asr_confidence?`. **There is no `asr_alternatives` field in production.** It exists only in the separate `asr_eval` schema used under supervised ASR-evaluation consent.

**Event types:**
- Session and onboarding: `session_start{seed, refresh_hz, arm_source, stratum, slot_form}`, `session.state_changed`, `language_selected/switched`, `consent.granted/declined{tap_confirmed}`, `optin.archive`, `optin.contact` (boolean only), `bands.answered{age, literacy, edu, gender, device_use, played_before}`, `practice.summary`, `calibration_result`.
- Trial: `module_start/end{ended_reason}`, `trial_start`, `stimulus_onset{presented_onset, audio_onset, onset_source}`, `prompt_audio_end`, `prompt_window_open/close`, `response`, `asr_result`, `input.raw_tap`, `input.hold`, `trial_end`, `context_shift{kind, announced}`.
- Paradigm: `move`, `route_step`, `contribution`, `pump`, `report` (dice: reported value only), `partner_action{policy}`, `turn_event`, `credit_allocation`.
- Interaction and environment: `idle`, `walkaway.prompted/resumed`, `session.abandoned`, `instruction_replay`, `ui.replay`, `audio.played`, `env.noise_dbfs`, `env.headset`, `a11y.profile`, `onlooker_reported`, `researcher_annotation`, `invalid{reason}`.
- End and device: `report.delivered/withheld{report_mode, release_pack_version}`, `survey.enjoy/play_again`, `erasure_requested`, `session_tombstone`, `device_health`, `session_end{reason}`.

### 6.2 Other contracts

| Contract | Key fields |
|---|---|
| `UploadBatch` | `batch_id`, `kiosk_id`, `kiosk_t_wall`, `session_chunks[{session_id, sealed_dek, ciphertext, first_seq, last_seq}]`, `sha256`; response gives per-event `accepted\|duplicate\|parked\|rejected_terminal\|retryable` |
| `SessionContext` | language, age_band, **literacy_band**, edu_band, gender, device_familiarity, played_before, asr_enabled, noise stats, headset, a11y, practice summary, arm, slot_form, calibration level and policy, linkage flag, `linked_prior_session_token`, device model and firmware, site_mode, variant_pack_id, completion, walkaway point |
| `ContentManifest` | stimulus, audio and layout IDs → attributes (go/no-go, rule, min moves, solver optimum, unsolvable, optional/prompted, **customer tone level with voice clip and face asset IDs**, bribe size as a pictured quantity, `repeat_group_id`, `anchor_trial`, `form_id`, `requires_numeracy=false`, `voice_forbidden`) |
| `ScoringDictionary` | see SCR-01; per-pathway `frozen_at`, `sha256` |
| `GameTrialSpec` | trial_id, condition, response window, vocabulary, audio keys, `private_report`, `anchor_trial`, `form_id` |
| `CriterionResponse` | pid, study, wave, instrument and version, language version, block (X/A/B/C), item_id, raw_response, latency, `administration_mode`, administrator_id, device_id, audio version, attention-check flag |
| `CriterionScaleScore` | pid, wave, instrument, scale, score, n_answered, key version, prorated, planned_missing |
| `ParticipantLink` | pid, game_session_ids[], criterion_wave_ids[], method, linked_by, confidence |
| `ScoringRunManifest` | run_id, dictionary sha per pathway, git sha, image digest, lock hashes, partition hashes, seeds, BLAS/thread config, erasure receipts |
| `ValidationResult` | indicator or trait × stage × subgroup; metric, **observed** estimate, CI, n, threshold, pass, run_id, hypothesis_id, method |
| `IndicatorDecision` | indicator, `provisional_flags` (Stage 2) or retain/revise/drop (post-Stage 3), rationale, evidence, signers |
| `NormTable` | version, trait, language group, model coefficients or cut-points, weights scheme, effective n, provisional flag |
| `BatteryGateStatus` | language, pathway, site_mode, status, evidence ids, approvers, effective_from |
| `TraitGateStatus` | trait, language, pathway, status, evidence ids, approvers, effective_from |
| `ReleasePack` | version, expiry, battery and trait statuses, composite parameters, norm/band tables, phrase allowlist, signature |
| `ReportArtefact` | report_id, token, language, `report_mode`, `traits_shown[{trait, band, phrase_key}]`, disclaimer, norm/release-pack/bundle versions, delivery mode, expiry; no numbers |
| `DeploymentPolicy`, `DeviceHeartbeat`, `DeviceCommand`, `AuditEvent`, `ErasureRequest/Receipt`, `DataQualityFlags`, `SyntheticDataset` | as described in the features |

### 6.3 Consent artefact

`consent_id`, `participant_pid`, `session_id`, `kind` (core, archive, contact, research_audio, asr_eval, coplay_substudy, criterion), `granted`, `consent_script_id`, `script_audio_sha256`, `language`, `policy_version`, `protocol_id`, `input_mode` (always `tap`), `presented_at`, `decided_at`, `kiosk_id`, `replay_counts`. Immutable; changes are superseding records. **No `recognised_label`**, because consent is never by voice.

### 6.4 PostgreSQL 18 schemas

- `kiosk_raw`: **`event_dedup` (unpartitioned; `event_id` PK, `server_received_at`)**; `events` (partitioned by **`server_received_date`** with pg_partman; typed core columns plus JSONB payload; index on `(session_id, seq)`); `consent_parking`; `batches`; `dead_letter`.
- `scored`: trials_canonical, indicators_long, model_estimates, style_indices, session_quality, scoring_runs.
- `criterion`: instruments, items, language_versions, keys, responses, scale_scores, permissions.
- `linkage`: participant_links, pairing_codes (restricted).
- `consent`: artefacts, session_keys (KMS-wrapped DEKs), erasure_requests, receipts, tombstones.
- `identity_vault`: a separate DB with separate keys; contact details.
- `study`: studies, cohorts, quotas, arms, blocks, protocols, prereg.
- `validation`: analysis_runs, validation_results, indicator_decisions, norm_tables, battery_gates, trait_gates, release_packs.
- `governance`: policies, audit_events, retention_runs, devices, imported_signoffs.
- `research_views`: de-identified views (Metabase).

---

## 7. Psychometric validation pipeline and gates

### 7.1 Freeze timeline

| Artefact | Frozen when | Change path |
|---|---|---|
| Dictionary **v0** (both pathways) | Before Stage 1 (P7) | Amendment to make v1 |
| Dictionary **v1-B** | Stage 1 exit (P9) | Amendment |
| Dictionary **v1-A** | Stage 1b exit (P11) | Amendment |
| `hypotheses.yaml` + `gates.yaml` (pre-registration, OSF) | After v1-A, before Stage 2 (P12) | Timestamped amendment only |
| Wave 1 build (app, content, dictionary v1) | Start of Stage 2; **covers Stage 3 T2 sessions too** | New wave only |
| Dictionary **v2** | **After Stage 3** retention decisions (P18) | Scoring-only amendments allowed between Stage 2 and v2; task changes go to wave 2 |

### 7.2 Dagster asset graph (partitioned by language × wave)

```
raw_batches → events → trials_canonical → indicators_long → model_estimates (hierarchical/diffusion)
  → style_indices → session_quality → criterion_scale_scores → analysis_wide → parquet_snapshot
  → [R] descriptives · reliability_by_method · icc_A1 · criterion_invariance · mtmm_pattern
        · trial_level_invariance · dif_purified · site_mode_equivalence · weighted_norms
  → validation_results → indicator_scorecards → battery_gate + trait_gates → release_pack → quarto_reports
```

Asset checks are hard gates. A failing check blocks promotion and notifies researchers.

### 7.3 Stage 1 and 1b: think-aloud

- **Sample:** 30–40 per pathway, spread across **age × literacy × gender × 3 languages** (and regions within each language where variants are planned).
- **Built:** CRT-08, ING-07, VOX-06 (ASR samples), ONB-07 confusion map, REP-02 demo mode.
- **Analyses:** comprehension issue rates by screen and language; reading-dependent and digit-dependent codes; cultural-mismatch log; onboarding duration; completion; ASR accuracy by age and gender.
- **Exit gates** (all must hold):
  1. **zero screens coded as reading-dependent**, and zero decisions coded as digit-dependent
  2. no screen with more than 20% "misunderstood instruction" codes left unresolved
  3. a **cultural-equivalence sign-off per scenario** (bribe, inspector, stall, weighmaster authority, partner roles, dice) by region, age band and gender, recorded in PLT-09
  4. onboarding median ≤ 90 s
  5. report comprehension ≥ 80% with **demo** profiles
  6. content at `think_aloud_tested`
  7. the dictionary v1 freeze for that pathway

### 7.4 Stage 2: pilot with criterion battery

- **Design:** 450 per language (VAL-02 confirms), quotas by age × gender × education × literacy, **B_fixed vs A_narrative randomised 1:1**, both arms complete criterion block X plus one rotating block, performance tasks, fixed level L2. The **live-dyad substudy** (≥ 120 dyads, A arm, supervised) and the **forced-level subsample** run in parallel.
- **Analyses:**
  - descriptives (VAL-03)
  - reliability by method (VAL-04)
  - **criterion-scale invariance across languages and modes first (VAL-08a)**
  - MTMM primary lower-bound tests and pattern statistics on observed r (VAL-06)
  - B vs A (VAL-13)
  - completion and play-again against targets
- **Exit:** **provisional indicator flags only** (VAL-12). There are **no drops and no v2 freeze**. Stage 3 runs on the **same frozen v1** build.

### 7.5 Stage 3: retest

- **Design:** 100 completed pairs per language (about 160 invited each), 14–28 days, same wave, parallel form, T1 level locked, IVR reminders.
- **Analyses:** **ICC(A,1)** primary and ICC(C,1) secondary, with SEM, SDC, practice effects (pre-registered), form effects, and attrition bias (including literacy and channel). Style traits are evaluated against nomological predictions.
- **Exit:** VAL-12 **final** retain/revise/drop decisions (retest primary), then the **dictionary v2** freeze for wave 2.

### 7.6 Stage 4: fairness and mode equivalence (ITC)

- Trial-level invariance (VAL-08) across **language, literacy, education, age band, gender, device familiarity, input mode, variant form and timing profile**.
- DIF with purified matching and FDR (VAL-09). Class-C-equivalent DIF left unresolved leads to the indicator being revised or dropped.
- Differential exclusion (SCR-12). ASR gap ≤ 5 pp.
- **Supervised vs unattended equivalence (VAL-18)** on S4u data. It is required before any open-public release.

**Reliability method by indicator kind** (`reliability_method` in the dictionary):

| Kind | Method |
|---|---|
| raw, exchangeable trials | Permutation split-half stratified by condition and block, Spearman–Brown |
| staircase or titration | Model-based (posterior) reliability; no odd/even splits |
| difference_slope | Model-based reliability of the random slope, plus difference-score reliability from components |
| model_parameter | Model-based or bootstrap-posterior reliability |
| composite | Stratified alpha / Mosier composite reliability / omega |
| single_event_unscorable | Not computed; not individually scorable |
| all | Retest ICC(A,1) is the primary stability evidence |

### 7.7 Gate rules (`gates.yaml`, frozen in the pre-registration)

**A. Battery release gate**, per (language, pathway, site_mode). It opens only if **all** of these hold:
1. **At least 2 language groups** (this one plus at least one other) each meet A2 and A3 for this pathway.
2. **Reliability across the battery:** ≥ 50% of the pathway's Tier-1 constructs (counting withheld ones as fails) meet trait rules B1 and B2 in that language.
3. **Fairness across the battery:** VAL-08a criterion invariance passes; VAL-08 and VAL-09 show no unresolved large DIF or non-invariance across the required groupings for retained indicators; differential exclusion is within tolerance.
4. **For `open_public`:** VAL-18 passes for that language and pathway.
5. A PLT-09 sign-off by PI/ResearchLead plus EthicsOfficer.

A language whose battery gate is closed shows **thank-you only**.

**B. Trait gate**, per (trait, language, pathway). `validated_banded` needs all of these:
1. **Retest:** ICC(A,1) point ≥ .60 **and** 95% lower bound ≥ .40 (per language, or pooled with language-specific point ≥ .50 where invariance holds).
2. **Reliability:** composite reliability by method, point ≥ .70 and lower bound ≥ .60.
3. **Convergent validity** on **observed** r only: correct sign, 95% CI lower bound > .10 (Holm-corrected for primary), and own > discriminant by the pattern statistic. **No upper bound.** Style traits use their pre-registered nomological predictions. **Teamwork** uses the provisional criterion under a recorded exception and is capped at `validated_broad_style` until the partner-rating evidence passes.
4. **Invariance and DIF:** passes for all required groupings, including **device familiarity and input mode**.
5. **Norms:** provisional or final norm table available. The SEM rule for "not enough to say" applies.
6. PLT-09 sign-off by two named people.

**C. Other rules:**
- Integrity and risk are capped at `validated_broad_style` with a stricter flag, or withheld. Dice is group-level only and never shown to players.
- Emotional regulation and judgement are permanently `withheld` for Pathway B.
- Disattenuated statistics never feed gates.
- Fail-closed. Regressions re-close gates automatically. Thresholds change only by amendment.
- **Display rule** (REP-01/03): show a trait iff battery gate = open AND trait gate ∈ {validated_banded, validated_broad_style} AND session `valid_for_report` AND the estimate is not "not enough to say" AND the release pack is valid and unexpired AND `report_mode=player_report`.

### 7.8 Decision path for constructs that do not pass

The pre-registration has the following steps:
1. A construct failing B1–B3 after Stage 3 becomes `research_only`. It keeps being collected only if it contributes to the battery gate or to wave-2 redesign.
2. Wave 2 may add trials or redesign tasks (ENG-13), which needs a new dictionary version and a new pre-registration amendment.
3. Two consecutive failures lead to a recommendation to drop the construct from player reports permanently.
4. A memo to the stakeholders after Stage 3 lists the reportable subset.

### 7.9 Stage 5: criterion validity and norming

- Outcome capture (supervisor or peer rating, or an observed task), depending on the "report use" decision.
- Incremental validity (VAL-10).
- **Norms:** weighted cNORM/GAMLSS. The target n of 1,500–2,000 per language is **likely post-grant**. Within P24, provisional norms only.
- ENG-13 reallocation for the next wave.

### 7.10 Reproducibility rules

- Waves are frozen on `app × content × dictionary × protocol × release pack`.
- Every coefficient traces to `analysis_run_id` → snapshot manifest → partitions.
- Results outside the registry are labelled exploratory.
- Erasures are counted in each manifest.
- Numeric reproducibility is checked with tolerances (1e-8) and fixed BLAS and thread settings, not byte equality.

---

## 8. Roadmap (project months P4–P24)

P4 (Sep 2026) is planning, which is this document. About 20 months remain. The milestones overlap deliberately.

| Milestone | Project months | Built | Verified at exit | Stage |
|---|---|---|---|---|
| **M0 Foundations, decisions and governance** | P5–P7 | PLT-01…06, PLT-08, PLT-09; KSK-01, KSK-02, KSK-05, KSK-07; VOX-01, VOX-02, VOX-07; ENG-01, ENG-03, ENG-04, ENG-05, ENG-07; ING-01…05, ING-08; SCR-01, SCR-02, SCR-03; CRT-01, CRT-02, CRT-03; VAL-02; QA-02 (analytic); PRV-01…05, PRV-06a, PRV-07, PRV-08, PRV-11, PRV-12. Also: licensing and adaptation started, SKU shortlist, stakeholder expectation memo | Contracts and forward-compat tests green; kiosk → outbox → ingest idempotent through power cut and clock skew; consent property test; retention and minimal erasure live; **VAL-02 power report signed**; **dictionary v0 frozen**; Stage 1 IRB pack submitted | — |
| **M1 Pathway B core and Stage 1** | P6–P9 | KSK-03, KSK-04, KSK-06; ONB-01, ONB-02, ONB-04…08; VOX-03, VOX-06; ENG-06, ENG-08…11; MG-01…05, MG-10; SCR-04…07, SCR-09, SCR-11, SCR-12, SCR-13; QA-01, QA-03; CRT-08; ING-07 | Recovery targets (§9.2); ONB-08 budget sim; 60 s slice check; **Stage 1 (B) run at P8–P9**; exit gates §7.3; **v1-B frozen** | **Stage 1** |
| **M2 Criterion and validation backend** | P6–P10 | CRT-04…07, CRT-09, CRT-11; KSK-08, KSK-13; ENG-02; VOX-05; ING-06; VAL-01, VAL-03, VAL-04, VAL-06, VAL-15; PLT-07 | Pairing ≥ 95% in a dry run; ODK battery offline round-trip; pipeline end-to-end on synthetic data; SKU timing certified | Stage 2 prep |
| **M3 Pathway A, D substudy and pilot readiness** | P8–P11 | EPI-01…06; ENG-14; MG-06…09; SCR-08, SCR-10; VOX-04 (if the bake-off passes), VOX-08; KSK-09…12, KSK-14; ONB-03; CRT-10; REP-02; VAL-05, VAL-08a, VAL-12, VAL-13, VAL-14 (evaluate-only); PRV-06, PRV-09; QA-04, QA-05 | Episodes 3.3 ± 0.3 min; shared IDs; parallel-form equivalence; ASVS L2; E2E in 3 languages; 7-day offline; erasure drill; **Stage 1b (A) at P10–P11; v1-A frozen; pre-registration filed** | **Stage 1b** |
| **M4 Pilot (Stages 2–3) and unattended substudy** | P12–P18 | REP-01, REP-03 (built, gates closed); PRV-10; field operations. **Stage 2** P12–P16; **live dyads** P13–P16; **Stage 3** retests rolling P13–P17; **S4u open-public thank-you mode** P15–P18 | Stage 2 n per language reached; provisional flags; retest pairs ≥ 100 per language; **v2 frozen after Stage 3 (P18)** | **Stages 2–3** |
| **M5 Fairness, gates, limited release** | P17–P21 | VAL-07, VAL-08, VAL-09, VAL-16, VAL-18; PRV-13 (if required) | Invariance, DIF and mode reports; **battery gate evaluated**; if open in ≥ 2 languages, release packs enable bands **at supervised sites first**, then open public after VAL-18 | **Stage 4** |
| **M6 Stage 5 (partial) and close-out** | P20–P24 | VAL-10, VAL-11 (provisional norms), VAL-17, ENG-13 | Incremental validity on the supervised outcome subsample; provisional norms; final technical manual; data archive | **Stage 5 (partial)** |
| **Post-grant (PG)** | after P24 | VOX-09, ENG-12, MG-11, EPI-07, full weighted norms (1,500–2,000 per language), wave 2 | — | — |

**Critical path (mostly not code):** IRB approval for Stage 1 by P7; instrument licences and Indian-language adaptations by P11; native-speaker recording and audio QC; hardware procurement and timing certification by P10; field recruitment capacity (about 1,350 Stage 2 participants in 5 months means roughly 6 supervised sites × 45 per month).

**Outside the grant period:** full norms, the 22-language scale-out, Pathway C, the adaptive selector, the SSRT substudy and the wave-2 redesign. See §10.

---

## 9. Testing and quality strategy

### 9.1 Test pyramid

- **Unit:** Vitest (engine, scheduler, RNG, report evaluator, UI kit), pytest (scoring, ingest, keys), testthat (R).
- **Property-based:** fast-check and hypothesis for scheduler constraints, consent preconditions, **gate display rule**, mic-closed states, indicator invariants, report safety and idempotent ingest.
- **Model-based:** XState graph coverage of every session path.
- **Contract:** profile lint, Ajv/Pydantic parity, forward compatibility, Schemathesis, manifest diff for shared IDs.
- **Golden sessions:** fixed logs and expected indicators per dictionary version.
- **Parity:** TS preview scorer vs Python (1e-8); TS band evaluator vs Python (identical bands); R vs Python statistics (1e-6).
- **Statistical ACs:** exact count checks for deterministic generators; **TOST equivalence** with stated tolerances for stochastic ones. Never "p > .05".
- **E2E / HIL:** Playwright on Electron, nightly physical kiosk (timing rig, noise playback, power and network faults, printer).
- **Soak and load:** 72 h attract, 50-session audio, ingest at 50 kiosks.
- **Privacy:** audio scan, mic-track test, PII lint, span scanner, RLS matrix, erasure sweep, crypto-shred test, backup-restore drill.
- **Accessibility:** colour-vision simulation, target lint, manual audits.
- **Plan lint:** dependency graph check on this document (PLT-08).

### 9.2 Synthetic players and parameter recovery (QA-02)

**Generative model.** Latent traits for the 17 constructs, with nuisance factors: ability, motor speed, caution, ASR error, device familiarity, language, literacy, walkaway hazard. Response models:
- **diffusion model** for GNG and choice tasks (drift, boundary)
- hyperbolic chooser for discounting
- planning-depth agent for ToL and routes
- perseveration parameter for card sort
- softmax learner for Four Stalls
- conditional cooperation for public goods and dyads (including turn-taking)
- dishonesty propensity for dice and bribes
- tone choice with provocation sensitivity and a **mirroring** parameter
- location-scale parameters for the style traits

**Noise levels are set from published reliabilities** (e.g. GNG commission ≈ .6–.8, BART ≈ .7–.8, switch cost ≈ .3–.5, delay discounting ≈ .7–.8), so recovery is not just a check of the simulator's configuration.

**Gaming strategies:** always-share, speed-tapper, same-position tapper, over-reporter.

**Pass criteria:**
- **Recovery:** r(estimate, latent) ≥ √(simulated reliability) − .05 for every scored indicator at its minimum trial count.
- **Model-based reliability** of slope indicators is recovered within ±.05.
- **Planted DIF** is detected in ≥ 90% of 100 replications, with false-positive DIF at or below nominal on clean data (one target, shared with VAL-09).
- **Simulated retest** at .70 is estimated within ±.05 (ICC(A,1)), including a planted practice shift.
- **MTMM** recovers the planted own > discriminant pattern via the pattern statistic.
- The **gate** promotes only traits meeting thresholds, never promotes a trait with planted DIF, and **never opens the battery gate with only one passing language**.
- Gaming bots are flagged in ≥ 95% of their sessions.
- **CI scale:** per PR, 50 sessions per arm through headless engine and ingest, with analysis on cached fixtures (< 10 min). Nightly, 450 per language per arm through the full Dagster and R pipeline.

**Caveat (recorded in reports):** recovery shows that the pipeline is internally correct. It is **not** evidence that the games measure the traits. Only Stages 2–5 can show that.

### 9.3 Quality gates in CI

Lint, types, unit and property tests, profile and compat checks, plan lint, golden sessions, dictionary coverage, content completeness (every key in every enabled language; phrase × language), the §4.4 budget simulation, the 60 s slice check, security scans plus SBOM, the reduced recovery run and an E2E smoke test. Release promotion also requires the full E2E suite in 3 languages and a passing nightly hardware run.

---

## 10. Risks and mitigations

| Risk | Impact | Mitigation | Feature |
|---|---|---|---|
| **Schedule: about 20 months remain** (P5–P24) and the stages are sequential | Stages 4–5, norms and any player report may slip past project end | Overlapping milestones; Stage 1b in parallel with M2; retests rolling during Stage 2; norms explicitly provisional; post-grant items named; a monthly critical-path review | §8 |
| Effect sizes are small (task vs self-report r ≈ .05–.20) | Few or no traits pass | Lower-bound tests with no upper bound; literature-calibrated expectations; pattern statistics; `research_only` path; stakeholder memo in M0 | CRT-11, VAL-06, §7.8 |
| Difference-score unreliability (reliability paradox) | Composure, stability, adaptability fail | Hierarchical random slopes and diffusion parameters; model-based reliability; pre-registered `research_only` | SCR-06/09/10, VAL-04 |
| Session too short for 17 constructs | Low reliability | Trial-budget sheet in M0; 5 core modules + planned-missingness slot; Tier 1/2; A-only constructs; no upper trial cap | SCR-03, MG-10, VAL-02 |
| Underpowered per-language gates | Gates cannot pass | VAL-02 before IRB; 2 arms; pooling shared paradigms and languages with invariance; one primary hypothesis per construct | VAL-02, EPI-05 |
| Retest novelty loss and low n | Unstable ICC | Parallel forms, T1 level lock, 100 pairs per language, ICC(A,1) with an LB rule | ENG-14, CRT-10, VAL-05 |
| Criterion battery fatigue and non-equivalence | Noisy criteria, confounded cross-language validity | Core + rotating blocks (≤ 35 min); attention checks; criterion invariance as a prerequisite | CRT-02, VAL-08a |
| Unattended kiosks differ from supervised sites | Norms and gates do not transfer | S4u substudy; `site_mode` invariance; open-public gate blocked until VAL-18 passes | VAL-18 |
| Teamwork has no partner rating with scripted partners | Teamwork cannot pass gate 3 | Live-dyad substudy in Stage 2; interim criterion with a gate exception; capped at broad style | EPI-06, CRT-09 |
| Touch and audio latency variance | Invariance broken | Single SKU and OS; per-SKU offsets; jitter-based ACs; signed latency and barge-in; voice trials excluded from latency | ENG-01/02, VOX-01, VOX-04 |
| ASR not good enough in pilot languages | Fairness, delay | Touch-only P0; per-prompt opt-in after the bake-off; KWS alternatives | VOX-04/06 |
| Literacy and numeracy bias | DIF | Literacy measured; no required numerals; reading/digit-dependence exit gates; literacy in quotas and invariance | ONB-04, ENG-11, §7.3 |
| Cultural variants change the stimulus | Hidden DIF | One variant per language in the pilot; variants treated as forms | VOX-08, VAL-08/09 |
| DPDP: minors, erasure vs immutability, pre-consent audio | Legal and ethical breach | 18+ locked; DPIA; per-session crypto-shredding; no compliance lock; mic closed before consent; retention before Stage 1 | PRV-03/05/06/12, ING-08 |
| Kiosk clock errors | Duplicates, misordering | Server-date partitions, unpartitioned dedup, `(session_id, seq)` ordering, offset estimates | ING-02 |
| Offline kiosks cannot check gates | Reports unavailable or unsafe | Signed expiring release pack; fail closed | REP-03 |
| Integrity unmeasurable individually (mode a) | Invalid scores | Dice group-only; individual integrity from Weighing dilemmas only; restricted | MG-06, SCR-08 |
| Onlookers and coaching | Bias, privacy | Privacy film, headset, hide button, never-voice rule | KSK-05/12 |
| Over-engineering for a small team | Ops burden | One OS, ODK, Metabase, Cognito, CloudWatch, git-based governance, deferred selector, SIEM and hash chain | §1.5 |
| Version churn (Electron, TS 7, PG minors) | Instability | Major lines in the plan; pins verified in M0; TS 5/6 for builds; Renovate soak | PLT-08 |
| No report in Stages 1–3 lowers play-again | Engagement metric biased | Interpret with this caveat; "what this game is about" message; targets set with this known | REP-02, CRT-11 |
| Licences and translations late | Stage 2 delayed | Start in M0; tracker; prioritise block X instruments | CRT-02/03 |

---

## 11. Open questions and assumed defaults

Each question has a default (§1.4) so work is not blocked.

1. **Minimum age.** Default: 18+ everywhere, locked. Minors only after the PRV-12 preconditions.
2. **Which 3 pilot languages?** Default: hi-IN, mr-IN, ta-IN. This drives recording, ASR, scale adaptations and the ≥ 2-language battery gate.
3. **Supervised vs open kiosks per stage.** Default: Stages 1–3 supervised; open public in thank-you mode for S4u; open-public reports only after VAL-18.
4. **What decisions the report informs.** Default: personal reflection only. This sets gate strictness, whether integrity and risk are ever shown, and the Stage 5 outcome.
5. **Camera and voice tone.** Default: compiled out.
6. **Ethics decisions.** Defaults: dice mode (a), group level only; partners as "pretend helpers"; the ambient noise level measured only after consent, inside prompt windows.
7. **Governance.** Who are the psychometrics lead and the gate co-signers, who holds the HMAC pepper, and who is the DPO and grievance contact? Default: these roles are placeholders in PLT-09 and must be filled before the v0 freeze.
8. **Hardware.** Default: one Ubuntu Core-compatible SKU. Who services kiosks, and how often?
9. **Hosting mandate.** Default: AWS India regions, with portable containers (NIC, Yotta or E2E Networks remain possible).
10. **Stage 2 sample size.** Default: 450 per language (225 per arm), pending VAL-02. Is the recruitment capacity there?
11. **Pathway scope in the pilot.** Default: B_fixed vs A_narrative only; D as a supervised substudy; C post-grant.
12. **Project calendar.** Default: P1 = June 2026, project end P24 = May 2028. Please confirm, and confirm whether a no-cost extension is possible for Stage 5 norms.
13. **Risk-taking criterion item.** Default: included in block X.
14. **Teamwork interim criterion.** Default: BFI-2 Agreeableness plus an observed cooperation task, with a partner rating from live dyads. Is a confederate or a second participant acceptable for the observed task?

---

## Appendix A: feature counts

(Generated from the headers by `cicd/plan-lint`.)

| Area | P0 | P1 | P2 | PG | Total |
|---|---|---|---|---|---|
| PLT | 8 | 1 | 0 | 0 | 9 |
| KSK | 7 | 7 | 0 | 0 | 14 |
| VOX | 4 | 4 | 1 | 0 | 9 |
| ONB | 7 | 1 | 0 | 0 | 8 |
| ENG | 10 | 2 | 2 | 0 | 14 |
| MG | 6 | 4 | 1 | 0 | 11 |
| EPI | 0 | 6 | 1 | 0 | 7 |
| ING | 7 | 1 | 0 | 0 | 8 |
| SCR | 11 | 2 | 0 | 0 | 13 |
| CRT | 4 | 7 | 0 | 0 | 11 |
| VAL | 1 | 10 | 8 | 0 | 19 |
| REP | 0 | 3 | 0 | 0 | 3 |
| PRV | 10 | 3 | 1 | 0 | 14 |
| QA | 3 | 2 | 0 | 0 | 5 |
| **Total** | **78** | **53** | **14** | **0** | **145** |

By milestone: M0 44, M1 35, M2 17, M3 32, M4 3, M5 6, M6 4, PG 4.

The four post-grant features (VOX-09, ENG-12, MG-11, EPI-07) are listed as P2 with milestone PG. A dependency lint over all 145 headers found no cycles, no dependency on a later milestone and no dependency on a lower priority.

---

## Appendix B: review issues and where each is resolved

| Review issue | Resolution |
|---|---|
| Battery-level report gate | §1.1, §7.7 A, VAL-14 (property test), REP-01, REP-03 |
| Indicators dropped before retest | §7.1, §7.4, §7.5, VAL-12 (provisional, then final), SCR-01 freezes |
| Pilot arm design / criterion cohort contradiction | §1.4, EPI-05 (2 arms, both with criteria), MG-10 (fixed order, no Latin square), VAL-02 |
| Roadmap past project end | §8 (P4–P24), §10 schedule risk, §11 Q12 |
| Teamwork criterion unavailable | EPI-06 live dyads in Stage 2, CRT-09 interim criterion, §7.7 B3 exception |
| Supervised vs unattended transfer | VAL-18, VAL-08 groupings, §7.7 A4 |
| Wake word / pre-consent audio | KSK-03, PRV-03, VOX-04 |
| Phone number read aloud | ONB-03, KSK-05 never-voice rule, KSK-12 |
| Literacy-biased reminders | CRT-10 (IVR default, attrition by literacy) |
| Literacy not measured | ONB-04, SessionContext, CRT-07 quotas, VAL-08/09/16, SCR-12 |
| Device familiarity in gates | VAL-08 required groupings, §7.7 B4, VAL-06 covariates |
| Timeline does not add up | §4.4, ONB-05, ONB-08, ONB-03 moved after report |
| More than one trait per minute | ENG-04 slice check |
| B emotional regulation coverage | §4.2 (A-only, B withheld, exploratory B probe), VAL-13, §7.7 C |
| Mirroring index | EPI-01, SCR-09, ContentManifest tone attributes |
| Regional overlays as forms | VOX-08, VAL-08/09 |
| Numerals in Weighing Post | ENG-11, EPI-02, §7.3 exit gate |
| Stage 1 exit criteria | §7.3 (reading-dependent, cultural equivalence, gender quota) |
| Retention and erasure before Stage 1 | PRV-05, PRV-06a in M0 |
| Minors and DPDP | §1.4, ONB-02, PRV-12 |
| Real reports in think-aloud | REP-02 demo mode, CRT-08 |
| ASR alternatives logged | VOX-04, §6.1, §6.3 |
| Pathway C under-specified | EPI-07 |
| Pathway D indicators | EPI-06, SCR-08 |
| B shape (6–8 modules, 60–120 s) | §4.4, ENG-05, MG-10 |
| Trait classification | §4.1 |
| Construct count | 17 everywhere; SCR-03 CI check |
| Dictionary frozen after first collection | SCR-01 v0 before Stage 1, §7.1 |
| Completion and play-again criteria | CRT-11, VAL-03, VAL-13, VAL-15 |
| Camera enable path | §1.3, KSK-01, PRV-01 |
| Backend scope vs note | §1.2 scope note |
| Difference-score reliability | §4.3 rules, SCR-06/09/10, VAL-04 |
| Power and hypothesis count | VAL-02 (M0), CRT-11 primary family, VAL-06 pattern statistic |
| Measurement invariance approach | VAL-08 (trial-level explanatory IRT/GLMM), VAL-07, VAL-08a |
| DIF matching | VAL-09 |
| Split-half misapplied | §7.6 reliability table, VAL-04, SCR-01 `reliability_method` |
| 8–20 sample cap and SSRT | ENG-04, ENG-09, MG-02, MG-11, VAL-02 |
| Time budget infeasible / B coverage | §4.4, SCR-03, MG-10 planned missingness, §4.2 |
| Effect sizes / upper bound | §4.3, CRT-11, §7.7 B3, §7.8 |
| Retest power and novelty | CRT-10, ENG-14, ENG-10, VAL-05 |
| ICC form | VAL-05, §7.7 B1 |
| Disattenuation | VAL-06, §7.7 C |
| Norming feasibility | VAL-11, REP-01 SEM rule, §7.9 |
| Dice in individual validity | §4.3, MG-06, SCR-08 |
| Style-trait validity | SCR-10, §4.3 |
| Calibration-level non-equivalence | §1.4, ENG-10, SCR-11 |
| Criterion battery length | CRT-02, VAL-08a |
| Touch latency | ENG-01, ENG-02, ENG-06, §1.5 single OS |
| Audio latency and barge-in | ENG-01, VOX-01, KSK-14 |
| Partitioned-table idempotency | ING-02, §6.4 |
| Consent across batches, 426 handling | KSK-07, ING-02, ING-03 |
| S3 Object Lock vs erasure | ING-08, PRV-06, §6.4 |
| seq and resume semantics | KSK-02, KSK-07, ENG-07, ONB-06 |
| Offline gate and code sharing | REP-01, REP-03 |
| Tablet storage eviction | CRT-05 (ODK + Capacitor/SQLite) |
| Dependency cycles and inversions | PLT-08, re-sequenced deps (ONB-06→PRV-06a, PRV-01 static, CRT-08 manual linkage, REP-02 independent of REP-01, VAL-14 evaluate-only) |
| Dictionary freeze vs pathway build order | SCR-01 per-pathway v1, §7.1, KSK-11 wave covers retest |
| Version claims | §2.3 major lines, PLT-08 |
| ASR as P0 | VOX-04 now P1, touch-only P0 |
| Over-engineering | §1.5 simplifications, deferrals |
| Contract codegen fragility | PLT-02 |
| Meaningless statistical ACs | MG-01, MG-10, §9.1, §9.2, ING-06, SCR-13 |
| Report gate ambiguity | §7.7 display rule, `gates.yaml` frozen, REP-02 demo |
| Speed–accuracy | SCR-04, §4.3 |
| Self-declared age | PRV-12 |
