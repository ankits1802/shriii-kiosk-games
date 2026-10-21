"""Psychometric validation engine (layer 4 evidence): reliability, validity, structure, fairness,
prediction, norming, power and the gate evaluator.

Every analysis returns a typed :class:`~shriii_validation.results.EvidenceResult` (estimate, CI, n, method,
assumption checks, warnings and provenance). Analyses that need R go through
:mod:`shriii_validation.rbackend` and return explicit ``not_available`` results until R is installed.

Entry points used by the API worker (snapshot frames in, persisted rows out):

* :func:`run_analysis` - one named analysis on a snapshot frame (:mod:`shriii_validation.analysis`);
* :func:`train_model` / :func:`generate_norms` - predictive models and provisional norms
  (:mod:`shriii_validation.modeling`);
* :func:`evaluate_gates` - trait and battery gates from persisted results (:mod:`shriii_validation.evidence`).
"""

from shriii_validation._version import VALIDATION_ALGORITHM_VERSION
from shriii_validation.analysis import ANALYSES, ENGINE, AnalysisReport, ResultRecord, run_analysis
from shriii_validation.evidence import evaluate_gates
from shriii_validation.modeling import generate_norms, train_model
from shriii_validation.results import AssumptionCheck, EvidenceResult, Provenance

__all__ = [
    "ANALYSES",
    "ENGINE",
    "VALIDATION_ALGORITHM_VERSION",
    "AnalysisReport",
    "AssumptionCheck",
    "EvidenceResult",
    "Provenance",
    "ResultRecord",
    "__version__",
    "evaluate_gates",
    "generate_norms",
    "run_analysis",
    "train_model",
]

__version__ = "0.1.0"
