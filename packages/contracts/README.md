# @shriii/contracts

Canonical JSON Schema 2020-12 contracts (`schemas/*.v1.schema.json`) and everything generated from them.

| Contract | Schema |
|---|---|
| Event envelope v1 (54 event types, discriminated on `event_type`) | `event-envelope.v1.schema.json` |
| UploadBatch / UploadBatchResult (per-event statuses) | `upload-batch.v1`, `upload-batch-result.v1` |
| SessionContext | `session-context.v1` |
| ContentManifest, GameTrialSpec | `content-manifest.v1`, `game-trial-spec.v1` |
| CriterionResponse, CriterionScaleScore | `criterion-response.v1`, `criterion-scale-score.v1` |
| ConsentArtefact, ReportArtefact, ReleasePack | `consent-artefact.v1`, `report-artefact.v1`, `release-pack.v1` |
| Scoring dictionary (shared + pathway), hypotheses, gates | `scoring-dictionary-*.v1`, `hypotheses.v1`, `gates.v1` |
| Instrument, game config, session plan, voice-line catalogue | `instrument.v1`, `game-config.v1`, `session-plan.v1`, `voice-line-catalogue.v1` |

Shared definitions (UUIDv7, enums, bands, construct ids) are in `common.v1.schema.json`.

## Generated code (do not edit)

`pnpm --filter @shriii/contracts generate` writes `src/generated/`:

- `types.ts` (json-schema-to-typescript), `constants.ts` (enum tuples such as `EVENT_TYPES`, `CONSTRUCT_IDS`);
- `validators/<contract>.js` — Ajv **standalone** strict validators (`validateX`, writers: unknown fields
  rejected) and `validators/<contract>.reader.js` tolerant validators (`readX`, readers: minor N+1 fields
  accepted). No `eval` at runtime, so they work under a strict CSP. Size-sensitive code should import one
  module, e.g. `@shriii/contracts/validators/event-envelope`.

`pnpm --filter @shriii/contracts build` (and a test) fail when the generated code drifts from the schemas.
The generator also lints the restricted profile (no `if/then/else`, `unevaluated*`, `$dynamicRef`,
undiscriminated `oneOf`).

The Python mirror lives in `python/shriii_contracts` and validates the same `fixtures/`.

## Semantics beyond the schema

`src/invariants.ts` (mirrored in Python) checks what the profile cannot express: latency is null exactly on
timeouts, `barge_in` matches the latency sign, kiosk events carry null server fields, practice is never
scorable, sessions are gapless with non-decreasing `t_mono_ms`, voice vocabulary is a subset of the touch
vocabulary, and no contract has a `text`/`free_text`/`transcript`/`audio`/`asr_alternatives` field.
