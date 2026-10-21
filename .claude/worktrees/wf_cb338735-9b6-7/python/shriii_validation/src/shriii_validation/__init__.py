"""Psychometric validation engine (layer 4 evidence): reliability, validity, structure, fairness,
prediction, norming, power and the gate evaluator.

Every analysis returns a typed :class:`~shriii_validation.results.EvidenceResult` (estimate, CI, n, method,
assumption checks, warnings and provenance). Analyses that need R go through
:mod:`shriii_validation.rbackend` and return explicit ``not_available`` results until R is installed.
"""

from shriii_validation._version import VALIDATION_ALGORITHM_VERSION
from shriii_validation.results import AssumptionCheck, EvidenceResult, Provenance

__all__ = ["VALIDATION_ALGORITHM_VERSION", "AssumptionCheck", "EvidenceResult", "Provenance", "__version__"]

__version__ = "0.1.0"
