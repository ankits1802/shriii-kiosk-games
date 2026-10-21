"""Text utilities: source hashing, placeholder extraction, script checks and spoken-duration estimates."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

from .models import QualityConfig

# Placeholders a recording script may carry. None exist in catalogue v0.1.0, but the round-trip must never
# lose or invent one: {name} / {{name}}, printf-style %s / %(name)s, SSML-like tags <break time="300ms"/>,
# and bracketed stage directions such as [pause] or [quantity].
_PLACEHOLDER_RE = re.compile(
    r"\{\{\s*[A-Za-z0-9_.]+\s*\}\}"  # {{name}}
    r"|\{[A-Za-z0-9_.]+\}"  # {name}
    r"|%\([A-Za-z0-9_]+\)[sd]"  # %(name)s
    r"|%[sd]"  # %s
    r"|<[A-Za-z][^<>]*/?>"  # <break .../>
    r"|\[[A-Za-z_][A-Za-z0-9_ ]*\]"  # [pause]
)

_SCRIPT_RANGES: dict[str, tuple[int, int]] = {
    "Deva": (0x0900, 0x097F),
    "Taml": (0x0B80, 0x0BFF),
}

# Devanagari
_DEVA_CONSONANTS = set(range(0x0915, 0x093A)) | set(range(0x0958, 0x0960)) | {0x0979, 0x097A}
_DEVA_INDEPENDENT_VOWELS = set(range(0x0904, 0x0915)) | {0x0960, 0x0961, 0x0972}
_DEVA_VIRAMA = 0x094D
_DEVA_NUKTA = 0x093C
# Tamil
_TAML_CONSONANTS = set(range(0x0B95, 0x0BBA))
_TAML_INDEPENDENT_VOWELS = set(range(0x0B85, 0x0B95))
_TAML_PULLI = 0x0BCD
_TAML_AYTHAM = 0x0B83

_LATIN_RE = re.compile(r"[A-Za-z]")
_SENTENCE_BREAK_RE = re.compile(r"[.!?।॥]+|—")
_CLAUSE_BREAK_RE = re.compile(r"[,;:]")
_EN_VOWEL_GROUP_RE = re.compile(r"[aeiouy]+")


def normalise(text: str) -> str:
    """NFC-normalise and collapse whitespace (the canonical form used for hashing and comparisons)."""
    return " ".join(unicodedata.normalize("NFC", text).split())


def source_hash(reference_text: str) -> str:
    """Stable 16-hex-digit fingerprint of a catalogue reference text (detects source drift)."""
    return hashlib.sha256(normalise(reference_text).encode("utf-8")).hexdigest()[:16]


def placeholders(text: str) -> Counter[str]:
    """Multiset of placeholder tokens in ``text`` (whitespace inside {{ }} is normalised)."""
    return Counter(
        re.sub(r"\s+", "", m) if m.startswith("{{") else re.sub(r"\s+", " ", m) for m in _PLACEHOLDER_RE.findall(text)
    )


def placeholder_mismatch(source: str, target: str) -> tuple[list[str], list[str]]:
    """Return (missing_in_target, extra_in_target) placeholder tokens."""
    src, tgt = placeholders(source), placeholders(target)
    missing = sorted((src - tgt).elements())
    extra = sorted((tgt - src).elements())
    return missing, extra


def script_share(text: str, script: str) -> float:
    """Share of letters in ``text`` that belong to ``script`` (0..1); 1.0 for Latin when every letter is Latin."""
    letters = [ch for ch in text if unicodedata.category(ch).startswith(("L", "M"))]
    if not letters:
        return 0.0
    if script == "Latn":
        return sum(1 for ch in letters if _LATIN_RE.match(ch)) / len(letters)
    lo, hi = _SCRIPT_RANGES[script]
    return sum(1 for ch in letters if lo <= ord(ch) <= hi) / len(letters)


def latin_letter_count(text: str) -> int:
    return len(_LATIN_RE.findall(text))


def count_syllables(text: str, script: str) -> int:
    """Approximate spoken syllables (aksharas) for duration estimates.

    Indic scripts: every consonant not silenced by a virama/pulli, plus every independent vowel. This
    over-counts Hindi/Marathi words that delete the inherent schwa; the per-language speech rate in
    ``workflow.yaml`` is calibrated in aksharas per second, so the bias cancels to first order.
    Latin: vowel groups per word, minimum one per word.
    """
    text = unicodedata.normalize("NFC", text)
    if script == "Latn":
        total = 0
        for word in re.findall(r"[A-Za-z']+", text.lower()):
            groups = len(_EN_VOWEL_GROUP_RE.findall(word))
            if word.endswith("e") and groups > 1 and not word.endswith(("le", "ee")):
                groups -= 1
            total += max(groups, 1)
        return total
    if script == "Deva":
        consonants, vowels, killer, skip = _DEVA_CONSONANTS, _DEVA_INDEPENDENT_VOWELS, _DEVA_VIRAMA, {_DEVA_NUKTA}
    elif script == "Taml":
        consonants, vowels, killer, skip = _TAML_CONSONANTS, _TAML_INDEPENDENT_VOWELS, _TAML_PULLI, {_TAML_AYTHAM}
    else:  # pragma: no cover - guarded by the Literal type on LanguageDef.script
        raise ValueError(f"unsupported script {script!r}")
    codepoints = [ord(ch) for ch in text]
    count = 0
    for i, cp in enumerate(codepoints):
        if cp in vowels:
            count += 1
        elif cp in consonants:
            j = i + 1
            while j < len(codepoints) and codepoints[j] in skip:
                j += 1
            if j >= len(codepoints) or codepoints[j] != killer:
                count += 1
    return count


@dataclass(frozen=True)
class DurationEstimate:
    syllables: int
    estimated_ms: int
    target_ms: int
    ratio: float
    within_tolerance: bool
    flagged: bool


def estimate_duration(
    text: str, script: str, language: str, target_ms: int, quality: QualityConfig
) -> DurationEstimate:
    """Estimate the spoken duration of a recording-script line and compare it with the catalogue target.

    ``within_tolerance`` mirrors VOX-07 (recording sheets: target duration +-15%); ``flagged`` mirrors
    VOX-02 (clips longer than 1.5x the source-language duration are flagged).
    """
    syllables = count_syllables(text, script)
    rate = quality.syllables_per_second[language]
    stripped = text.strip()
    sentence_breaks = len(_SENTENCE_BREAK_RE.findall(stripped.rstrip(".!?।॥ ")))
    clause_breaks = len(_CLAUSE_BREAK_RE.findall(stripped))
    ms = round(1000 * syllables / rate) + sentence_breaks * quality.sentence_pause_ms
    ms += clause_breaks * quality.clause_pause_ms
    ratio = ms / target_ms if target_ms else float("inf")
    tol = quality.duration_tolerance
    return DurationEstimate(
        syllables=syllables,
        estimated_ms=ms,
        target_ms=target_ms,
        ratio=round(ratio, 3),
        within_tolerance=(1 - tol) <= ratio <= (1 + tol),
        flagged=ratio > quality.duration_flag_ratio,
    )
