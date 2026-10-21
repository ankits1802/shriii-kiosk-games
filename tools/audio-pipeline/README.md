# Voice-over pipeline (VOX-02, VOX-07)

This tool turns native-speaker recordings into signed per-language voice packs for the kiosk's
`VoiceService` (`packages/kiosk-game/src/voice`). It also writes the voice actors' recording scripts.
`content/i18n/lines.yaml` is read only and never modified.

```
cd tools/audio-pipeline
python -m uv sync                                   # ffmpeg comes from imageio-ffmpeg if none is on PATH
python -m uv run shriii-audio keygen --key-id voice-pack-2026a --private ~/keys/voice.pem --public keys/voice.pub.json
python -m uv run shriii-audio scripts --language hi-IN --translations hi-IN=itc/hi-IN.yaml
python -m uv run shriii-audio check  recordings/
python -m uv run shriii-audio process recordings/ --key ~/keys/voice.pem --key-id voice-pack-2026a \
    --speaker hi-IN=spk-hi-01 --pack-version 0.2.0
python -m uv run shriii-audio verify --public keys/voice.pub.json
python -m uv run shriii-audio promote approvals.yaml --key ~/keys/voice.pem --key-id voice-pack-2026a
```

## What `process` does

The inputs are files named `<line_id>.<lang>.wav` (the director's pick) or
`<line_id>.<lang>.take<N>.wav`. When there is no plain file, the highest take that passes QC is used.
Each recording goes through these steps:

1. **Validate.** The line id must be in the catalogue, the language must be a catalogue language,
   and the format must be WAV at 44.1 kHz or more, mono or stereo.
2. **QC.** Check for clipping runs, peak level, DC offset, the noise floor and an SNR estimate (speech
   level minus noise floor, from frame percentiles).
3. **Trim.** Cut leading and trailing silence, keeping 120 ms before and 200 ms after the speech, with
   5 ms fades. Silence inside the utterance is never cut.
4. **Normalise.** Run a two-pass EBU R128 `loudnorm` to -16 LUFS with true peak at or below -1 dBTP,
   and encode straight to Opus (48 kHz mono, 48 kbps, bit-exact, so re-runs give identical sha256).
5. **Re-measure.** Measure the encoded file independently with `ebur128`. It must be within ±0.5 LU of
   the target and at or below -1 dBTP. If it misses, the encode is corrected once.
6. **Check duration.** Compare against the line's target (±15% gives a warning). A clip longer than
   1.5 times the en-IN clip, or the target when no en-IN clip exists, is flagged.

Every threshold is in `config/qc.yaml`, and the direction notes are in `config/direction.yaml`.

## Outputs (under `out/`)

- `packs/<lang>/<line_id>.opus` and `packs/manifest.<lang>.json`, in the `ContentManifest` format
  (`audio_clips`: key, language, file, sha256, duration_ms, speaker_id, take, script_version,
  review_state, loudness_lufs, true_peak_dbtp, voice_forbidden). The pack root is the kiosk's
  `baseUrl`.
- `packs/manifest.<lang>.sig.json`, an ed25519 signature over the exact manifest bytes
  (`algorithm`, `key_id`, `value`, `manifest_sha256`).
- `qc-report.html`, a self-contained QC report with waveforms, levels and issues.
- `recording-status.yaml`, which proposes `recording.status` and `itc_state` per line and language,
  with evidence (hashes and issues), for the VOX-07 workflow to merge into `lines.yaml`.
- `scripts/recording-script.<lang>.xlsx|html`, the studio sheet and a printable script with
  direction notes, timing window, pronunciation field and take boxes.

## Review states

A clip that passes QC enters the manifest as `audio_qc`. The later states `think_aloud_tested`,
`approved` and `flagged_for_revision` are bound to the clip's sha256 and set with `promote`, which
enforces the ITC order and re-signs the manifest. Re-recording a line resets it to `audio_qc`.
Production packs play only `approved` clips (see `playableState` in the kiosk).

## Tests

`python -m uv run pytest` uses synthetic tones and noise; the ffmpeg tests run the real binary.
