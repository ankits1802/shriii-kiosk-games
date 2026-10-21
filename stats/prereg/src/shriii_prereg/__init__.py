"""SHRIII pre-registration generator (CRT-11).

Builds an OSF-style pre-registration document (Markdown + HTML + a JSON manifest) directly from the
frozen science inputs: ``stats/measurement-model/hypotheses.yaml``, ``stats/measurement-model/gates.yaml``
and ``stats/measurement-model/dictionary/*.yaml``.
The inputs are read-only; the SHA-256 of every input is embedded in each output so that a registered
document can later be verified against the repository (``shriii-prereg verify``).
"""

from __future__ import annotations

from shriii_prereg._version import GENERATOR_VERSION
from shriii_prereg.build import PreregBuildError, build_document
from shriii_prereg.inputs import InputFile, PreregInputs, load_inputs
from shriii_prereg.render import render_document, write_outputs
from shriii_prereg.verify import VerificationResult, verify_document

__all__ = [
    "GENERATOR_VERSION",
    "InputFile",
    "PreregBuildError",
    "PreregInputs",
    "VerificationResult",
    "build_document",
    "load_inputs",
    "render_document",
    "verify_document",
    "write_outputs",
]
