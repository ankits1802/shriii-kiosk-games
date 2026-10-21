# ASR bake-off protocol (VOX-06, VOX-05)

Purpose: decide, per pilot language and per prompt, whether closed-vocabulary voice input may be offered
next to touch, and which engine drives it. Touch is always sufficient; when no engine passes, the pilot
runs touch only with no code change (the emitted language-pack config sets every prompt to
`voice_enabled: false`).

All thresholds live in `config/policy.yaml`. Conditions are in `config/conditions.yaml`, candidate
engines in `config/engines.yaml`, and vocabularies in `config/vocab.yaml`, which is a draft until
ITC review (VOX-07).

## 1. Data collection (real recordings)

- **Consent:** only under the separate, supervised `asr_eval` consent (PRV-05). Adults only. The
  dataset manifest must carry `kind: asr_eval`, `consent.protocol_id`, `consent.retention_days` and
  `consent.deletion_due`, and a pseudonymous `consent_id` for each speaker. The harness refuses to
  evaluate a dataset after its deletion date. Audio is stored encrypted at rest outside git. Delete it
  on the timer.
- **Speakers:** at least 30 held-out speakers per language (`sample.min_heldout_speakers`). Spread
  them across the age bands 18-29, 30-44, 45-59 and 60+, and across genders, with at least 5 speakers
  in every subgroup (`fairness.min_speakers_per_subgroup`). Add 8-12 further speakers per language
  with split `enroll`. Half of them supply templates for template engines; the other half are the
  calibration set used to place the confidence tiers. No speaker appears in two roles.
- **Material:** for each code, every accepted phrase in `config/vocab.yaml`, spoken as the speaker
  would answer the kiosk, at least twice. This gives at least 30 trials per code at the reference SNR
  (`sample.min_trials_per_code`). Add 4-6 out-of-vocabulary words per speaker, taken from the same
  semantic field (for example *maybe* or *later*), for the false-accept trials.
- **Recording:** use the kiosk SKU microphone at the kiosk position, 16 kHz mono or better, in a quiet
  room. The harness adds noise itself. Leave about 250 ms of silence around each utterance.
- **Noise:** record market noise at 75 dBA at the kiosk position (VOX-05), several minutes from more
  than one site. Put the WAVs in `data/noise/`. Without these files the synthetic market-noise
  generator is used, and the report flags the run as not valid for VOX-05.
- **Manifest:** `schemas/dataset.schema.json`. Each utterance has a speaker, a language, a kind
  (`keyword` or `oov`), a code (null for OOV) and a file path relative to the manifest.

## 2. Conditions

Each clean utterance is evaluated clean and mixed at 10, 5 and 0 dB SNR. SNR is the active speech
level (frames within 40 dB of the loudest, a simplified ITU-T P.56) over the noise RMS. The noise
offset is seeded by (run seed, utterance, SNR), so every engine hears byte-identical mixtures.
Keyword-free trials are market-noise windows at the level the same SNR implies for speech at
-20 dBFS, plus OOV words in noise. Each utterance is scored against every prompt whose vocabulary
contains its code. The candidate set is that prompt's closed vocabulary, never the whole lexicon.

## 3. Engines

| id | kind | notes |
|---|---|---|
| `dtw_mfcc` | template MFCC + DTW | Model-free floor that any candidate must beat. |
| `sherpa_kws_*` | sherpa-onnx zipformer KWS | Production path (`packages/asr-sherpa`). Uses a ladder of `keywords_threshold` tiers; the score is the strictest tier that fired. Needs a KWS model for the language (only an English stand-in is published upstream). |
| `whisper_*` | Whisper tiny/small, int8 ONNX via sherpa-onnx | Transcription matched to the vocabulary by edit similarity. Indic vowel signs are preserved. |
| `indicconformer_ctc` | ONNX CTC model + constrained decoding | Each phrase is scored with the CTC forward algorithm against a free-decoding garbage path. Export AI4Bharat IndicConformer's CTC head to ONNX: `model.onnx` and `tokens.txt` go in `models/indicconformer/<lang>/`. |

An engine without models or support for a language is reported with the reason; the run continues.

## 4. Metrics (held-out speakers only)

- **Accuracy by SNR:** correct proposals divided by keyword trials, at the engine's propose threshold,
  with Wilson 95% intervals. Rejections and the confusion matrix are reported.
- **False-accept rate:** keyword-free trials that produced any proposal, split by source (noise only,
  OOV) and SNR, with Wilson intervals.
- **Subgroups:** accuracy by age band and gender at the reference SNR. The gap is the maximum minus the
  minimum accuracy, in percentage points, over subgroups with enough speakers.
- **Cost:** decision latency (p50, p95, mean), real-time factor, CPU milliseconds per audio second and
  peak RSS, all on the host recorded in `results.host`. Repeat the run on the kiosk SKU before sign-off.
- **Calibration:** precision and recall at every score threshold on the calibration speakers. The
  propose threshold is the lowest threshold reaching `confidence_tiers.propose_min_precision`; the
  commit threshold is the lowest reaching `commit_min_precision`.

## 5. Policy (per prompt, per language)

A prompt is voice-enabled only if every check below holds. Otherwise it is touch only, and the reasons
are listed:

1. Accuracy at `accuracy.reference_snr_db` (10 dB) is at least `accuracy.min_accuracy` (0.90). The
   point estimate is used, or the lower CI bound when `judge_on: lower_ci`.
2. The age and gender gaps are at most `fairness.max_gap_pp` (5 pp), and every subgroup has enough
   speakers.
3. At least `sample.min_heldout_speakers` held-out speakers and `sample.min_trials_per_code` trials
   per code.
4. The false-accept rate at the reference SNR is at most `false_accepts.max_rate` (3%, VOX-05).
5. p95 latency is at most `latency.max_p95_ms`, and p95 RTF is at most `latency.max_rtf`.
6. A propose threshold exists.

**Winner per language:** the engine with the most voice-enabled prompts. Ties go to the higher
worst-prompt accuracy, then to the lower p95 latency. With no passing prompt the language runs touch
only.

## 6. Outputs

- `results-<run>.json` (`schemas/results.schema.json`)
- `trials-<run>.jsonl`, with one row per decision. It contains labels and scores, never audio and never
  top-k alternatives.
- `report-<run>.html`, a per-language report of accuracy by age, gender and SNR with CIs (VOX-06 AC).
- `asr-config/asr-config.<lang>.json` (`schemas/asr-config.schema.json`). This is the language-pack ASR
  config consumed by `packages/asr-sherpa` (`parseGrammar`): keyword token sequences, propose and commit
  tiers with calibrated confidences, per-prompt `voice_enabled`, runtime thresholds and provenance
  (run id, dataset, policy hash). Only a sherpa-onnx KWS winner yields voice-enabled prompts, because
  that is the engine the kiosk adapter runs. Any other outcome yields a touch-only config.

## 7. Running

```
cd tools/asr-bakeoff
python -m uv sync
python -m uv run shriii-asr-bakeoff synth --out data/synthetic        # rehearsal data (no TTS, no speech)
python -m uv run shriii-asr-bakeoff validate data/synthetic/dataset.json
python -m uv run shriii-asr-bakeoff run data/synthetic/dataset.json --out out/rehearsal
python -m uv run shriii-asr-bakeoff tokenize ../../packages/asr-sherpa/models/<kws>/bpe.model "yes" "no"
```

For a real run, point `run` at the `asr_eval` manifest, put the recorded noise in `data/noise/` and
fetch the models (`pnpm --filter @shriii/asr-sherpa fetch-models`, plus Whisper and IndicConformer
exports under `models/`). Then commit the emitted `asr-config.<lang>.json` to the language pack under
two-person review.

Synthetic placeholder results say nothing about real-speech accuracy. The report says so, and voice
must never be enabled from them.
