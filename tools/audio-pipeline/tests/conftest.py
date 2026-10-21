"""Shared fixtures (synthetic material lives in synth.py)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from synth import line

from shriii_audio.config import QcConfig, load_qc_config
from shriii_audio.signing import SigningKey, generate_key


@pytest.fixture
def qc() -> QcConfig:
    return load_qc_config()


@pytest.fixture
def catalogue_file(tmp_path: Path) -> Path:
    data = {
        "schema_version": "1.0",
        "catalogue_version": "0.3.0",
        "reference_language": "en-IN",
        "languages": ["en-IN", "hi-IN"],
        "lines": [
            line("guide.hello", 3000),
            line("guide.bye", 3000, forbidden=True),
            line("guide.clipped", 3000),
            line("guide.noisy", 3000),
            line("guide.takes", 3000),
            line("guide.long", 3000),
        ],
    }
    path = tmp_path / "lines.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


@pytest.fixture
def signing_key(tmp_path: Path) -> tuple[SigningKey, Path]:
    pub = tmp_path / "keys" / "test-key.pub.json"
    key = generate_key("audio-test-1", tmp_path / "keys" / "test-key.pem", pub)
    return key, pub
