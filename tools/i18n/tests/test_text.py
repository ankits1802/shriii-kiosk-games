from __future__ import annotations

import pytest
from shriii_i18n.models import QualityConfig
from shriii_i18n.text import (
    count_syllables,
    estimate_duration,
    normalise,
    placeholder_mismatch,
    placeholders,
    script_share,
    source_hash,
)

Q = QualityConfig(
    duration_tolerance=0.15,
    duration_flag_ratio=1.5,
    syllables_per_second={"hi-IN": 5.0, "ta-IN": 5.0, "en-IN": 4.0},
    sentence_pause_ms=300,
    clause_pause_ms=100,
    max_latin_letters=0,
)


def test_source_hash_is_stable_and_whitespace_insensitive() -> None:
    assert source_hash("Touch the screen to begin.") == source_hash("  Touch  the screen\nto begin. ")
    assert source_hash("Touch the screen to begin.") != source_hash("Touch the screen to start.")
    assert len(source_hash("x")) == 16


def test_normalise_nfc() -> None:
    # U+0958 (QA) is a composition exclusion: NFC maps it to KA + NUKTA, so both spellings compare equal.
    assert normalise("क़") == "क़" == normalise("क़")
    assert source_hash("ज़") == source_hash("ज़")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Hello {name}!", ["{name}"]),
        ("{{ count }} and {{count}}", ["{{count}}", "{{count}}"]),
        ("%s then %(qty)s", ["%(qty)s", "%s"]),
        ('Wait <break time="300ms"/> now [pause]', ['<break time="300ms"/>', "[pause]"]),
        ("No placeholders here.", []),
    ],
)
def test_placeholders(text: str, expected: list[str]) -> None:
    assert sorted(placeholders(text).elements()) == sorted(expected)


def test_placeholder_mismatch_reports_both_directions() -> None:
    missing, extra = placeholder_mismatch("Give {n} mangoes to {who}", "{n} आम दीजिए {where}")
    assert missing == ["{who}"]
    assert extra == ["{where}"]
    assert placeholder_mismatch("{a}{a}", "{a}") == (["{a}"], [])


def test_script_share() -> None:
    assert script_share("नमस्ते", "Deva") == 1.0
    assert script_share("வணக்கம்", "Taml") == 1.0
    assert script_share("नमस्ते", "Taml") == 0.0
    assert 0 < script_share("स्क्रीन screen", "Deva") < 1
    assert script_share("123 !", "Deva") == 0.0


@pytest.mark.parametrize(
    ("text", "script", "expected"),
    [
        ("नमस्ते", "Deva", 3),  # न म स्+ते -> na-ma-ste
        ("स्क्रीन", "Deva", 2),  # स् क्+री न
        ("आम", "Deva", 2),  # independent vowel + consonant
        ("வணக்கம்", "Taml", 3),  # வ ண க் க ம் -> va-ṇak-kam
        ("அம்மா", "Taml", 2),  # அ ம் மா
        ("Touch the screen to begin.", "Latn", 6),
    ],
)
def test_count_syllables(text: str, script: str, expected: int) -> None:
    assert count_syllables(text, script) == expected


def test_estimate_duration_flags() -> None:
    est = estimate_duration("नमस्ते! आइए।", "Deva", "hi-IN", 1200, Q)
    # 3 + 3 syllables at 5/s = 1200 ms, plus one internal sentence break (the final one is not counted)
    assert est.syllables == 6
    assert est.estimated_ms == 1500
    assert est.ratio == 1.25
    assert not est.within_tolerance
    assert not est.flagged
    long = estimate_duration("नमस्ते नमस्ते नमस्ते नमस्ते", "Deva", "hi-IN", 1000, Q)
    assert long.flagged
    ok = estimate_duration("नमस्ते", "Deva", "hi-IN", 600, Q)
    assert ok.within_tolerance
