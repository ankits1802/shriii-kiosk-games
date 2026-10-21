"""Criterion battery responses generated from planted latent traits (known loadings and reliabilities).

Each scale's true score is a weighted sum of planted latents plus a unique part (``criterion.loadings``);
items are congeneric indicators of the scale true score with loading ``criterion.item_loading``, cut into
the instrument's Likert categories. Reverse-keyed items are answered on the raw (unreversed) scale, so
correct reverse scoring is required to recover the planted relations. Rotating blocks (A/B/C) follow the
planned-missingness design; differential item functioning can be injected per item and language.
Output records conform to ``criterion-response.v1``.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

import numpy as np
from shriii_scoring.content import load_instruments

from shriii_simulator.params import SimParams, load_sim_params
from shriii_simulator.population import Person

__all__ = ["SimulatedCriterion", "simulate_criterion", "simulate_item_responses", "simulate_retest_scores"]

_NS = uuid.UUID("0f6f6c2a-8a3e-4c43-9a51-5f6a3bfa1c11")
ROTATING = ("A", "B", "C")


@dataclass(slots=True)
class SimulatedCriterion:
    """Criterion responses plus the planted true scale scores and block assignments."""

    responses: list[dict[str, Any]]
    true_scores: dict[tuple[str, str], float]
    blocks: dict[str, str]
    attention_key: dict[str, float]
    performance_keys: dict[str, dict[str, float]] = field(default_factory=dict)


def _primary_scale(inst: Mapping[str, Any], item: Mapping[str, Any]) -> str:
    parents = {s["scale_id"]: s.get("parent") for s in inst["subscales"]}
    for sid in item["subscales"]:
        if parents.get(sid) is None:
            return f"{inst['instrument_id']}.{sid}"
    return f"{inst['instrument_id']}.{item['subscales'][0]}"


def _likert(x: float, lo: int, hi: int) -> int:
    k = hi - lo + 1
    cuts = np.linspace(-1.5, 1.5, k - 1) if k > 2 else np.array([0.0])
    return int(lo + int(np.searchsorted(cuts, x)))


@dataclass(slots=True)
class _Emitter:
    """Builds ``criterion-response.v1`` records for one simulated occasion."""

    responses: list[dict[str, Any]]
    rng: np.random.Generator
    seed: int
    occasion_id: str
    study_id: str
    administration_mode: str
    t0: datetime

    def emit(
        self,
        person: Person,
        idx: int,
        inst: Mapping[str, Any],
        item_id: str,
        value: float | None,
        *,
        item_block: str,
        attention_item: bool,
        k: int,
    ) -> None:
        self.responses.append(
            {
                "schema_version": "1.0",
                "response_id": str(uuid.uuid5(_NS, f"{self.seed}|{self.occasion_id}|{person.pid}|{item_id}")),
                "pid": person.pid,
                "study_id": self.study_id,
                "wave": 1,
                "occasion_id": self.occasion_id,
                "instrument_id": inst["instrument_id"],
                "instrument_version": inst["version"],
                "language_version": f"{inst['instrument_id']}.{person.language.lower()}",
                "block": item_block,
                "item_id": item_id,
                "raw_response": value,
                "response_latency_ms": float(self.rng.uniform(1500, 6000)),
                "administration_mode": self.administration_mode,
                "administrator_id": "admin-sim-01",
                "rater_role": "administrator" if inst["kind"] in ("rating", "performance") else "self",
                "rated_pid": None,
                "device_id": "tablet-sim-01",
                "audio_version": None,
                "attention_check": attention_item,
                "source": "in_app",
                "recorded_at": (self.t0 + timedelta(minutes=idx * 40 + k)).isoformat(),
                "supersedes_id": None,
            }
        )


def simulate_criterion(
    persons: Sequence[Person],
    *,
    seed: int,
    params: SimParams | None = None,
    occasion_id: str = "t1",
    study_id: str = "sim-study",
    dif: Mapping[str, Mapping[str, float]] | None = None,
    careless: Sequence[str] = (),
    administration_mode: str = "read_aloud",
) -> SimulatedCriterion:
    """Generate item responses for every instrument (planned-missingness rotating blocks balanced by order).

    ``dif`` maps item id -> {language: latent shift} (uniform DIF on the response propensity);
    ``careless`` lists pids that respond at random and fail attention checks.
    """
    prm = params or load_sim_params()
    rng = np.random.default_rng(seed)
    instruments = {k: v[0] for k, v in load_instruments().items()}
    loadings: Mapping[str, Mapping[str, float]] = prm.get("criterion.loadings")
    lam = prm.f("criterion.item_loading")
    attention: dict[str, float] = {str(k): float(v) for k, v in prm.get("criterion.attention_key").items()}
    responses: list[dict[str, Any]] = []
    truth: dict[tuple[str, str], float] = {}
    blocks: dict[str, str] = {}
    t0 = datetime(2026, 11, 1, tzinfo=UTC)
    min_moves = [int(v) for v in prm.get("criterion.tol_min_moves")]
    perf_keys = {f"tol_board.p{i + 1}": {"min_moves": float(m)} for i, m in enumerate(min_moves)}
    careless_set = set(careless)
    emitter = _Emitter(
        responses=responses,
        rng=rng,
        seed=seed,
        occasion_id=occasion_id,
        study_id=study_id,
        administration_mode=administration_mode,
        t0=t0,
    )
    for idx, p in enumerate(persons):
        block = ROTATING[idx % 3]
        blocks[p.pid] = block
        scale_true: dict[str, float] = {}
        for scale, w in loadings.items():
            s = sum(float(v) * p.z(c) for c, v in w.items())
            unique = math.sqrt(max(0.0, 1.0 - sum(float(v) ** 2 for v in w.values())))
            scale_true[scale] = s + unique * float(rng.normal())
            truth[(p.pid, scale)] = scale_true[scale]

        emit = partial(emitter.emit, p, idx)

        k = 0
        for inst_id, inst in sorted(instruments.items()):
            if inst_id in ("partner_rating", "bfi2_xs"):
                # Partner ratings exist only in the live-dyad substudy; BFI-2-XS items are administered once as
                # BFI-2-S items 1-15 (criterion scoring aliases them).
                continue
            scale = inst["response_scale"]
            for it in inst["items"]:
                item_block = str(it["block"])
                if item_block in ROTATING and item_block != block:
                    continue
                k += 1
                iid = str(it["item_id"])
                if inst["kind"] == "performance":
                    if inst_id == "tol_board":
                        j = int(it["number"]) - 1
                        lam_ex = prm.f("criterion.tol_excess_rate") * math.exp(
                            -prm.f("criterion.tol_problem_solving") * p.z("problem_solving")
                        )
                        moves = min_moves[j] + int(rng.poisson(lam_ex * min_moves[j] / 3.5))
                        emit(inst, f"{iid}.moves", float(moves), item_block=item_block, attention_item=False, k=k)
                        emit(
                            inst,
                            f"{iid}.initial_thinking_time_s",
                            round(float(rng.lognormal(math.log(6) + 0.2 * p.z("initiative"), 0.4)), 2),
                            item_block=item_block,
                            attention_item=False,
                            k=k,
                        )
                        emit(
                            inst,
                            f"{iid}.solved_within_limit",
                            float(rng.random() < 0.9),
                            item_block=item_block,
                            attention_item=False,
                            k=k,
                        )
                    else:
                        pers = int(
                            rng.poisson(
                                prm.f("criterion.card_sort_perseverative_rate")
                                * math.exp(-prm.f("criterion.card_sort_adaptability") * p.z("adaptability"))
                            )
                        )
                        emit(
                            inst,
                            f"{iid}.perseverative_errors",
                            float(pers),
                            item_block=item_block,
                            attention_item=False,
                            k=k,
                        )
                        emit(
                            inst,
                            f"{iid}.categories_completed",
                            float(max(0, 6 - pers // 4)),
                            item_block=item_block,
                            attention_item=False,
                            k=k,
                        )
                        emit(inst, f"{iid}.trials_administered", 64.0, item_block=item_block, attention_item=False, k=k)
                    continue
                if it.get("attention_check"):
                    expected = attention[iid]
                    value = (
                        float(rng.integers(int(scale["min"]), int(scale["max"]) + 1))
                        if p.pid in careless_set
                        else expected
                    )
                    if p.pid in careless_set and value == expected:
                        value = float(scale["min"]) if expected != scale["min"] else float(scale["max"])
                    emit(inst, iid, value, item_block=item_block, attention_item=True, k=k)
                    continue
                if inst["kind"] == "single_item":
                    w = prm.get("criterion.general_risk")
                    s = sum(float(v) * p.z(c) for c, v in w.items())
                    x = s + math.sqrt(1 - sum(float(v) ** 2 for v in w.values())) * float(rng.normal())
                    value = float(int(np.clip(round(5 + 2.0 * x), int(scale["min"]), int(scale["max"]))))
                    truth[(p.pid, "general_risk.risk_willingness")] = x
                    emit(inst, iid, value, item_block=item_block, attention_item=False, k=k)
                    continue
                primary = _primary_scale(inst, it)
                t_score = scale_true.get(primary, float(rng.normal()))
                latent = lam * t_score + math.sqrt(1 - lam * lam) * float(rng.normal())
                latent += float((dif or {}).get(iid, {}).get(p.language, 0.0))
                lo, hi = int(scale["min"]), int(scale["max"])
                if p.pid in careless_set:
                    resp = int(rng.integers(lo, hi + 1))
                else:
                    resp = _likert(latent, lo, hi)
                    if it.get("reverse_keyed"):
                        resp = lo + hi - resp
                emit(inst, iid, float(resp), item_block=item_block, attention_item=False, k=k)
    return SimulatedCriterion(responses, truth, blocks, attention, perf_keys)


def simulate_retest_scores(
    n: int, icc_a1: float, *, practice_shift: float = 0.0, seed: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Score pairs whose population ICC(A,1) equals ``icc_a1`` including a planted mean practice shift.

    ``x_t = T + shift * [t = 2] + e_t`` with ``var(T) + var(e) = 1``; for two occasions the occasion variance
    component is ``shift^2 / 2``, so ``var(T) = icc_a1 * (1 + shift^2 / 2)``.
    """
    tau2 = icc_a1 * (1 + practice_shift**2 / 2)
    if tau2 >= 1:
        raise ValueError("practice shift too large for the requested ICC(A,1)")
    rng = np.random.default_rng(seed)
    t = rng.normal(0, math.sqrt(tau2), n)
    e1 = rng.normal(0, math.sqrt(1 - tau2), n)
    e2 = rng.normal(0, math.sqrt(1 - tau2), n)
    return t + e1, t + practice_shift + e2


def simulate_item_responses(
    n_per_group: int,
    n_items: int,
    *,
    seed: int,
    uniform_dif: Mapping[int, float] | None = None,
    nonuniform_dif: Mapping[int, float] | None = None,
    group_mean_difference: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Dichotomous 2PL responses for a reference (0) and focal (1) group with planted DIF.

    ``uniform_dif[j]`` shifts item j's difficulty for the focal group (positive = harder);
    ``nonuniform_dif[j]`` changes its discrimination for the focal group; ``group_mean_difference`` shifts
    the focal group's ability (impact, which must not be flagged as DIF). Returns (responses, group, theta).
    """
    rng = np.random.default_rng(seed)
    group = np.repeat([0, 1], n_per_group)
    theta = rng.normal(size=2 * n_per_group) + group * group_mean_difference
    a = rng.uniform(0.8, 2.0, n_items)
    b = rng.normal(0, 1, n_items)
    a_g = np.tile(a, (2 * n_per_group, 1))
    b_g = np.tile(b, (2 * n_per_group, 1))
    for j, shift in (uniform_dif or {}).items():
        b_g[group == 1, j] += shift
    for j, da in (nonuniform_dif or {}).items():
        a_g[group == 1, j] += da
    p = 1 / (1 + np.exp(-a_g * (theta[:, None] - b_g)))
    return (rng.random(p.shape) < p).astype(float), group, theta
