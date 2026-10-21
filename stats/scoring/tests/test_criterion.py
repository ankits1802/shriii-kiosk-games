"""Layer 3 criterion scoring: reverse keys, prorating, planned missingness, attention checks, schema validity."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from shriii_contracts.schema_validation import iter_errors
from shriii_scoring.content import load_instruments
from shriii_scoring.criterion import score_criterion

INSTRUMENTS = {k: v[0] for k, v in load_instruments().items()}


def resp(
    item: str,
    value: float | None,
    *,
    pid: str = "PXD0001",
    occ: str = "t1",
    block: str = "X",
    mode: str = "self",
    supersedes: str | None = None,
    at: str = "2026-11-01T10:00:00+00:00",
    rid: str | None = None,
) -> dict[str, Any]:
    inst = item.split(".", maxsplit=1)[0]
    return {
        "schema_version": "1.0",
        "response_id": rid or str(uuid.uuid4()),
        "pid": pid,
        "study_id": "study-1",
        "wave": 1,
        "occasion_id": occ,
        "instrument_id": inst,
        "instrument_version": INSTRUMENTS[inst]["version"],
        "language_version": f"{inst}.hi-in",
        "block": block,
        "item_id": item,
        "raw_response": value,
        "response_latency_ms": 2000.0,
        "administration_mode": mode,
        "administrator_id": "admin-1",
        "rater_role": "self",
        "rated_pid": None,
        "device_id": "tablet-1",
        "audio_version": None,
        "attention_check": False,
        "source": "in_app",
        "recorded_at": at,
        "supersedes_id": supersedes,
    }


def all_items(inst: str, value: float, **kw: Any) -> list[dict[str, Any]]:
    return [resp(str(it["item_id"]), value, block=str(it["block"]), **kw) for it in INSTRUMENTS[inst]["items"]]


def test_published_reverse_keys_bscs_and_grit() -> None:
    res = score_criterion(all_items("bscs", 5) + all_items("grit_s", 5))
    rev_bscs = sum(1 for it in INSTRUMENTS["bscs"]["items"] if it["reverse_keyed"])
    assert rev_bscs == 9
    assert res.score("PXD0001", "bscs", "total") == pytest.approx(((13 - rev_bscs) * 5 + rev_bscs * 1) / 13)
    assert res.score("PXD0001", "grit_s", "total") == pytest.approx(3.0)
    assert res.score("PXD0001", "grit_s", "consistency") == pytest.approx(1.0)
    assert res.score("PXD0001", "grit_s", "perseverance") == pytest.approx(5.0)


def test_cfi_seven_point_reverse_sum() -> None:
    res = score_criterion(all_items("cfi", 7))
    n_rev = sum(1 for it in INSTRUMENTS["cfi"]["items"] if it["reverse_keyed"])
    assert res.score("PXD0001", "cfi", "total") == pytest.approx((20 - n_rev) * 7 + n_rev * 1)


def test_sum_prorating_and_insufficient_items() -> None:
    items = all_items("ders16", 3)
    res = score_criterion(items[:13])  # 13 of 16 = 81 % >= 80 %
    rec = next(s for s in res.scores if s["instrument_id"] == "ders16" and s["scale_id"] == "total")
    assert rec["score"] == pytest.approx(48.0) and rec["prorated"] and "prorated" in rec["flags"]
    res = score_criterion(items[:12])  # 75 %
    rec = next(s for s in res.scores if s["instrument_id"] == "ders16" and s["scale_id"] == "total")
    assert rec["score"] is None and rec["na_reason"] == "insufficient_items"


def test_planned_missing_rotating_block() -> None:
    res = score_criterion(all_items("bscs", 3))
    assert not any(s["instrument_id"] == "erq" for s in res.scores)  # not administered at all
    mixed = all_items("bfi2_s", 3)
    x_only = [r for r in mixed if r["block"] == "X"]
    res = score_criterion(x_only)
    dom = next(s for s in res.scores if s["instrument_id"] == "bfi2_s" and s["scale_id"] == "extraversion")
    assert dom["planned_missing"] and dom["na_reason"] == "planned_missing"
    xs = next(s for s in res.scores if s["instrument_id"] == "bfi2_xs" and s["scale_id"] == "extraversion")
    assert xs["score"] == pytest.approx(3.0)  # BFI-2-XS scored from the shared BFI-2-S items 1-15


def test_attention_checks_flag_careless() -> None:
    key = {"attention_checks.i01": 5.0, "attention_checks.i02": 1.0, "attention_checks.i03": 3.0}
    att = [resp("attention_checks.i01", 5), resp("attention_checks.i02", 1), resp("attention_checks.i03", 2)]
    for r in att:
        r["attention_check"] = True
    res = score_criterion(att + all_items("bscs", 4), attention_key=key)
    failed = next(s for s in res.scores if s["instrument_id"] == "attention_checks")
    assert failed["score"] == 1.0
    assert all("criterion_careless" in s["flags"] for s in res.scores)
    res_ok = score_criterion(
        [{**r, "raw_response": key[r["item_id"]]} for r in att] + all_items("bscs", 4), attention_key=key
    )
    assert not any("criterion_careless" in s["flags"] for s in res_ok.scores)


def test_corrections_supersede_and_public_read_aloud_rejected() -> None:
    items = all_items("bscs", 3)
    orig = items[0]
    corr = resp(orig["item_id"], 5, supersedes=orig["response_id"], at="2026-11-02T10:00:00+00:00")
    res = score_criterion([*items, corr])
    expected_first = 1 if INSTRUMENTS["bscs"]["items"][0]["reverse_keyed"] else 5
    assert res.score("PXD0001", "bscs", "total") == pytest.approx((12 * 3 + expected_first) / 13)
    rejected = score_criterion(all_items("bscs", 3, mode="read_aloud"), public_kiosk_context=True)
    assert rejected.scores == [] and len(rejected.rejected) == 13


def test_performance_tol_board() -> None:
    rows = []
    min_moves = [2, 2, 3, 3, 4, 4, 5, 5]
    for i, m in enumerate(min_moves, start=1):
        rows.append(resp(f"tol_board.p{i}.moves", m + (1 if i % 2 else 0), block="performance"))
        rows.append(resp(f"tol_board.p{i}.initial_thinking_time_s", 4.0, block="performance"))
        rows.append(resp(f"tol_board.p{i}.solved_within_limit", 1.0, block="performance"))
    keys = {f"tol_board.p{i}": {"min_moves": float(m)} for i, m in enumerate(min_moves, start=1)}
    res = score_criterion(rows, performance_keys=keys)
    assert res.score("PXD0001", "tol_board", "excess_moves") == pytest.approx(4.0)
    assert res.score("PXD0001", "tol_board", "initial_thinking_time") == pytest.approx(4.0)
    assert res.score("PXD0001", "tol_board", "solved_within_limit") == pytest.approx(8.0)
    with pytest.raises(ValueError, match="min_moves"):
        score_criterion(rows)


def test_output_records_are_contract_valid() -> None:
    res = score_criterion(all_items("bscs", 4) + all_items("hexaco_hh", 2) + all_items("erq", 6))
    assert res.scores
    for s in res.scores:
        assert list(iter_errors("criterion-scale-score", s, "strict")) == []
        assert s["scoring_run_id"] == res.scoring_run_id
        assert s["algorithm_version"] and s["key_version"]
