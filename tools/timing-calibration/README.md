# Timing calibration (ENG-01, ENG-02)

Per-SKU latency profiles for the kiosk. The **calibration page** (`web/`, Vite, standalone) runs on the
kiosk under test and logs page-clock timestamps. External sensors record the physical side and are imported
as CSV. The **analysis CLI** (`shriii-timing`, Python/uv) matches the two, estimates the constant offsets
and their jitter, applies the acceptance thresholds in [`config/thresholds.yaml`](config/thresholds.yaml)
and writes a versioned `timing_profile` JSON ([`schemas/timing-profile.v1.schema.json`](schemas/timing-profile.v1.schema.json)).

Its `timing_profile_version` is the value kiosks write into `versions.timing_profile_version` of every
event (contracts `event-envelope.v1`, `common.v1#/$defs/identifier`):

* certified: `tp-<sku>-<fingerprint8>-<data8>`
* not certified: `uncertified-<sku>-<fingerprint8>-<data8>`. The scoring engine already treats the
  `uncertified` prefix as an uncertified device (`device_uncertified_timing`, KSK-14 / SCR-12).

The fingerprint hashes SKU, OS build, firmware, shell, nominal refresh rate and audio output device. Any
change to one of them gives a new version (ENG-02 AC). The data hash covers the input files, options,
thresholds and tool version, so the same inputs always give the same profile.

## Quick start

```
cd tools/timing-calibration
uv sync
uv run shriii-timing synth --out demo                       # synthetic run with known truth
uv run shriii-timing analyse --capture demo/capture.json --photodiode demo/photodiode.csv \
    --tapper demo/tapper.csv --audio-rig demo/audio_rig.csv --sync demo/sync.csv --out profile.json
uv run shriii-timing validate profile.json
uv run shriii-timing compare baseline.json profile.json     # re-certification / emulator regression

cd web && pnpm install && pnpm dev                          # calibration page on http://localhost:5180
```

Exit codes: `analyse` 0 certified, 3 not certified; `compare` 4 on regression; 1 on input errors.

## Protocols

| Channel | Page logs (`capture.json`) | Rig / camera CSV | Latency (observed - reference) | Applied by ENG-01 |
|---|---|---|---|---|
| Visual (photodiode) | `visual.trials[].presented_ms`: the rAF after the commit that turned the patch white | `photodiode.csv`: `t_ms` rising edges | photodiode - presented | `presented_onset += visual.offset_ms` |
| Touch (solenoid tapper) | `touch.taps[].event_ts_ms` (`PointerEvent.timeStamp`) | `tapper.csv`: `t_ms` contact (switch or accelerometer) | event - contact | `PointerEvent.timeStamp -= touch.offset_ms` |
| Touch (high-speed camera) | as above, plus `flash_presented_ms` of the patch flashed on each pointerdown | `camera.csv`: `tap_index,contact_ms,photon_ms` (or `*_frame` with `--camera-fps`) | (photon - contact) - (flash - event) - display offset | same |
| Audio (rig mic) | `audio.clicks[].scheduled_perf_ms` (the AudioContext time mapped through `getOutputTimestamp`) | `audio_rig.csv`: `t_ms` onsets | mic - scheduled | `audio_onset`, `prompt_audio_end += audio.offset_ms` |
| Audio (in-page loopback) | `detected_ctx_s` from a line-out -> line-in cable, `input_latency_ms` | none | round trip - input latency | same |
| Frames | `frames.raf_ms` (every rAF timestamp) | none | interval jitter and dropped frames | `timing_flag` thresholds |

Practical notes:

* Run each protocol on its own, with the page otherwise idle and full screen. Keep the photodiode on the
  patch (top-left, default 120 px). Edges outside a run's time window are ignored when the channel is
  anchored.
* The flash and click schedules use jittered inter-stimulus intervals (250-450 ms visual, 300-600 ms
  audio) from the seed, so the sensor stream cannot alias with the refresh cycle and unanchored runs can be
  aligned by their pattern.
* The kiosk audio engine must map AudioContext time to the page clock the same way the page does
  (`AudioContext.getOutputTimestamp`); the audio offset is relative to that mapping.

### Clock anchoring

A constant offset needs both timestamps on one clock. Without that, the offset cannot be told apart from
the unknown rig clock offset, and the channel only measures jitter (`anchored: false`, no `offset_ms`).
`require_anchored: true` then blocks certification. There are three ways to anchor:

1. **Host <-> rig sync (recommended).** The page's *Sync over Web Serial* button writes `P<seq>\n` at
   115200 baud. The rig firmware replies `<seq> <device_us>\n` with its clock at reception. The pairs go
   into `capture.sync`, or you can pass the rig's own log as `--sync sync.csv`
   (`host_send_ms,host_recv_ms,device_ms`). The analysis keeps the lowest-RTT quarter and fits
   `device = a + b * host_mid`, which also removes rig clock drift. The median RTT/2 of the kept samples is
   reported as `sync_uncertainty_ms` and limited by `sync.max_uncertainty_ms`.
2. **Host-clock rig.** Pass `--rig-clock host` when the rig CSVs are already on the page clock.
3. **Common-clock methods.** The high-speed camera sees contact and photon on one clock (it also needs the
   display offset, taken from an anchored photodiode run or `--display-offset-ms`). The AudioContext
   loopback is anchored when the input track reports its latency.

## Statistics

* Matching: a coarse offset comes from the mode of the `observed - reference` differences in 1 ms bins
  (bounded to `[min_latency_ms, max_latency_ms]` when anchored). Then comes one-to-one nearest matching
  within `window_fraction_of_isi` x the shortest ISI (capped at `max_window_ms`), refined three times.
  Unmatched references count as misses and unmatched sensor edges as spurious.
* Anchored channels: `offset_ms` is the mean latency, `sd_ms` its SD, both with bootstrap 95% CIs (seeded).
  `drift_ppm` is the trend of latency over the run. `p99_abs_residual_ms` is the 99th percentile of the
  absolute deviation.
* Unanchored channels: a line over time absorbs the clock offset and drift, and the jitter is the residual SD.
* `confidence` comes from the offset CI half-width combined with the sync uncertainty
  (`confidence.high_ci_halfwidth_ms`, `confidence.medium_ci_halfwidth_ms`).
* Frames: intervals longer than `drop_threshold_periods` x the nominal period count as dropped frames
  (`round(interval / period) - 1` each). Interval SD is computed over the remaining intervals.

## Acceptance (from the plan, in `config/thresholds.yaml`)

* Visual: jitter SD <= 1 frame over >= 1,000 flashes (ENG-01 / ENG-02 rig AC); misses and spurious <= 1%.
* Touch: SD <= 15 ms (solenoid); >= 200 taps.
* Audio: output jitter SD <= 10 ms after offset correction; >= 200 clicks.
* Frames: >= 3,000 frames, dropped rate <= 0.5%, interval SD <= 2 ms.
* Every channel present and anchored.
* Regression (`compare`): offset shift <= 8 ms, SD ratio <= 1.5, dropped-rate increase <= 0.5 points.
  The emulator regression detects an injected 50 ms delay (`synth --inject-delay-ms 50`, tested).

## Tests

`uv run pytest` runs synthetic-truth tests: planted offsets and jitter are recovered, sync recovers clock
offset and drift, misses and spurious edges are handled, unanchored runs give jitter but no
certification, a firmware change makes a new version, the version matches the contract identifier
pattern, the 50 ms injection is flagged, and the CLI works end to end. `web/` has Vitest unit tests for
the schedule, frame summary, sync, onset detection and capture serialisation (`pnpm test`).
CI: `.github/workflows/tools-timing-replay.yml`.
