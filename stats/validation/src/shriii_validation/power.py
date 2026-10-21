"""Power and sample-size utilities (VAL-02).

* correlation lower-bound tests (H0: rho <= r0 vs rho = r1, one-sided, Fisher z), with Holm per-test alpha;
* ICC confidence-interval half-width and the n needed for a target half-width (Bonett, 2002);
* simulation power for logistic-regression DIF, returned as a sample-size record.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import stats

from shriii_validation.fairness import logistic_dif

__all__ = [
    "DIFPowerRecord",
    "dif_power_simulation",
    "icc_ci_halfwidth",
    "n_for_correlation_lower_bound",
    "n_for_icc_halfwidth",
    "power_correlation_lower_bound",
]


def n_for_correlation_lower_bound(r1: float, r0: float, *, alpha: float = 0.05, power: float = 0.8) -> int:
    """n for a one-sided Fisher-z test of H0: rho <= r0 when the true correlation is r1."""
    za = float(stats.norm.ppf(1 - alpha))
    zb = float(stats.norm.ppf(power))
    return math.ceil(((za + zb) / (math.atanh(r1) - math.atanh(r0))) ** 2 + 3)


def power_correlation_lower_bound(n: int, r1: float, r0: float, *, alpha: float = 0.05) -> float:
    """Power of the one-sided lower-bound test at sample size n."""
    za = stats.norm.ppf(1 - alpha)
    return float(stats.norm.cdf((math.atanh(r1) - math.atanh(r0)) * math.sqrt(n - 3) - za))


def icc_ci_halfwidth(n: int, icc: float, *, k: int = 2, ci_level: float = 0.95) -> float:
    """Approximate CI half-width of an ICC from n targets and k ratings (Bonett, 2002)."""
    z = stats.norm.ppf(0.5 + ci_level / 2)
    var = 2 * (1 - icc) ** 2 * (1 + (k - 1) * icc) ** 2 / (k * (k - 1) * (n - 1))
    return float(z * math.sqrt(var))


def n_for_icc_halfwidth(icc: float, halfwidth: float, *, k: int = 2, ci_level: float = 0.95) -> int:
    """n targets needed for a desired ICC CI half-width (Bonett, 2002)."""
    z = float(stats.norm.ppf(0.5 + ci_level / 2))
    w = 2 * halfwidth
    return math.ceil(8 * z**2 * (1 - icc) ** 2 * (1 + (k - 1) * icc) ** 2 / (k * (k - 1) * w**2) + 1)


@dataclass(frozen=True, slots=True)
class DIFPowerRecord:
    """Simulated DIF detection rate for a planted effect (sample-size record)."""

    n_per_group: int
    n_items: int
    uniform_shift: float
    nonuniform_slope: float
    replications: int
    detection_rate: float
    false_positive_rate: float
    alpha: float
    seed: int


def dif_power_simulation(
    n_per_group: int,
    *,
    n_items: int = 20,
    uniform_shift: float = 0.6,
    nonuniform_slope: float = 0.0,
    replications: int = 100,
    alpha: float = 0.05,
    seed: int = 0,
) -> DIFPowerRecord:
    """2PL data with one planted DIF item (item 0); detection = item 0 flagged; false positives = share of
    the other items flagged, averaged over replications."""
    rng = np.random.default_rng(seed)
    hits = 0
    fp = 0.0
    for _ in range(replications):
        n = 2 * n_per_group
        group = np.repeat([0, 1], n_per_group)
        theta = rng.normal(size=n)
        a = rng.uniform(0.8, 2.0, n_items)
        b = rng.normal(0, 1, n_items)
        logits = a[None, :] * (theta[:, None] - b[None, :])
        logits[:, 0] += group * (-uniform_shift * a[0] + nonuniform_slope * theta)
        y = (rng.random((n, n_items)) < 1 / (1 + np.exp(-logits))).astype(float)
        res = logistic_dif(y, group, alpha=alpha)
        flagged = {i.item for i in res.items if i.flagged}
        hits += "item_0" in flagged
        fp += len(flagged - {"item_0"}) / (n_items - 1)
    return DIFPowerRecord(
        n_per_group,
        n_items,
        uniform_shift,
        nonuniform_slope,
        replications,
        hits / replications,
        fp / replications,
        alpha,
        seed,
    )
