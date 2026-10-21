"""Python bridge to the shriiipsy R psychometrics backend (plan VAL-01).

:class:`RscriptBackend` implements :class:`shriii_validation.rbackend.RBackend` (measurement invariance,
IRT DIF, continuous norms, Bayesian approximate invariance) and adds typed wrappers for graded response
models, lordif, GLMM DIF, person random slopes and the R/Python reliability cross-check. It runs the
pinned Docker image (``infra/docker/r-psychometrics.Dockerfile``) or a local Rscript.
"""

from shriii_rbridge._version import BRIDGE_VERSION, DEFAULT_IMAGE, REQUEST_SCHEMA, RESULT_SCHEMA
from shriii_rbridge.backend import RscriptBackend, backend_from_env
from shriii_rbridge.runner import DockerRunner, LocalRscriptRunner, RRunError, RRunner
from shriii_rbridge.thresholds import ThresholdSet, project_thresholds

__all__ = [
    "BRIDGE_VERSION",
    "DEFAULT_IMAGE",
    "REQUEST_SCHEMA",
    "RESULT_SCHEMA",
    "DockerRunner",
    "LocalRscriptRunner",
    "RRunError",
    "RRunner",
    "RscriptBackend",
    "ThresholdSet",
    "__version__",
    "backend_from_env",
    "project_thresholds",
]

__version__ = BRIDGE_VERSION
