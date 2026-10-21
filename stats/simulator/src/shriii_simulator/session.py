"""Whole synthetic sessions and studies (events + trial params + planted truth)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import numpy as np

from shriii_simulator.builder import SessionWriter
from shriii_simulator.common import Occasion
from shriii_simulator.ids import fake_sha256
from shriii_simulator.modules_a import A_MODULES
from shriii_simulator.modules_b import B_MODULES
from shriii_simulator.params import SimParams, load_sim_params
from shriii_simulator.population import Person, Strategy, retest_person, sample_population

__all__ = ["SimulatedSession", "SimulatedStudy", "simulate_session", "simulate_study"]

B_CORE = ("dont_tap", "card_sort", "balloon", "tower", "share_pot")
B_SLOTS = ("wait_or_now", "steady_hands", "four_stalls", "private_dice")
A_ORDER = ("stall", "weighing_post", "road_home")


class ModuleFn(Protocol):
    """A module / episode generator."""

    def __call__(
        self, w: SessionWriter, p: Person, rng: np.random.Generator, prm: SimParams, *, occ: Occasion, style: np.ndarray
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class SimulatedSession:
    """One synthetic session."""

    session_id: str
    person: Person
    pathway: str
    occasion: int
    slot_form: str | None
    events: list[dict[str, Any]]
    trial_params: dict[str, dict[str, Any]]
    walked_away: bool


@dataclass(slots=True)
class SimulatedStudy:
    """A synthetic study: persons (planted truth), sessions and per-session trial params."""

    persons: list[Person]
    sessions: list[SimulatedSession]
    params_sha256: str
    seed: int
    occasion_persons: dict[int, dict[str, Person]] = field(default_factory=dict)

    @property
    def events(self) -> list[dict[str, Any]]:
        return [e for s in self.sessions for e in s.events]

    @property
    def trial_params(self) -> dict[str, dict[str, dict[str, Any]]]:
        return {s.session_id: s.trial_params for s in self.sessions}

    def sessions_for(self, occasion: int) -> list[SimulatedSession]:
        return [s for s in self.sessions if s.occasion == occasion]


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def _onboarding(w: SessionWriter, person: Person, slot: str | None, rng: np.random.Generator) -> None:
    w.emit(
        "session_start",
        {
            "seed": f"{int(rng.integers(0, 2**63)):016x}",
            "rng_algorithm": "pcg32",
            "refresh_hz": 60,
            "arm_source": "server_list",
            "stratum": None,
            "slot_form": slot,
        },
    )
    w.emit("session.state_changed", {"from_state": None, "to_state": "attract", "trigger": "boot"})
    w.advance(4000)
    w.emit(
        "language_selected",
        {
            "language": person.language,
            "face_order": ["hi-IN", "mr-IN", "ta-IN"],
            "pack_version": "0.1.0",
            "manifest_hash": fake_sha256("audio"),
            "taps": 1,
        },
    )
    w.advance(30000)
    w.emit(
        "consent.granted",
        {
            "consent_kind": "core",
            "tap_confirmed": True,
            "consent_script_id": "consent.core.v1",
            "consent_version_hash": fake_sha256("consent"),
            "replay_counts": [0],
            "policy_version": "1.0.0",
        },
    )
    w.advance(20000)
    w.emit(
        "bands.answered",
        {
            "age": person.age_band,
            "literacy": person.literacy,
            "edu": person.edu_band,
            "gender": person.gender,
            "device_use": person.device_familiarity,
            "played_before": "no",
            "answer_latency_ms": {
                k: float(rng.uniform(1500, 5000))
                for k in ("age", "literacy", "edu", "gender", "device_use", "played_before")
            },
            "change_count": 0,
        },
    )
    w.emit(
        "session.context",
        {
            "context": {
                "schema_version": "1.0",
                "session_id": w.session_id,
                "language": person.language,
                "age_band": person.age_band,
                "literacy_band": person.literacy,
                "edu_band": person.edu_band,
                "gender": person.gender,
                "device_familiarity": person.device_familiarity,
                "played_before": "no",
                "asr_enabled": False,
                "noise": {"noise_floor_dbfs": None, "samples": 0},
                "headset": False,
                "a11y": {
                    "slow_pace": False,
                    "volume_boost": False,
                    "headset": False,
                    "pictogram_storyboard": False,
                    "hold_threshold_ms": None,
                },
                "practice": {"practice_struggle": False, "skills_passed": ["tap", "hold", "choice"]},
                "battery_arm": w.context["battery_arm"],
                "slot_form": slot,
                "calibration_level": "L2",
                "calibration_policy": "fixed_L2_with_L1_fallback",
                "linkage_flag": True,
                "linked_prior_session_token": None,
                "device": {"model": "sim", "firmware": "0", "hardware_sku": "sim-sku"},
                "site_mode": w.context["site_mode"],
                "mode": w.context["mode"],
                "variant_pack_id": w.versions["variant_pack_id"],
                "completion": "in_progress",
                "walkaway_point": None,
            }
        },
    )
    w.advance(30000)
    w.emit(
        "practice.summary",
        {
            "skills": [{"skill": s, "attempts": 2, "passes": 2, "completed": True} for s in ("tap", "hold", "choice")],
            "practice_struggle": False,
            "mean_tap_rt_ms": 520.0,
            "hold_accuracy": 1.0,
        },
    )
    w.emit(
        "calibration_result",
        {
            "policy": "fixed_L2_with_L1_fallback",
            "level": "L2",
            "reason": "default",
            "warmup_rt_ms": 520.0,
            "warmup_accuracy": 1.0,
        },
    )


def simulate_session(
    person: Person,
    pathway: Literal["A", "B"],
    rng: np.random.Generator,
    params: SimParams,
    *,
    occasion: Occasion | None = None,
    slot_form: str | None = None,
    include_coplay: bool = False,
    session_index: int = 0,
    mode: str = "pilot",
    style_vector: np.ndarray | None = None,
) -> SimulatedSession:
    """Generate one session's events for ``person``."""
    occ = occasion or Occasion()
    slot = slot_form if pathway == "B" else None
    if pathway == "B" and slot is None:
        slot = str(rng.choice(B_SLOTS))
    w = SessionWriter.create(
        rng,
        participant_pid=person.pid,
        language=person.language,
        battery_arm="B_fixed" if pathway == "B" else "A_narrative",
        slot_form=slot,
        mode=mode,
        session_index=session_index,
        timing_glitch_p=float(params.get("nuisance.timing_glitch_probability")),
    )
    w.form_id = occ.form_id
    _onboarding(w, person, slot, rng)
    style = style_vector if style_vector is not None else _unit(rng.normal(size=4)) * 2.0
    order: Sequence[str] = (*B_CORE, slot) if pathway == "B" and slot else A_ORDER
    if pathway == "A" and include_coplay:
        order = (*A_ORDER, "coplay")
    modules: Mapping[str, ModuleFn] = B_MODULES if pathway == "B" else A_MODULES
    walk_p = float(params.get("nuisance.walkaway_probability"))
    walk_at = int(rng.integers(0, len(order))) if rng.random() < walk_p else None
    walked = False
    for k, module in enumerate(order):
        if walk_at is not None and k == walk_at:
            w.emit("walkaway.prompted", {"stage": "reprompt", "elapsed_idle_ms": 8000.0})
            w.advance(45000)
            w.emit("walkaway.prompted", {"stage": "countdown", "elapsed_idle_ms": 45000.0})
            w.emit(
                "session.abandoned",
                {
                    "last_state": "play",
                    "module_id": module,
                    "trial_id": None,
                    "elapsed_ms": round(w.t, 3),
                    "reason": "timeout",
                },
            )
            walked = True
            break
        modules[module](w, person, rng, params, occ=occ, style=style)
        w.advance(5000)
    w.emit("session_end", {"reason": "abandoned" if walked else "completed", "duration_ms": round(w.t, 3)})
    return SimulatedSession(
        session_id=w.session_id,
        person=person,
        pathway=pathway,
        occasion=occ.index,
        slot_form=slot,
        events=w.events,
        trial_params=w.trial_params,
        walked_away=walked,
    )


def simulate_study(
    n: int,
    pathway: Literal["A", "B"],
    *,
    seed: int,
    params: SimParams | None = None,
    occasions: int = 1,
    stability: float | Mapping[str, float] | None = None,
    slot_form: str | None = None,
    strategies: Mapping[Strategy, int] | None = None,
    language: str | None = None,
    group_offsets: Mapping[str, Mapping[str, float]] | None = None,
    include_coplay: bool = False,
    persons: Sequence[Person] | None = None,
) -> SimulatedStudy:
    """Simulate ``n`` persons for one pathway, optionally with retest occasions (parallel form, practice shift).

    Occasion-2 latents follow ``retest_person`` with ``stability`` (default ``retest.default_stability``);
    stable style vectors are kept across occasions.
    """
    prm = params or load_sim_params()
    rng = np.random.default_rng(seed)
    people = (
        list(persons)
        if persons is not None
        else sample_population(n, prm, rng, strategies=strategies, language=language, group_offsets=group_offsets)
    )
    # Stable style vectors have a fixed length so that persistence (segment weight) is the only person
    # difference in profile stability.
    styles = {p.pid: _unit(rng.normal(size=4)) * 2.0 for p in people}
    # Planned-missingness slot: one per person, kept at retest (T2 lock).
    slots = {p.pid: slot_form or str(rng.choice(B_SLOTS)) for p in people}
    sessions: list[SimulatedSession] = []
    by_occ: dict[int, dict[str, Person]] = {1: {p.pid: p for p in people}}
    stab = stability if stability is not None else float(prm.get("retest.default_stability"))
    idx = 0
    for occ_i in range(1, occasions + 1):
        occ = Occasion(
            index=occ_i,
            practice_log_rt=0.0 if occ_i == 1 else float(prm.get("retest.practice_log_rt")),
            form_id="form_1" if occ_i == 1 else "form_2",
        )
        if occ_i > 1:
            by_occ[occ_i] = {pid: retest_person(p, rng, stab) for pid, p in by_occ[1].items()}
        for p in by_occ[occ_i].values():
            sessions.append(
                simulate_session(
                    p,
                    pathway,
                    rng,
                    prm,
                    occasion=occ,
                    slot_form=slots[p.pid],
                    include_coplay=include_coplay,
                    session_index=idx,
                    mode="pilot" if occ_i == 1 else "retest",
                    style_vector=styles[p.pid],
                )
            )
            idx += 1
    return SimulatedStudy(
        persons=people, sessions=sessions, params_sha256=prm.sha256, seed=seed, occasion_persons=by_occ
    )
