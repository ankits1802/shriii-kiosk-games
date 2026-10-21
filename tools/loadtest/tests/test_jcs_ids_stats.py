"""Client-side JCS, id generation and percentile maths agree with the server and with numpy."""

from __future__ import annotations

import random
import uuid

import numpy as np
import pytest
from shriii_api.canonical import canonical_json as server_canonical_json
from shriii_api.security import is_valid_code
from shriii_loadtest.ids import pseudonymous_pid, uuid7, uuid7_from
from shriii_loadtest.jcs import canonical_json, canonical_sha256, format_number
from shriii_loadtest.stats import percentile, summarise

EDGE_NUMBERS = [
    0.0,
    -0.0,
    1.0,
    60.0,
    0.1,
    1e21,
    1e20,
    123456789012345680000.0,
    1e-7,
    1e-6,
    5e-324,
    1.7976931348623157e308,
    -2.5,
    3.14159,
    1234.5678,
    2**53 + 0.0,
]


@pytest.mark.parametrize("value", EDGE_NUMBERS)
def test_number_formatting_matches_server(value: float) -> None:
    assert canonical_json(value) == server_canonical_json(value)


@pytest.mark.parametrize(
    ("value", "expected"), [(1e21, "1e+21"), (1e-7, "1e-7"), (0.000001, "0.000001"), (100.0, "100"), (-0.5, "-0.5")]
)
def test_ecmascript_number_strings(value: float, expected: str) -> None:
    assert format_number(value) == expected


def test_nan_is_refused() -> None:
    with pytest.raises(ValueError, match="NaN"):
        canonical_json(float("nan"))


def test_documents_match_server_including_unicode_and_nesting() -> None:
    doc = {"b": [1, 2.5, {"z": None, "a": True}], "a": "हिंदी", "é": 1e-9, "€": {"k": 60.0}, "\U0001f600": "x"}
    assert canonical_json(doc) == server_canonical_json(doc)


def test_corpus_events_match_server(corpus_events: list[dict]) -> None:
    for event in corpus_events[:400]:
        assert canonical_json(event) == server_canonical_json(event)
    assert len(canonical_sha256(corpus_events[:10])) == 64


def test_uuid7_shape_and_order() -> None:
    a = uuid.UUID(uuid7(1_700_000_000_000))
    b = uuid.UUID(uuid7(1_700_000_000_001))
    assert a.version == 7 and a.variant == uuid.RFC_4122
    assert a < b


def test_uuid7_from_is_deterministic() -> None:
    assert uuid7_from(random.Random(3), 5) == uuid7_from(random.Random(3), 5)


def test_pids_pass_the_server_check() -> None:
    rng = random.Random(11)
    for _ in range(200):
        assert is_valid_code(pseudonymous_pid(rng))


def test_percentiles_match_numpy() -> None:
    rng = random.Random(5)
    values = sorted(rng.lognormvariate(5, 0.6) for _ in range(997))
    for q in (0, 1, 50, 90, 95, 99, 99.9, 100):
        assert percentile(values, q) == pytest.approx(float(np.percentile(values, q)), rel=1e-12)


def test_summary_of_empty_is_nan() -> None:
    s = summarise([])
    assert s.n == 0 and s.p95 != s.p95
    full = summarise([1.0, 2.0, 3.0, 4.0])
    assert full.p50 == 2.5 and full.max == 4.0 and full.mean == 2.5
