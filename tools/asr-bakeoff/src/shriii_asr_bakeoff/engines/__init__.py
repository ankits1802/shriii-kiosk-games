"""Candidate engines and the factory that maps ``engines.yaml`` kinds to implementations."""

from __future__ import annotations

from shriii_asr_bakeoff.config import EngineSpec
from shriii_asr_bakeoff.engines.base import Engine, Enrollment, Recognition
from shriii_asr_bakeoff.engines.ctc_constrained import CtcConstrainedEngine
from shriii_asr_bakeoff.engines.dtw import DtwEngine
from shriii_asr_bakeoff.engines.sherpa_kws import SherpaKwsEngine
from shriii_asr_bakeoff.engines.sherpa_whisper import SherpaWhisperEngine

KINDS: dict[str, type[Engine]] = {
    "dtw_mfcc": DtwEngine,
    "sherpa_kws": SherpaKwsEngine,
    "sherpa_whisper": SherpaWhisperEngine,
    "ctc_constrained": CtcConstrainedEngine,
}


def create_engine(spec: EngineSpec) -> Engine:
    try:
        return KINDS[spec.kind](spec)
    except KeyError as exc:
        raise ValueError(f"unknown engine kind {spec.kind!r} (known: {sorted(KINDS)})") from exc


__all__ = ["KINDS", "Engine", "Enrollment", "Recognition", "create_engine"]
