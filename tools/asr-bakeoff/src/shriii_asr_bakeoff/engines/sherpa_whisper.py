"""Whisper (tiny/base/small, int8 ONNX) through sherpa-onnx: transcribe, then match the transcript to the
prompt's closed vocabulary by normalised edit similarity (phrase containment counts as a full match)."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any

from shriii_asr_bakeoff.audio import RATE, Audio
from shriii_asr_bakeoff.engines._sherpa import import_sherpa
from shriii_asr_bakeoff.engines.base import Engine, Enrollment, Recognition

WHISPER_LANG = {"hi-IN": "hi", "mr-IN": "mr", "ta-IN": "ta", "en-IN": "en"}


def normalise(text: str) -> str:
    """NFC, lower-case, punctuation/symbols to spaces. Combining marks (Indic vowel signs) are kept."""
    text = unicodedata.normalize("NFC", text).lower()
    chars = [" " if unicodedata.category(ch)[0] in "PSZC" else ch for ch in text]
    return " ".join("".join(chars).split())


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def similarity(transcript: str, phrase: str) -> float:
    t, p = normalise(transcript), normalise(phrase)
    if not t or not p:
        return 0.0
    if re.search(rf"(^|\s){re.escape(p)}($|\s)", t):
        return 1.0
    return 1.0 - levenshtein(t, p) / max(len(t), len(p))


def match(transcript: str, phrases: dict[str, tuple[str, ...]], codes: list[str], min_similarity: float) -> Recognition:
    scored = sorted(((max(similarity(transcript, p) for p in phrases[c]), c) for c in codes), reverse=True)
    best, code = scored[0]
    if best < min_similarity:
        return Recognition(None, None)
    if len(scored) > 1 and scored[1][0] >= best:
        return Recognition(None, None)
    return Recognition(code, best)


class SherpaWhisperEngine(Engine):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.recognizer: Any = None
        self.phrases: dict[str, tuple[str, ...]] = {}

    def _files(self) -> dict[str, Path] | None:
        d = self.spec.path_param("model_dir")
        if not d.is_dir():
            return None

        def pick(kind: str) -> Path | None:
            names = sorted(d.glob(f"*{kind}*.onnx"))
            int8 = [n for n in names if n.name.endswith(".int8.onnx")]
            pool = int8 or names
            return pool[0] if pool else None

        enc, dec = pick("encoder"), pick("decoder")
        tokens = next(iter(sorted(d.glob("*tokens.txt"))), None)
        if not (enc and dec and tokens):
            return None
        return {"encoder": enc, "decoder": dec, "tokens": tokens}

    def unavailable_reason(self, language: str) -> str | None:
        if language not in WHISPER_LANG:
            return f"no Whisper language code for {language}"
        try:
            import_sherpa()
        except ImportError:
            return "sherpa-onnx python package not installed"
        if self._files() is None:
            return f"Whisper ONNX model not found at {self.spec.path_param('model_dir')}"
        return None

    def version(self) -> str | None:
        files = self._files()
        return files["encoder"].name if files else None

    def prepare(self, language: str, phrases: dict[str, tuple[str, ...]], enrollment: list[Enrollment]) -> None:
        sherpa_onnx = import_sherpa()

        files = self._files()
        assert files is not None
        self.phrases = phrases
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(files["encoder"]),
            decoder=str(files["decoder"]),
            tokens=str(files["tokens"]),
            language=WHISPER_LANG[language],
            task="transcribe",
            num_threads=int(self.spec.params.get("num_threads", 2)),
        )

    def recognize(self, audio: Audio, codes: list[str]) -> Recognition:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(RATE, audio)
        self.recognizer.decode_stream(stream)
        return match(stream.result.text, self.phrases, codes, float(self.spec.params.get("min_similarity", 0.55)))

    def close(self) -> None:
        self.recognizer = None
