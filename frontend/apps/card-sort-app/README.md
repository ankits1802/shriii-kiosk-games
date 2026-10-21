# @shriii/card-sort-app: criterion card sort (supervised sites only)

A trained administrator runs this WCST-style card sort on a tablet as the **criterion** for
adaptability and flexibility (plan CRT-02, CRT-05, CRT-09; BUILD_DECISIONS "Criterion
capture"). It never runs at a public kiosk: the registry entry
(`content/instruments/card-sort-criterion.yaml`) sets `public_kiosk_allowed: false`, and every
record is sent with `site_mode: supervised`.

Stack: Capacitor 8 + Vite + React 19 + TypeScript. Storage is SQLite on the tablet
(`@capacitor-community/sqlite`) and IndexedDB in a browser build, which the tests and the
Playwright smoke use.

## Administration flow

1. **Administrator PIN** (6-12 digits, PBKDF2-SHA256). Five wrong attempts lock the app for
   60 s. Admin screens lock after 5 minutes idle.
2. **Device settings**: administrator id, device id, default study, language, API URL, device
   token (`kdt_…`) and the installed audio version.
3. **New administration**: participant pid from the QR card (camera, `BarcodeDetector`) or
   typed. The Crockford base32 + Luhn mod-32 check character rejects typing errors (same
   algorithm as `backend/api/.../security.py`). Also chosen here: study, occasion, wave,
   instruction language, and the protocol (64 or 128 cards).
4. **Instructions**: plays the language-specific spoken instruction slot, or shows the script
   for the administrator to read aloud.
5. **Test** (participant): four large key cards and one response card. Pictures only, nothing
   to read. A tick or cross with a tone gives feedback after each tap. Each trial is written to
   storage before the next card appears. A hidden 1.5 s long-press in the top-right corner
   opens the PIN-gated pause/stop panel.
6. **End**: a pictorial "give the tablet back" screen, then a PIN-gated summary that shows no
   scores (layer 3 scores are computed server-side).

An administration interrupted by an app restart can be resumed. Its stored trials are replayed
against the fixed deck.

## Protocol (`src/domain/protocol.ts`)

The standard deck is the 64 colour × shape × number combinations in a fixed seeded order (two
decks for 128). The rule sequence is configurable and defaults to colour → shape → number ×2. A
category completes after 10 consecutive correct sorts. The test stops after 6 categories or
when the deck runs out.

## Scoring (`src/domain/scoring.ts`, Heaton et al. 1993)

Scoring is recomputed from raw responses and covers:

- categories completed
- perseverative responses and perseverative errors: the perseverated-to principle is set by
  the first unambiguous error in category 1 and then by the previous category's rule; the
  three-consecutive-error principle change and the sandwich rule for ambiguous responses are
  both applied
- non-perseverative errors
- "other" responses
- failure to maintain set (an error after 5 or more correct, before the category completes)
- trials to complete the first category
- conceptual-level responses

The worked examples in `test/scoring.test.ts` are hand-scored trial by trial.

## Records and sync (`src/sync/`)

When an administration completes, the app builds:

- `CriterionResponse` rows (contracts v1) for the measures registered on
  `card_sort_criterion.session`: `perseverative_errors`, `categories_completed` and
  `trials_administered`. A unit test keeps this list equal to the registry.
- `CriterionScaleScore` rows for the registry subscales plus the extended Heaton measures.
  These are kept on the device and in the JSON export, because the server rescores layer 3.
- the `AdministrationIn` body for `POST /api/v1/assessment-responses` (`backend/api/openapi.json`).

All records pass the generated strict contract validators before they are queued.

The outbox retries network failures, 408/425/429 and 5xx responses with capped exponential
backoff. Any other 4xx (for example missing consent or an unapproved language version) marks
the item `rejected` until the administrator taps Retry. Before re-sending an item that was
already attempted, the app GETs the administration's stored responses, so a lost 201 never
creates a duplicate. An `Idempotency-Key` header is sent as well. Aborted administrations stay
on the device and are never synced.

Every security- and data-relevant action goes into an append-only, SHA-256 hash-chained
**audit trail**. Database triggers block UPDATE/DELETE on the audit and trial tables. The
administrator can verify the chain from the Audit trail screen.

## Commands

```sh
pnpm --filter @shriii/card-sort-app dev        # browser dev server (IndexedDB storage)
pnpm --filter @shriii/card-sort-app test       # unit tests
pnpm --filter @shriii/card-sort-app build      # web bundle -> dist/
pnpm --filter @shriii/card-sort-app test:e2e   # Playwright smoke against vite preview
```

The Android project is generated in CI and not committed (`.github/workflows/card-sort-app.yml`
runs `cap add android`, `scripts/prepare-android.mjs` for the camera permission and
`allowBackup=false`, `cap sync`, then `./gradlew assembleDebug`). The workflow uploads an
unsigned debug APK as an artifact.
