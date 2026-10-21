# @shriii/asr-sherpa

This package is the closed-vocabulary, opt-in-per-prompt `SpeechInput` for the kiosk (VOX-04, VOX-05).
Touch always works without it.

## Engine choice (evaluated 2026-10)

| npm package | What it is | Verdict |
|---|---|---|
| `sherpa-onnx-node` 1.13.8 | N-API addon. Prebuilt for win-x64, linux-x64/arm64 and macOS, with keyword spotting, Silero VAD and streaming ASR | **Used** (Node, Electron main or utility process). Loads on Node 24 / Windows 11, and the real-model smoke test passes. Keyword lists are passed in memory (`keywordsBuf`). There are no per-stream lists, so each session filters hits by vocabulary. |
| `sherpa-onnx` 1.13.8 | WASM build (browser and Node) | Possible renderer-only fallback. Its KWS needs a custom WASM build with the model baked in, which is not adopted here. |

The addon also contains TTS classes. The adapter never imports them, and `test/audit.test.ts`
enforces that, together with no storage, network sinks, MediaRecorder or top-k alternatives.

No Indic KWS model is published upstream. The bake-off (`tools/asr-bakeoff`) decides per language
and per prompt whether voice is enabled. The language pack's `asr-config.<lang>.json` carries the
token sequences, confidence tiers and verdicts.

## Behaviour

- `isAvailable(promptId)` requires all of the following: policy `asr_enabled`, core consent, a
  prompt marked `voice_enabled` by the bake-off, a prepared engine, and a session that has not
  switched to touch only because of noise. Consent, opt-ins, bands and private reports are touch
  only by rule.
- `listen()` opens the microphone, runs the VAD on that window's frames only, and feeds the engine
  speech plus a 300 ms pre-roll. It closes the mic before resolving, on detection, window close
  (AbortSignal), the `max_listen_ms` cap, noise or error.
- **Confidence** comes from a ladder of `keywords_threshold` tiers, one spotter per tier. The
  confidence is the calibrated precision of the strictest tier that fired. Results below
  `min_propose_confidence` and ambiguous hits (two codes on the same tier) return nothing.
- **Always mirrored by an icon:** proposals can only name codes that are both in the caller's
  vocabulary and in the prompt grammar. `onProposal` lets the UI highlight the matching icon.
  `classifyProposal()` decides between propose (tap to confirm) and commit (high confidence, and
  only when no confirm tick is required). `assertVoiceSubset()` is the VOX-04 CI check that voice
  options are a subset of touch options.
- **Noise (VOX-05):** the first window's non-speech median level becomes `noiseDbfs`, which is logged
  as `env.noise_dbfs`. Above `noise_max_dbfs` the session switches to touch only.
- **No audio retained:** each frame is zero-filled after use and the pre-roll ring is wiped at window
  close. Engine sessions are disposed. With the engine in another process, the host zero-fills every
  transferred buffer (`serveKeywordEngine` / `RemoteKeywordEngine`).

## Topology

- **Electron:** the renderer runs `KeywordSpeechInput`, `WebAudioMicSource` (`/web`) and
  `RemoteKeywordEngine` over a `MessagePort`. The main or utility process runs `serveKeywordEngine`
  with `SherpaKeywordEngine` (`/sherpa`).
- **Node tools and tests:** use `SherpaKeywordEngine` directly with `ArrayFrameSource`.

## Tests

`pnpm test` runs the mock-backed suite (adapter, VAD, ring buffer, grammar, remote engine, web mic
with fakes, audit). `pnpm fetch-models` downloads the 3.3M-parameter English KWS model and Silero VAD
(sha256-pinned) to `models/` (git-ignored), and `test/smoke.real-model.test.ts` then runs the native
addon end to end. Without the models it is skipped.
