"""Any CTC acoustic model exported to ONNX (e.g. AI4Bharat IndicConformer's CTC head) decoded with
closed-vocabulary constrained scoring.

For a prompt with codes c1..ck, each phrase's CTC log-likelihood ``log P(phrase | audio)`` is computed
with the forward algorithm. A free-decoding "garbage" hypothesis (the best path) competes with the
phrases, so audio that matches no phrase well is rejected. Scores are per-frame normalised and turned
into a posterior over {phrases, garbage}; the winning code's posterior is the engine score.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from shriii_asr_bakeoff.audio import Audio
from shriii_asr_bakeoff.engines.base import Engine, Enrollment, Recognition
from shriii_asr_bakeoff.features import F64, ctc_best_path, ctc_log_likelihood, log_mel
from shriii_asr_bakeoff.tokenize import GreedyTokenizer, read_token_list


def log_softmax(x: F64) -> F64:
    m = x.max(axis=1, keepdims=True)
    return np.asarray(x - m - np.log(np.exp(x - m).sum(axis=1, keepdims=True)), dtype=np.float64)


def constrained_decode(
    logprobs: F64, candidates: dict[str, list[list[int]]], blank: int, temperature: float = 1.0
) -> tuple[str | None, float, dict[str, float]]:
    """Return (best code, or None when the garbage path wins; posterior of the winner; per-code scores).

    Scores are per-frame normalised log-likelihoods; the posterior is a softmax over the candidates and
    the garbage hypothesis at ``temperature``.
    """
    t = max(1, logprobs.shape[0])
    scores: dict[str, float] = {}
    for code, seqs in candidates.items():
        scores[code] = max(ctc_log_likelihood(logprobs, s, blank) for s in seqs) / t
    _, garbage = ctc_best_path(logprobs, blank)
    names = [*scores, "__garbage__"]
    vals = np.array([*scores.values(), garbage / t]) / temperature
    vals -= vals.max()
    post = np.exp(vals) / np.exp(vals).sum()
    best = int(np.argmax(post))
    if names[best] == "__garbage__":
        return None, float(post[best]), scores
    return names[best], float(post[best]), scores


class CtcConstrainedEngine(Engine):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.session: Any = None
        self.candidates: dict[str, list[list[int]]] = {}
        self.blank = 0
        self.language = ""

    def unavailable_reason(self, language: str) -> str | None:
        if not self.supports(language):
            return f"engine not configured for {language}"
        try:
            import onnxruntime  # noqa: F401, PLC0415
        except ImportError:
            return "onnxruntime not installed"
        model = self.spec.path_param("model", language)
        if not model.is_file():
            return f"ONNX model not found at {model} (export IndicConformer's CTC head; see PROTOCOL.md)"
        if not self.spec.path_param("vocab", language).is_file():
            return "tokens.txt missing next to the model"
        return None

    def version(self) -> str | None:
        return str(self.spec.params.get("model"))

    def prepare(self, language: str, phrases: dict[str, tuple[str, ...]], enrollment: list[Enrollment]) -> None:
        import onnxruntime as ort  # noqa: PLC0415

        self.language = language
        vocab = read_token_list(self.spec.path_param("vocab", language))
        blank_cfg = str(self.spec.params.get("blank_index", "last"))
        if "<blk>" in vocab or "<blank>" in vocab:
            self.blank = vocab.get("<blk>", vocab.get("<blank>", 0))
        elif blank_cfg == "first":
            self.blank = 0
        elif blank_cfg == "last":
            self.blank = max(vocab.values()) + 1
        else:
            self.blank = int(blank_cfg)
        tok = GreedyTokenizer(vocab)
        self.candidates = {code: [tok.ids(p) for p in ps] for code, ps in phrases.items()}
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(self.spec.params.get("num_threads", 1))
        self.session = ort.InferenceSession(
            str(self.spec.path_param("model", language)), opts, providers=["CPUExecutionProvider"]
        )

    def _features(self, audio: Audio) -> F64:
        f = self.spec.params.get("features", {})
        lm = log_mel(
            audio,
            n_mels=int(f.get("n_mels", 80)),
            win_ms=float(f.get("win_ms", 25)),
            hop_ms=float(f.get("hop_ms", 10)),
            n_fft=int(f.get("n_fft", 512)),
        )
        if f.get("normalize", "per_feature") == "per_feature":
            lm = (lm - lm.mean(axis=0, keepdims=True)) / (lm.std(axis=0, keepdims=True) + 1e-5)
        return lm

    def recognize(self, audio: Audio, codes: list[str]) -> Recognition:
        feats = self._features(audio).T[None, :, :].astype(np.float32)  # (1, n_mels, T)
        inputs = {str(self.spec.params.get("input_name", "audio_signal")): feats}
        length_name = self.spec.params.get("length_name")
        if length_name:
            inputs[str(length_name)] = np.array([feats.shape[2]], dtype=np.int64)
        out = self.session.run([str(self.spec.params.get("output_name", "logprobs"))], inputs)[0][0]
        logprobs = np.asarray(out, dtype=np.float64)
        if not math.isclose(float(np.exp(logprobs[0]).sum()), 1.0, rel_tol=1e-2):
            logprobs = log_softmax(logprobs)  # model emitted raw logits
        label, conf, _ = constrained_decode(logprobs, {c: self.candidates[c] for c in codes}, self.blank)
        return Recognition(label, conf if label else None)

    def close(self) -> None:
        self.session = None
