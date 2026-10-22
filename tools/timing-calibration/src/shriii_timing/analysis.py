"""Clock sync, event matching and per-channel latency statistics.

Conventions: every latency is ``observed - reference`` on one clock, in milliseconds.

* visual: reference = page ``presented_ms`` (rAF after commit), observed = photodiode edge;
* touch (tapper): reference = solenoid contact, observed = ``PointerEvent.timeStamp``;
* audio (rig): reference = scheduled onset on the page clock, observed = rig microphone onset;
* audio (loopback): reference = scheduled AudioContext time, observed = loopback detection minus the
  reported input latency.

A channel is *anchored* when both times are on a common clock (a host<->rig sync, a host-clock rig, a
common-clock camera or the AudioContext loopback with a known input latency). Unanchored channels give
jitter only: the constant offset is indistinguishable from the unknown clock offset.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from numpy.typing import NDArray

from shriii_timing.resources import Thresholds

FloatArray = NDArray[np.float64]
Method = Literal["photodiode", "solenoid_tapper", "high_speed_camera", "audio_loopback", "audio_rig"]


# --------------------------------------------------------------------------------------------- clock sync


@dataclass(frozen=True, slots=True)
class ClockMap:
    """Linear map between the rig clock and the page clock: ``device = a + b * host``."""

    a: float
    b: float
    uncertainty_ms: float
    n_used: int
    n_total: int

    def to_host(self, device_ms: FloatArray) -> FloatArray:
        return (device_ms - self.a) / self.b

    @property
    def drift_ppm(self) -> float:
        return (self.b - 1.0) * 1e6


def fit_clock_sync(host_send: FloatArray, host_recv: FloatArray, device: FloatArray, keep_quantile: float) -> ClockMap:
    """NTP-style ping-pong sync: keep the lowest-RTT samples, fit ``device = a + b * host_mid``.

    The rig timestamps each ping on arrival and echoes it; with symmetric USB latency the device time
    corresponds to the host midpoint. Asymmetry is bounded by RTT/2, reported as the uncertainty."""
    send = np.asarray(host_send, dtype=float)
    recv = np.asarray(host_recv, dtype=float)
    dev = np.asarray(device, dtype=float)
    ok = np.isfinite(send) & np.isfinite(recv) & np.isfinite(dev) & (recv >= send)
    send, recv, dev = send[ok], recv[ok], dev[ok]
    if send.size < 3:
        raise ValueError("clock sync needs at least 3 valid ping-pong samples")
    rtt = recv - send
    cut = float(np.quantile(rtt, keep_quantile))
    keep = rtt <= cut
    if int(keep.sum()) < 3:
        keep = np.argsort(rtt)[:3]
    mid = (send[keep] + recv[keep]) / 2.0
    if np.ptp(mid) <= 0:
        a, b = float(np.median(dev[keep] - mid)), 1.0
    else:
        b, a = (float(x) for x in np.polyfit(mid, dev[keep], 1))
    return ClockMap(
        a=a, b=b, uncertainty_ms=float(np.median(rtt[keep]) / 2.0), n_used=int(np.size(mid)), n_total=int(send.size)
    )


# --------------------------------------------------------------------------------------------- matching


@dataclass(frozen=True, slots=True)
class MatchResult:
    ref_idx: NDArray[np.int64]
    obs_idx: NDArray[np.int64]
    n_ref: int
    n_obs: int
    window_ms: float

    @property
    def n_matched(self) -> int:
        return int(self.ref_idx.size)

    @property
    def missed_rate(self) -> float:
        return 0.0 if self.n_ref == 0 else (self.n_ref - self.n_matched) / self.n_ref

    @property
    def spurious_rate(self) -> float:
        return 0.0 if self.n_ref == 0 else (self.n_obs - self.n_matched) / self.n_ref


def _mode_of_differences(diffs: FloatArray, bin_ms: float = 1.0) -> float:
    if diffs.size == 0:
        raise ValueError("no candidate pairs to align reference and observed events")
    bins = np.round(diffs / bin_ms).astype(np.int64)
    values, counts = np.unique(bins, return_counts=True)
    # Smooth over +-1 bin so jitter does not split the peak.
    order = np.argsort(values)
    values, counts = values[order], counts[order]
    smooth = counts.copy()
    smooth[1:] += counts[:-1] * (values[1:] - values[:-1] == 1)
    smooth[:-1] += counts[1:] * (values[1:] - values[:-1] == 1)
    centre = int(values[int(np.argmax(smooth))])
    near = np.abs(bins - centre) <= 2
    return float(np.median(diffs[near]))


def coarse_offset(ref: FloatArray, obs: FloatArray, lo: float | None, hi: float | None) -> float:
    """Most frequent ``obs - ref`` difference (1 ms bins). Bounded to ``[lo, hi]`` when anchored."""
    ref = np.sort(ref)
    obs = np.sort(obs)
    if lo is not None and hi is not None:
        parts: list[FloatArray] = []
        starts = np.searchsorted(obs, ref + lo, side="left")
        ends = np.searchsorted(obs, ref + hi, side="right")
        for r, s, e in zip(ref, starts, ends, strict=True):
            if e > s:
                parts.append(obs[s:e] - r)
        return _mode_of_differences(np.concatenate(parts) if parts else np.empty(0))
    sub = ref[: min(ref.size, 400)]
    return _mode_of_differences((obs[None, :] - sub[:, None]).ravel())


def match_events(ref: FloatArray, obs: FloatArray, predicted: FloatArray, window_ms: float) -> MatchResult:
    """One-to-one nearest matching of observed events to predicted positions (``predicted[i]`` for
    ``ref[i]``) within ``window_ms``. On a conflict the closer pair wins."""
    obs_sorted_idx = np.argsort(obs)
    obs_sorted = obs[obs_sorted_idx]
    best: dict[int, tuple[float, int]] = {}
    for i, p in enumerate(predicted):
        if not np.isfinite(p) or obs_sorted.size == 0:
            continue
        k = int(np.searchsorted(obs_sorted, p))
        cands = [j for j in (k - 1, k) if 0 <= j < obs_sorted.size]
        j = min(cands, key=lambda c: abs(obs_sorted[c] - p))
        dist = abs(float(obs_sorted[j]) - float(p))
        if dist > window_ms:
            continue
        prev = best.get(j)
        if prev is None or dist < prev[0]:
            best[j] = (dist, i)
    pairs = sorted((i, int(obs_sorted_idx[j])) for j, (_, i) in best.items())
    ref_idx = np.array([p[0] for p in pairs], dtype=np.int64)
    obs_idx = np.array([p[1] for p in pairs], dtype=np.int64)
    return MatchResult(ref_idx=ref_idx, obs_idx=obs_idx, n_ref=int(ref.size), n_obs=int(obs.size), window_ms=window_ms)


def matching_window(ref: FloatArray, th: Thresholds) -> float:
    srt = np.sort(ref[np.isfinite(ref)])
    gaps = np.diff(srt)
    gaps = gaps[gaps > 0]
    w = th.f("matching.max_window_ms")
    if gaps.size:
        w = min(w, th.f("matching.window_fraction_of_isi") * float(np.min(gaps)))
    return w


def align_and_match(
    ref: FloatArray, obs: FloatArray, *, anchored: bool, th: Thresholds
) -> tuple[MatchResult, FloatArray]:
    """Coarse offset by difference histogram, then iterative matching against a constant offset
    (anchored) or a linear clock model (unanchored, absorbs rig clock drift).

    Returns the match and the observed array its ``obs_idx`` index into: finite values and, when
    anchored, only those inside the run's plausible window (edges from other protocols are ignored)."""
    ref = np.asarray(ref, dtype=float)
    obs = np.asarray(obs, dtype=float)
    obs = obs[np.isfinite(obs)]
    window = matching_window(ref, th)
    lo, hi = (th.f("matching.min_latency_ms"), th.f("matching.max_latency_ms")) if anchored else (None, None)
    finite_ref = ref[np.isfinite(ref)]
    if lo is not None and hi is not None and finite_ref.size:
        obs = obs[(obs >= finite_ref.min() + lo - window) & (obs <= finite_ref.max() + hi + window)]
    if obs.size == 0 or finite_ref.size == 0:
        return match_events(ref, obs, ref, window), obs
    off = coarse_offset(finite_ref, obs, lo, hi)
    m = match_events(ref, obs, ref + off, window)
    for _ in range(3):
        if m.n_matched < 3:
            break
        d = obs[m.obs_idx] - ref[m.ref_idx]
        if anchored:
            pred = ref + float(np.median(d))
        else:
            slope, icpt = np.polyfit(ref[m.ref_idx], obs[m.obs_idx], 1)
            pred = icpt + slope * ref
        m = match_events(ref, obs, pred, window)
    return m, obs


# --------------------------------------------------------------------------------------------- statistics


def _bootstrap_ci(values: FloatArray, stat: str, th: Thresholds) -> tuple[float, float]:
    rng = np.random.default_rng(th.i("bootstrap.seed"))
    n = values.size
    reps = th.i("bootstrap.resamples")
    idx = rng.integers(0, n, size=(reps, n))
    samples = values[idx]
    est = samples.mean(axis=1) if stat == "mean" else samples.std(axis=1, ddof=1)
    lo, hi = np.quantile(est, [0.025, 0.975])
    return float(lo), float(hi)


def channel_stats(
    latencies: FloatArray,
    ref_times: FloatArray,
    *,
    method: Method,
    anchored: bool,
    n_reference: int,
    missed_rate: float,
    spurious_rate: float,
    period_ms: float | None,
    sync_uncertainty_ms: float | None,
    th: Thresholds,
) -> dict[str, Any]:
    """Offset, jitter and confidence of one channel (the ``channel`` object of timing-profile.v1).

    Anchored: offset = mean latency; jitter = SD about it; drift = trend of latency over the run.
    Unanchored: the latency still contains the clock offset and drift, so a line is fitted over time and
    the jitter is the residual SD; no offset is reported."""
    lat = np.asarray(latencies, dtype=float)
    t = np.asarray(ref_times, dtype=float)
    ok = np.isfinite(lat) & np.isfinite(t)
    lat, t = lat[ok], t[ok]
    n = int(lat.size)
    base: dict[str, Any] = {
        "method": method,
        "anchored": anchored,
        "n_reference": int(n_reference),
        "n_matched": n,
        "missed_rate": round(float(missed_rate), 6),
        "spurious_rate": round(float(spurious_rate), 6),
        "offset_ms": None,
        "offset_ci95_ms": None,
        "sd_ms": None,
        "sd_ci95_ms": None,
        "sd_frames": None,
        "p99_abs_residual_ms": None,
        "drift_ppm": None,
        "sync_uncertainty_ms": None if sync_uncertainty_ms is None else round(sync_uncertainty_ms, 4),
        "confidence": "none",
    }
    if n < 3:
        return base
    slope, icpt = (float(x) for x in np.polyfit(t, lat, 1)) if np.ptp(t) > 0 else (0.0, float(lat.mean()))
    if anchored:
        resid = lat - lat.mean()
        sd = float(lat.std(ddof=1))
        sd_ci = _bootstrap_ci(lat, "sd", th)
        off = float(lat.mean())
        off_ci = _bootstrap_ci(lat, "mean", th)
        half = (off_ci[1] - off_ci[0]) / 2.0
        eff = float(np.hypot(half, sync_uncertainty_ms or 0.0))
        if eff <= th.f("confidence.high_ci_halfwidth_ms"):
            conf = "high"
        elif eff <= th.f("confidence.medium_ci_halfwidth_ms"):
            conf = "medium"
        else:
            conf = "low"
        base.update(
            offset_ms=round(off, 4),
            offset_ci95_ms=[round(off_ci[0], 4), round(off_ci[1], 4)],
            confidence=conf,
        )
    else:
        resid = lat - (icpt + slope * t)
        sd = float(np.sqrt(np.sum(resid**2) / max(n - 2, 1)))
        sd_ci = _bootstrap_ci(resid, "sd", th)
    base.update(
        sd_ms=round(sd, 4),
        sd_ci95_ms=[round(sd_ci[0], 4), round(sd_ci[1], 4)],
        sd_frames=None if not period_ms else round(sd / period_ms, 4),
        p99_abs_residual_ms=round(float(np.quantile(np.abs(resid), 0.99)), 4),
        drift_ppm=round(slope * 1e6, 3),
    )
    return base


def frame_stats(raf_ms: FloatArray, nominal_hz: float | None, th: Thresholds) -> dict[str, Any] | None:
    """Frame-time jitter and dropped frames from consecutive rAF timestamps."""
    t = np.asarray(raf_ms, dtype=float)
    t = t[np.isfinite(t)]
    if t.size < 3:
        return None
    iv = np.diff(np.sort(t))
    iv = iv[iv > 0]
    measured_period = float(np.median(iv))
    period = 1000.0 / nominal_hz if nominal_hz else measured_period
    thr = th.f("frames.drop_threshold_periods") * period
    long = iv > thr
    dropped = int(np.sum(np.maximum(np.round(iv[long] / period) - 1, 1))) if long.any() else 0
    normal = iv[~long]
    return {
        "refresh_hz": round(1000.0 / measured_period, 4),
        "period_ms": round(period, 4),
        "n_frames": int(t.size),
        "interval_mean_ms": round(float(iv.mean()), 4),
        "interval_sd_ms": round(float(normal.std(ddof=1)) if normal.size > 1 else 0.0, 4),
        "interval_p99_ms": round(float(np.quantile(iv, 0.99)), 4),
        "dropped_frames": dropped,
        "dropped_rate": round(dropped / (iv.size + dropped), 6),
        "long_frames": int(long.sum()),
    }
