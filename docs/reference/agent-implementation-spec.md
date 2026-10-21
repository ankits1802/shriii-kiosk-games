# Complete Agent Implementation Specification (user-supplied, 2026-10-21)

SHRIII · Kiosk Behavioural Games · Research-grade psychometric validation

Based on the 15-page Kiosk Behavioural Games — Concept Note (21 Oct 2026). Implementation follows Pathway A (three linked narrative episodes) using Pathway B (independently testable micro-games) as underlying assessment mechanics; micro-games built first, then integrated into the narrative. Backend architecture, APIs, DB entities, dashboards, validation automation and stack below are engineering recommendations, not features specified in the concept note.

## 1. System architecture and application structure

One unified application with separate route groups and role-based access.

- Unified Web Application: Next.js frontend · API services · shared authentication
  - Kiosk: gameplay & consent
  - Research: studies & validation
  - Admin: operations & content
- Backend & Research Services: event ingestion · feature extraction · psychometric scoring · statistical validation
- Storage: PostgreSQL (structured), object storage (assets & snapshots), analytics (models & reports)

### Required routes

| Route | Features |
|---|---|
| `/kiosk` | Full-screen public game experience |
| `/kiosk/session` | Onboarding, consent, calibration |
| `/kiosk/play` | Linked game episodes |
| `/kiosk/results` | Validated participant report |
| `/research` | Research overview and dashboards |
| `/research/studies` | Studies, cohorts, recruitment |
| `/research/participants` | Pseudonymous participant records |
| `/research/instruments` | Psychometric battery management |
| `/research/traits` | Trait definitions and indicator mappings |
| `/research/validation` | Statistical validation workbench |
| `/research/models` | Predictive models and experiments |
| `/research/analytics` | Exploratory and longitudinal analytics |
| `/research/reports` | Scientific reports and exports |
| `/admin/games` | Game and trial configuration |
| `/admin/content` | Narratives, assets, translations |
| `/admin/kiosks` | Kiosk deployment and health |
| `/admin/settings` | Security, permissions, configuration |

## 2. Game modules and gameplay mechanics

One coherent village-market narrative, three connected episodes (concept note pp. 8–9):

- **Episode 1 — The Stall**: serve customers, distinguish items that should not be served, respond to time pressure, handle difficult interactions. Measures: self-control, emotional regulation, composure, expressive restraint.
- **Episode 2 — The Weighing Post**: weigh goods, approval decisions, respond to errors, accountability situations, ethical choices. Measures: integrity, judgement, decisiveness, risk preference (supplementary).
- **Episode 3 — The Road Home**: plan routes, manage limited resources, blocked roads, cooperate with a partner, adapt to changed rules. Measures: problem solving, planning, organisation, adaptability, teamwork, initiative, persistence.

(Reference images in the original were illustrative only, not approved assets.)

### Shared mechanics
- Unified player character, guide, environment, progression, visual language.
- Touch-first interactions with optional short voice responses.
- Practice trials before scored trials.
- Fixed difficulty tiers selected through calibration.
- Repeated comparable trials for each relevant indicator.
- Controlled condition changes for within-person comparisons.
- Deterministic trial generation from stored random seeds.
- Configurable trial counts, timing, stimulus sets, condition sequences.
- Local session recovery and interruption handling.
- No visible psychological trait scoring during gameplay.
- Trial-level event logging, including nonresponses.
- Game version and experimental condition tracking.

### Episode-specific mechanics
| Episode | Required micro-mechanics |
|---|---|
| The Stall | Go/No-Go, timed service rush, rude-customer sequence, response restraint, feedback recovery |
| The Weighing Post | Weighing decisions, ethical dilemmas, credit/blame decisions, bribe scenario, private-report task |
| The Road Home | Route optimisation, limited-resource planning, rule reversal, blocked-route adaptation, shared resource allocation, optional actions |

Private-report task: distinguish statistical evidence of aggregate reporting behaviour from evidence about an individual. A participant must never be classified as dishonest on the basis of an unverified private outcome.

## 3. Fifteen-trait measurement framework

Version-controlled **Trait Registry** linking each construct to gameplay evidence and criterion measures.

| Target trait | Primary game-derived indicators |
|---|---|
| 1. Self-control | Commission errors, premature actions, inhibition accuracy |
| 2. Emotional regulation | Changes in response behaviour after frustration, recovery trajectory |
| 3. Composure under pressure | Accuracy and latency changes under timed conditions |
| 4. Response consistency | Within-person variability across equivalent trials |
| 5. Task organisation | Task sequence, revisits, idle time, resource allocation |
| 6. Decisiveness | Decision latency, reversals, information sampling |
| 7. Adaptability/flexibility | Post-reversal errors, adaptation latency, perseveration |
| 8. Persistence of response style | Retry patterns, continued engagement, response-style stability |
| 9. Stability under situational change | Within-person differences across controlled conditions |
| 10. Expressive restraint vs spontaneity | Extra taps, premature responses, restraint patterns |
| 11. Teamwork | Sharing, cooperative decisions, partner-error responses |
| 12. Judgement/accountability | Credit/blame choices, responsibility acceptance, consistency |
| 13. Problem solving | Excess moves, solution efficiency, recovery after failure |
| 14. Integrity | Ethical choices, reporting behaviour, temptation responses |
| 15. Initiative and planning/organising | Optional actions, advance planning, proactive task execution |

Candidate indicators, not established trait scores; interpretation provisional until validated.

Each trait must have: stable construct ID; scientific definition & theoretical justification; primary/secondary indicators; ECD mapping (construct → evidence → task); expected relationships with criterion measures; feature extraction algorithms; required number of valid trials; scoring direction & transformation; missing-data & exclusion policies; reliability estimates; validity evidence; normative reference population; confidence/uncertainty estimates; version history & approval status.

**Important:** response consistency, persistence of response style and stability under change are modelled as repeated-measure properties, not automatically converted into independent personality dimensions.

## 4. Backend telemetry and behavioural feature engineering

### Event contract (illustrative)
```json
{
  "schema_version": "1.0",
  "event_id": "uuid",
  "session_id": "uuid",
  "participant_id": "pseudonymous-id",
  "study_id": "study-id",
  "game_id": "the-stall",
  "game_version": "1.0.0",
  "episode_id": "episode-1",
  "trial_id": "trial-008",
  "condition_id": "timed-rush",
  "stimulus_id": "stimulus-021",
  "stimulus_version": "1.0",
  "event_type": "response_submitted",
  "response": { "choice": "wait", "correctness": true, "latency_ms": 842, "input_mode": "touch" },
  "context": { "language": "hi", "difficulty_tier": 2, "trial_sequence": 8, "condition_sequence": 2, "device_id": "kiosk-001" },
  "timing": { "client_monotonic_ms": 184220.4, "client_timestamp": "2026-10-21T10:00:00Z", "server_received_at": null }
}
```
Server receipt time is populated by the backend.

### Engineering requirements
- Append-only raw event stream.
- Idempotent ingestion and deduplication.
- Per-session sequence numbers to detect missing events.
- Local buffering during connectivity loss; sync without losing trial ordering.
- Separate events for trial start, stimulus presentation, response, feedback, completion.
- Track client clock precision, frame stalls, input-device delays.
- Mark invalid reaction-time measurements.
- Record stimulus difficulty and experimental conditions.
- Raw data separate from derived metrics.
- Reproducible feature-extraction jobs; historical reprocessing after scoring algorithm updates.
- Event-schema validation and backward compatibility.

### Feature pipeline
Raw game events → data quality & trial eligibility → behavioural feature extraction → participant × occasion feature matrix → psychometric criterion matching → statistical validation & model evaluation.

## 5. Standardised psychometric battery module

Criterion battery is administered in supervised pilot settings, NOT during the public kiosk experience.

| Construct | Criterion |
|---|---|
| Big Five foundation | BFI-2-S or BFI-2-XS |
| Self-control | Brief Self-Control Scale |
| Emotional regulation & composure | ERQ, DERS-16 |
| Cognitive flexibility | Cognitive Flexibility Inventory, card-sorting performance |
| Persistence | Short Grit Scale |
| Integrity & judgement | HEXACO Honesty–Humility, moral-identity items |
| Decisiveness | General Decision-Making Style scale |
| Teamwork | Peer/partner rating following co-play |
| Problem solving & planning | Tower of London |
| Response-style traits | Test–retest and theoretical-pattern validation |

Implement: instrument registry with licensing metadata; item & response-scale config; questionnaire versioning; reverse coding & subscale computation; scoring algorithm versioning; researcher-administered mode; audio-assisted administration for low literacy; language-specific instrument versions; completeness & quality checks; controlled import of historical questionnaire datasets; CSV/XLSX import with column mapping & validation; participant identifier reconciliation; raw & normalised score storage; manual review of ambiguous imports; audit history for corrections & rescoring.

Do not treat measures as interchangeable; each validation specifies exact construct and expected relationship.

## 6. Backend-driven psychometric validation (central module)

For every participant completing both games and battery, build a matched analysis record (participant ID · study · occasion · instrument version · game version). Validation engine: reliability, construct validity, predictive validity, fairness & invariance, norming, uncertainty.

### 6.1 Reliability
Test–retest Pearson & appropriate ICC; split-half with corrections; internal consistency for coherent multi-item/multi-trial scales; alpha & omega where assumptions permit; trial-level variance decomposition; generalizability analysis across trials/occasions/conditions; reliability CIs; reliability by language, age band, education; by game & device version; learning/practice-effect detection. Retest r ≥ 0.60 is a configurable research threshold, not an automatic validity declaration.

### 6.2 Convergent & discriminant validity
Pearson & Spearman indicator–criterion correlations; full correlation matrices; convergent vs discriminant comparison; MTMM; partial correlations with justified covariates; CIs & bootstrap; multiple-comparison correction; effect sizes; construct-level evidence summaries. r ≈ .20–.40 is an expectation, not a universal acceptance threshold.

### 6.3 Factor analysis & construct structure
EFA; CFA; parallel analysis; loading visualisation; cross-loadings; competing structure comparisons; fit statistics; redundancy detection; whether 15 distinct dimensions are empirically supportable.

### 6.4 Predictive validity
Compare: (1) criterion scores from game features alone; (2) external outcomes from battery alone; (3) outcomes from game features alone; (4) outcomes from game + battery (incremental validity — most important). Regularised regression, tree-based, gradient boosting, hierarchical models. Report CV R², MAE, RMSE, uncertainty, incremental performance. Participant-grouped splits (no leakage); untouched holdout cohort for final confirmation.

### 6.5 Fairness & measurement equivalence
Language, literacy, age band, education band, gender (where consented/appropriate) comparisons; DIF; measurement invariance; differential prediction & calibration; group-wise reliability; device-familiarity effects; missingness/completion disparities; fairness review & approval workflow. Non-significant difference ≠ equivalence; use equivalence tests with adequate samples.

## 7. Researcher analytics dashboard
Participants/sessions/matched records; completion & abandonment; breakdowns by language, age, literacy, education; trial eligibility & data-quality distributions; feature distributions & outliers; per-trait reliability & validity evidence; criterion correlation heatmaps; scatterplots with regression & CIs; test–retest comparisons; factor loadings; model performance comparisons; group fairness; longitudinal trajectories; game version comparisons; exportable tables & figures. Example "Trait Validation Workbench" view: construct selector, criterion r, retest r, reliability target, cross-construct comparison bars (original example values were fabricated demo data).

## 8. Experiment & study management
| Stage | Indicative sample | System requirements |
|---|---|---|
| Think-aloud | 30–40 | Observation notes, comprehension issues, language feedback |
| Criterion pilot | 300–400 per language | Paired game & battery records |
| Retest | 100 pilot participants | Repeat sessions after 2–4 weeks |
| Fairness | Pooled pilot | Group comparisons & invariance |
| Criterion/norming | Larger field sample | External outcomes, norm construction |

Samples are indicative, not a substitute for formal power analysis. Implement: study creation & protocol versioning; eligibility/exclusion; enrollment & cohort assignment; stratified recruitment targets; condition allocation; randomisation & counterbalancing; sample-size/power records; study-specific game config; battery assignment; retest scheduling; protocol deviation tracking; observation forms; dataset freeze & lock; analysis-plan registration; study status & milestones; cross-study comparison.

## 9. Multilingual & accessibility
Language selection via spoken samples; native-speaker prerecorded instructions & narrative; large icons, high contrast; no mandatory reading/keyboard; touch alternative for every voice command; short constrained ASR; audio replay & volume; adjustable but experimentally controlled difficulty; clear practice trials; visual & auditory feedback; noise tolerance; translation & cultural adaptation workflows; language-version approval & testing; accessibility checks (motor, visual, hearing); input-modality logging to detect measurement effects. No speech tone, accent or facial expression as trait evidence without separately consented and validated protocol.

## 10. Participant reporting
- Research mode: detailed scores, statistics, uncertainty, quality flags, provisional indicators — authorised researchers only.
- Participant mode: only scientifically approved, strengths-framed descriptions.

Requirements: spoken summary in selected language; one-page picture summary; print or QR retrieval; broad descriptions not precise scores; "session snapshot" statement; no diagnostic claims; no unsupported character/moral judgements; separate archiving consent; versioned templates; report approval & withdrawal workflow; automatic suppression of traits lacking evidence. Public reports disabled until reliability, validity and fairness reviews complete (≥2 language groups).

## 11. Data governance & privacy
Pseudonymous IDs; separate identity and research-data storage; consent versioning & audit trails; independent consent for archiving & future contact; purpose limitation; configurable retention & deletion; withdrawal & erasure workflows; role-based & study-scoped permissions; encryption in transit/at rest; secure exports; audit logging; data-access approval workflows; no raw speech recording by default; no public exposure of records; age eligibility & legally appropriate consent; de-identified reporting & disclosure controls; DPDP compliance review.

## 12. Recommended technology stack
| Layer | Recommendation |
|---|---|
| Web application | Next.js, React, TypeScript |
| UI | Tailwind CSS, shadcn/ui |
| Game rendering | Phaser (2D) |
| Animation | GSAP |
| Backend APIs | FastAPI + Pydantic |
| Primary DB | PostgreSQL |
| DB access | SQLAlchemy, Alembic |
| Cache/queues | Redis |
| Background processing | Celery or comparable durable job system |
| Statistics | Python, SciPy, statsmodels |
| Psychometric modelling | semopy + specialised libraries |
| ML | scikit-learn, XGBoost, Optuna |
| Experiment tracking | MLflow |
| Research dashboards | React, ECharts or Plotly |
| Object storage | S3-compatible |
| Auth | OIDC provider with RBAC |
| Monitoring | OpenTelemetry, Prometheus, Grafana, Sentry |
| Testing | pytest, Vitest, Playwright |
| Deployment | Docker, CI/CD, IaC |

Modular services in one repo initially. No Kubernetes, event-streaming clusters or independently deployed microservices unless real requirements justify them.

## 13. Database design
| Domain | Core tables |
|---|---|
| Research | studies, protocol_versions, cohorts, enrollments, measurement_occasions |
| Participants | participants, consents, participant_links, withdrawals |
| Games | games, game_versions, episodes, trial_definitions, stimuli, conditions |
| Sessions | game_sessions, trials, events, session_quality_flags |
| Traits | constructs, indicators, feature_definitions, trait_mappings |
| Psychometrics | instruments, instrument_versions, items, responses, criterion_scores |
| Validation | dataset_snapshots, analysis_plans, validation_runs, statistical_results |
| Models | model_versions, training_runs, predictions, model_evaluations |
| Norming | reference_populations, norm_tables, score_interpretations |
| Reporting | report_templates, reports, report_approvals |
| Operations | kiosks, deployments, audit_logs, system_events |

Every derived score references algorithm version, source records, study and data snapshot.

## 14. APIs & background jobs
API groups (`/api/v1/...`): sessions; events/batch; games; participants; instruments; assessment-responses; features; validation/datasets; validation/runs; models; norms; reports; admin.

Jobs: event validation & dedup; trial eligibility; feature extraction; questionnaire scoring; participant-record matching; dataset snapshots; reliability; construct validity; fairness; model training & evaluation; norm generation; report preparation; kiosk sync & health. Each idempotent where practical, observable, retryable, traceable to inputs.

## 15. Testing & scientific QA
Unit tests for every feature calculation; golden datasets with independently verified outputs; reverse-scoring tests; correlation & reliability tests; synthetic participant matching tests; cross-participant leakage tests; randomisation reproducibility; offline sync tests; game timing accuracy; device/browser compatibility; language equivalence regression; statistical validation against trusted reference implementations; model train/test isolation; permission & erasure tests; E2E kiosk sessions; automated accessibility checks; load & recovery testing for unattended deployments. Psychometric numerics tested independently of the UI.

## 16. Implementation sequence
01 Research foundation (construct registry, evidence mappings, trial specs, study entities, consent model) → 02 Core micro-games (paradigms, calibration, deterministic trials, logging) → 03 Linked kiosk experience (3 episodes, voice + touch) → 04 Psychometric battery (administration, scoring, imports, matching) → 05 Validation infrastructure (features, reliability, construct validity, fairness, snapshots) → 06 Research analytics (dashboards, visualisations, cohorts, exports) → 07 Predictive modelling (leakage-safe evaluation, incremental validity, tracking) → 08 Field readiness (multilingual pilots, kiosk hardening, privacy, norming, report approval).

### Definition of done
1. Participant finishes kiosk experience within target time.
2. Every scored indicator reconstructable from versioned raw events.
3. Every psychometric score reconstructable from responses + scoring rules.
4. Game & battery records matched correctly at participant × occasion level.
5. Reproducible reliability, validity, fairness analyses.
6. Statistical outputs include N, uncertainty, exclusions, provenance.
7. Predictive models evaluated on participant-independent holdout.
8. Unvalidated traits flagged and excluded from public reports.
9. Research data protected, auditable, consent-governed.
10. All critical scientific computations have automated tests vs reference results.

**Final instruction:** treat the system as a scientific measurement instrument first and a game second. Preserve the exact 15-construct framework, build micro-game paradigms as independently testable modules, make backend-driven psychometric validation first-class. Keep **five distinct layers**: raw behaviour, behavioural indicators, psychometric criterion scores, validated trait estimates, participant-facing interpretations.
