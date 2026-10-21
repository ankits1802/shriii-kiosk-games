"""sherpa-onnx keyword spotter with a ladder of thresholds (the score is the strictest tier that fired).

This mirrors packages/asr-sherpa exactly: one spotter per tier, per-prompt keyword lists, label =
code of the highest tier, ambiguous (two codes at the top tier) = reject.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from shriii_asr_bakeoff.audio import RATE, Audio
from shriii_asr_bakeoff.engines._sherpa import import_sherpa
from shriii_asr_bakeoff.engines.base import Engine, Enrollment, Recognition
from shriii_asr_bakeoff.tokenize import BpeTokenizer


def _model_files(model_dir: Path) -> dict[str, str]:
    def pick(stem: str, int8: bool) -> str:
        names = sorted(p.name for p in model_dir.glob(f"{stem}-*.onnx"))
        pref = [n for n in names if n.endswith(".int8.onnx") == int8] or names
        if not pref:
            raise FileNotFoundError(f"no {stem}-*.onnx in {model_dir}")
        return str(model_dir / pref[0])

    return {
        "encoder": pick("encoder", True),
        "decoder": pick("decoder", False),
        "joiner": pick("joiner", True),
        "tokens": str(model_dir / "tokens.txt"),
    }


class SherpaKwsEngine(Engine):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.spotters: list[tuple[float, Any]] = []
        self.keywords: dict[str, list[str]] = {}
        self._tmp: tempfile.TemporaryDirectory[str] | None = None

    def _model_dir(self) -> Path:
        return self.spec.path_param("model_dir")

    def unavailable_reason(self, language: str) -> str | None:
        if not self.supports(language):
            return f"no KWS model for {language} (engine languages: {', '.join(self.spec.languages or [])})"
        try:
            import_sherpa()
        except ImportError:
            return "sherpa-onnx python package not installed"
        d = self._model_dir()
        if not (d / "tokens.txt").is_file():
            return f"model not found at {d} (run: pnpm --filter @shriii/asr-sherpa fetch-models)"
        if not (d / str(self.spec.params.get("bpe_model", "bpe.model"))).is_file():
            return f"bpe model missing in {d}"
        return None

    def version(self) -> str | None:
        try:
            sherpa_onnx = import_sherpa()

            return f"sherpa-onnx {sherpa_onnx.__version__}"
        except ImportError:
            return None

    def keyword_tokens(self) -> dict[str, list[str]]:
        """code -> list of token strings (one per phrase), as written into the language pack grammar."""
        return self.keywords

    def prepare(self, language: str, phrases: dict[str, tuple[str, ...]], enrollment: list[Enrollment]) -> None:
        sherpa_onnx = import_sherpa()

        d = self._model_dir()
        tok = BpeTokenizer(d / str(self.spec.params.get("bpe_model", "bpe.model")))
        self.keywords = {code: [" ".join(tok.encode(p)) for p in ps] for code, ps in phrases.items()}
        self._tmp = tempfile.TemporaryDirectory(prefix="kws-")
        kw_file = Path(self._tmp.name) / "keywords.txt"
        kw_file.write_text(
            "\n".join(f"{t} @{code}" for code, toks in self.keywords.items() for t in toks) + "\n", encoding="utf-8"
        )
        files = _model_files(d)
        self.spotters = []
        for thr in sorted(float(t) for t in self.spec.params.get("tiers", [0.25])):
            spotter = sherpa_onnx.KeywordSpotter(
                tokens=files["tokens"],
                encoder=files["encoder"],
                decoder=files["decoder"],
                joiner=files["joiner"],
                num_threads=int(self.spec.params.get("num_threads", 1)),
                keywords_file=str(kw_file),
                keywords_score=1.0,
                keywords_threshold=thr,
                num_trailing_blanks=1,
                max_active_paths=4,
                provider="cpu",
            )
            self.spotters.append((thr, spotter))

    def recognize(self, audio: Audio, codes: list[str]) -> Recognition:
        allowed = set(codes)
        best: dict[str, float] = {}
        tail = [0.0] * round(0.4 * RATE)
        for thr, spotter in self.spotters:
            # Every spotter holds all codes (per-stream keyword lists are additive in sherpa); hits outside
            # the prompt vocabulary are ignored, exactly as the kiosk adapter does.
            stream = spotter.create_stream()
            stream.accept_waveform(RATE, audio)
            stream.accept_waveform(RATE, tail)
            stream.input_finished()
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
                hit = spotter.get_result(stream)
                if hit:
                    if hit in allowed:
                        best[hit] = max(best.get(hit, 0.0), thr)
                    spotter.reset_stream(stream)
        if not best:
            return Recognition(None, None)
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        if len(ranked) > 1 and ranked[1][1] == ranked[0][1]:
            return Recognition(None, None)
        return Recognition(ranked[0][0], ranked[0][1])

    def close(self) -> None:
        self.spotters = []
        if self._tmp is not None:
            self._tmp.cleanup()
            self._tmp = None
