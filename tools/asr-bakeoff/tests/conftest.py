"""Shared fixtures: a small synthetic placeholder dataset (built once per session)."""

from __future__ import annotations

from pathlib import Path

import pytest

from shriii_asr_bakeoff.config import Vocabulary
from shriii_asr_bakeoff.synth import build_placeholder_dataset

SMALL_VOCAB = Vocabulary(
    prompts={"generic.yes_no": ("yes", "no"), "generic.wait": ("wait",), "stall.share_offer": ("share", "no")},
    languages={
        "hi-IN": {"yes": ("हाँ",), "no": ("नहीं",), "wait": ("रुको",), "share": ("बाँटो",)},
    },
)


@pytest.fixture(scope="session")
def small_dataset(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("synthetic")
    return build_placeholder_dataset(
        out,
        {"hi-IN": ["no", "share", "wait", "yes"]},
        n_speakers=24,
        n_enroll=8,
        reps=2,
        oov_words=2,
        seed=3,
    )
