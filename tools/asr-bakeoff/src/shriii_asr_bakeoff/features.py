"""Log-mel / MFCC features, energy trimming, DTW and CTC scoring (numpy only)."""

from __future__ import annotations

import math

import numpy as np
import numpy.typing as npt

from shriii_asr_bakeoff.audio import RATE, Audio

F64 = npt.NDArray[np.float64]


def mel_filterbank(n_mels: int, n_fft: int, rate: int = RATE, fmin: float = 0.0, fmax: float | None = None) -> F64:
    fmax = fmax or rate / 2

    def hz_to_mel(f: F64 | float) -> F64:
        return np.asarray(2595.0 * np.log10(1.0 + np.asarray(f) / 700.0), dtype=np.float64)

    def mel_to_hz(m: F64) -> F64:
        return np.asarray(700.0 * (10 ** (m / 2595.0) - 1.0), dtype=np.float64)

    mels = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    bins = np.floor((n_fft + 1) * mel_to_hz(mels) / rate).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for i in range(1, n_mels + 1):
        left, center, right = bins[i - 1], bins[i], bins[i + 1]
        center = max(center, left + 1)
        right = max(right, center + 1)
        fb[i - 1, left:center] = (np.arange(left, center) - left) / (center - left)
        fb[i - 1, center:right] = (right - np.arange(center, right)) / (right - center)
    return fb


def log_mel(
    x: Audio, *, n_mels: int = 80, win_ms: float = 25.0, hop_ms: float = 10.0, n_fft: int = 512, preemph: float = 0.97
) -> F64:
    """(frames, n_mels) natural-log mel energies."""
    win = round(RATE * win_ms / 1000)
    hop = round(RATE * hop_ms / 1000)
    y = np.append(x[:1], x[1:] - preemph * x[:-1]).astype(np.float64)
    if y.size < win:
        y = np.pad(y, (0, win - y.size))
    n = 1 + (y.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = y[idx] * np.hamming(win)[None, :]
    power = np.abs(np.fft.rfft(frames, n=n_fft)) ** 2
    mel = power @ mel_filterbank(n_mels, n_fft).T
    return np.log(np.maximum(mel, 1e-10))


def mfcc(x: Audio, n_mfcc: int = 13, n_mels: int = 26) -> F64:
    """MFCCs with cepstral mean normalisation and appended deltas, shape (frames, 2*n_mfcc)."""
    lm = log_mel(x, n_mels=n_mels)
    n = lm.shape[1]
    k = np.arange(n)
    dct = np.cos(math.pi / n * (k[None, :] + 0.5) * np.arange(n_mfcc)[:, None])
    c = lm @ dct.T
    c -= c.mean(axis=0, keepdims=True)
    delta = np.gradient(c, axis=0) if c.shape[0] > 1 else np.zeros_like(c)
    return np.hstack([c, delta])


def trim_energy(x: Audio, dynamic_db: float = 35.0, frame_ms: float = 10.0, pad_ms: float = 40.0) -> Audio:
    """Cut leading/trailing frames more than ``dynamic_db`` below the loudest frame."""
    hop = round(RATE * frame_ms / 1000)
    n = x.size // hop
    if n < 3:
        return x
    e = np.mean(x[: n * hop].astype(np.float64).reshape(n, hop) ** 2, axis=1)
    thr = e.max() * 10 ** (-dynamic_db / 10)
    on = np.flatnonzero(e >= thr)
    pad = round(pad_ms / frame_ms)
    a = max(0, int(on[0]) - pad) * hop
    b = min(n, int(on[-1]) + 1 + pad) * hop
    return x[a:b]


def dtw_distance(a: F64, b: F64, band: float = 0.3) -> float:
    """Length-normalised DTW distance (Euclidean frame cost) with a Sakoe-Chiba band.

    Vectorised over anti-diagonals: cell (i, j) depends only on diagonals i+j-1 and i+j-2.
    """
    n, m = a.shape[0], b.shape[0]
    if n == 0 or m == 0:
        return math.inf
    cost = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2))
    w = max(int(band * max(n, m)), abs(n - m) + 1)
    acc = np.full((n + 1, m + 1), np.inf)
    acc[0, 0] = 0.0
    for d in range(2, n + m + 1):
        i = np.arange(max(1, d - m), min(n, d - 1) + 1)
        j = d - i
        ok = np.abs(i - j) <= w
        i, j = i[ok], j[ok]
        if i.size == 0:
            continue
        best = np.minimum(np.minimum(acc[i - 1, j], acc[i, j - 1]), acc[i - 1, j - 1])
        acc[i, j] = cost[i - 1, j - 1] + best
    return float(acc[n, m] / (n + m))


def logsumexp(values: F64) -> float:
    m = float(np.max(values))
    if m == -math.inf:
        return -math.inf
    return m + math.log(float(np.sum(np.exp(values - m))))


def ctc_log_likelihood(logprobs: F64, labels: list[int], blank: int) -> float:
    """log P(labels | logprobs) under CTC (forward algorithm in log space). logprobs: (T, V) log-softmax."""
    t_len = logprobs.shape[0]
    ext = [blank]
    for lab in labels:
        ext += [lab, blank]
    s_len = len(ext)
    if t_len == 0:
        return -math.inf
    alpha = np.full(s_len, -math.inf)
    alpha[0] = logprobs[0, blank]
    if s_len > 1:
        alpha[1] = logprobs[0, ext[1]]
    for t in range(1, t_len):
        prev = alpha
        alpha = np.full(s_len, -math.inf)
        for s in range(s_len):
            cands = [prev[s]]
            if s >= 1:
                cands.append(prev[s - 1])
            if s >= 2 and ext[s] != blank and ext[s] != ext[s - 2]:
                cands.append(prev[s - 2])
            alpha[s] = logsumexp(np.asarray(cands)) + logprobs[t, ext[s]]
    tail = [alpha[s_len - 1]] + ([alpha[s_len - 2]] if s_len > 1 else [])
    return logsumexp(np.asarray(tail))


def ctc_best_path(logprobs: F64, blank: int) -> tuple[list[int], float]:
    """Greedy (best-path) decoding: collapsed labels and the path log probability."""
    best = np.argmax(logprobs, axis=1)
    score = float(np.sum(logprobs[np.arange(logprobs.shape[0]), best]))
    out: list[int] = []
    prev = -1
    for k in best.tolist():
        if k not in (prev, blank):
            out.append(int(k))
        prev = k
    return out, score
