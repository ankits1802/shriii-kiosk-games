"""Layer 2 (behavioural indicators) and layer 3 (criterion scale scores) engine, plus the layer 5 band
reference.

* :class:`~shriii_scoring.engine.IndicatorEngine` - raw events -> versioned indicator rows (SCR-02..SCR-13);
* :func:`~shriii_scoring.criterion.score_criterion` - item responses -> criterion scale scores (CRT-04);
* :mod:`shriii_scoring.bands` - composites, bands and the SEM "not enough to say" rule (REP-01 reference);
* :mod:`shriii_scoring.conventions` - the event vocabularies the formulas rely on.
"""

from shriii_scoring._version import BAND_ALGORITHM_VERSION, CRITERION_ALGORITHM_VERSION, INDICATOR_ALGORITHM_VERSION
from shriii_scoring.criterion import CriterionScoringResult, score_criterion
from shriii_scoring.dictionary import Dictionary, IndicatorSpec, load_dictionary
from shriii_scoring.engine import GroupIndicatorRow, IndicatorEngine, IndicatorRow, ScoringResult, score_events
from shriii_scoring.params import ScoringParams, load_params

__all__ = [
    "BAND_ALGORITHM_VERSION",
    "CRITERION_ALGORITHM_VERSION",
    "INDICATOR_ALGORITHM_VERSION",
    "CriterionScoringResult",
    "Dictionary",
    "GroupIndicatorRow",
    "IndicatorEngine",
    "IndicatorRow",
    "IndicatorSpec",
    "ScoringParams",
    "ScoringResult",
    "__version__",
    "load_dictionary",
    "load_params",
    "score_criterion",
    "score_events",
]

__version__ = "0.1.0"
