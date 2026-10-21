"""Engine interface used by the runner."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from shriii_asr_bakeoff.audio import Audio
from shriii_asr_bakeoff.config import EngineSpec


@dataclass(frozen=True, slots=True)
class Recognition:
    """Closed-vocabulary decision: a code (or None = reject) and a raw engine score in [0, 1]."""

    label: str | None
    score: float | None


@dataclass(frozen=True, slots=True)
class Enrollment:
    audio: Audio
    code: str


class Engine(ABC):
    def __init__(self, spec: EngineSpec) -> None:
        self.spec = spec

    @property
    def id(self) -> str:
        return self.spec.id

    def supports(self, language: str) -> bool:
        return self.spec.languages is None or language in self.spec.languages

    @abstractmethod
    def unavailable_reason(self, language: str) -> str | None:
        """None when the engine can run for ``language``; otherwise a human-readable reason."""

    def version(self) -> str | None:
        return None

    @abstractmethod
    def prepare(self, language: str, phrases: dict[str, tuple[str, ...]], enrollment: list[Enrollment]) -> None:
        """Load models / compile the vocabulary for a language. ``enrollment`` is used only by template engines."""

    @abstractmethod
    def recognize(self, audio: Audio, codes: list[str]) -> Recognition:
        """Decide among ``codes`` (the prompt's closed vocabulary) or reject."""

    def close(self) -> None:  # noqa: B027 - optional hook
        """Release models."""
