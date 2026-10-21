"""Synthetic players with known latent trait parameters (QA-02).

Latents for the 17 constructs are multivariate normal with a configurable correlation matrix; nuisance
factors (general ability, motor speed, device familiarity, language, literacy, demographics) are drawn
independently. Gaming strategies (speed tapper, same-position tapper, always-share, over-reporter) and an
``optimal`` bot are supported for flag and solver checks.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from shriii_simulator.ids import pid as make_pid
from shriii_simulator.params import SimParams

__all__ = ["CONSTRUCTS", "Person", "Strategy", "correlation_matrix", "retest_person", "sample_population"]

CONSTRUCTS: tuple[str, ...] = (
    "self_control",
    "emotional_regulation",
    "composure",
    "response_consistency",
    "task_organisation",
    "decisiveness",
    "adaptability",
    "persistence_of_style",
    "stability",
    "expressive_restraint",
    "teamwork",
    "judgement",
    "problem_solving",
    "integrity",
    "initiative",
    "risk_preference",
    "persistence",
)

Strategy = Literal["normal", "speed_tapper", "same_position", "always_share", "over_reporter", "optimal"]


@dataclass(frozen=True, slots=True)
class Person:
    """One synthetic player: planted latents (z-scores) plus nuisance factors."""

    pid: str
    latent: Mapping[str, float]
    ability: float
    speed: float
    language: str
    literacy: str
    age_band: str
    edu_band: str
    gender: str
    device_familiarity: str
    strategy: Strategy = "normal"
    group_offsets: Mapping[str, float] = field(default_factory=dict)

    def z(self, construct: str) -> float:
        return float(self.latent[construct])


def correlation_matrix(params: SimParams, constructs: Sequence[str] = CONSTRUCTS) -> NDArray[np.float64]:
    """Latent correlation matrix from ``latent.correlations`` (projected to the nearest PD matrix)."""
    idx = {c: i for i, c in enumerate(constructs)}
    r = np.eye(len(constructs))
    for a, b, value in params.get("latent.correlations"):
        if a in idx and b in idx:
            r[idx[a], idx[b]] = r[idx[b], idx[a]] = float(value)
    w, v = np.linalg.eigh(r)
    if w.min() <= 1e-8:
        w = np.clip(w, 1e-6, None)
        r = v @ np.diag(w) @ v.T
        d = np.sqrt(np.diag(r))
        r = r / np.outer(d, d)
    return r


def _choice(rng: np.random.Generator, values: Sequence[str], weights: Sequence[float]) -> str:
    p = np.asarray(weights, dtype=float)
    return str(values[int(rng.choice(len(values), p=p / p.sum()))])


def sample_population(
    n: int,
    params: SimParams,
    rng: np.random.Generator,
    *,
    strategies: Mapping[Strategy, int] | None = None,
    language: str | None = None,
    group_offsets: Mapping[str, Mapping[str, float]] | None = None,
) -> list[Person]:
    """Draw ``n`` persons; ``strategies`` assigns that many persons each gaming strategy (the rest normal).

    ``group_offsets`` maps a language to latent mean offsets (e.g. to plant group differences).
    """
    r = correlation_matrix(params)
    z = rng.multivariate_normal(np.zeros(len(CONSTRUCTS)), r, size=n)
    nu = params.get("nuisance")
    people: list[Person] = []
    plan: list[Strategy] = []
    for s, k in (strategies or {}).items():
        plan.extend([s] * k)
    plan.extend(["normal"] * (n - len(plan)))
    for i in range(n):
        lang = language or _choice(rng, nu["languages"], nu["language_weights"])
        offsets = dict((group_offsets or {}).get(lang, {}))
        latent = {c: float(z[i, j]) + offsets.get(c, 0.0) for j, c in enumerate(CONSTRUCTS)}
        people.append(
            Person(
                pid=make_pid(rng),
                latent=latent,
                ability=float(rng.normal()),
                speed=float(rng.normal()),
                language=lang,
                literacy=_choice(rng, nu["literacy_bands"], nu["literacy_weights"]),
                age_band=_choice(rng, nu["age_bands"], nu["age_weights"]),
                edu_band=_choice(rng, nu["edu_bands"], nu["edu_weights"]),
                gender=_choice(rng, nu["genders"], nu["gender_weights"]),
                device_familiarity=_choice(rng, nu["device_familiarity"], nu["device_weights"]),
                strategy=plan[i],
                group_offsets=offsets,
            )
        )
    return people


def retest_person(
    person: Person,
    rng: np.random.Generator,
    stability: float | Mapping[str, float],
) -> Person:
    """Occasion-2 latents: ``z2 = s * z1 + sqrt(1 - s^2) * e`` per construct (corr(z1, z2) = s)."""
    out: dict[str, float] = {}
    for c, v in person.latent.items():
        s = float(stability[c]) if isinstance(stability, Mapping) else float(stability)
        out[c] = s * v + float(np.sqrt(max(0.0, 1.0 - s * s))) * float(rng.normal())
    return replace(person, latent=out)
