"""SHRIII contracts for Python: Pydantic v2 models generated from the canonical JSON Schemas.

* ``packages/contracts/schemas/*.v1.schema.json`` are canonical; ``_generated.py`` is produced by
  :mod:`shriii_contracts.codegen` and checked for drift in tests.
* Models are tolerant readers (unknown minor-N+1 fields are kept in ``model_extra``); use
  :func:`parse_event` with ``strict=True`` or :func:`assert_no_unknown_fields` on the writer side.
* :mod:`shriii_contracts.schema_validation` validates raw JSON with ``jsonschema`` (strict/reader).
"""

from __future__ import annotations

from typing import Any, Final

from pydantic import BaseModel, TypeAdapter

from shriii_contracts._base import FORBIDDEN_FIELD_NAMES, ContractModel
from shriii_contracts._generated import *  # noqa: F403  (re-export every generated model/alias)
from shriii_contracts._generated import (
    ConsentArtefact,
    ContentManifest,
    CriterionResponse,
    CriterionScaleScore,
    EventEnvelope,
    EventType,
    GameConfig,
    GameTrialSpec,
    Gates,
    Hypotheses,
    Instrument,
    ReleasePack,
    ReportArtefact,
    ScoringDictionaryPathway,
    ScoringDictionaryShared,
    SessionContext,
    SessionPlan,
    UploadBatch,
    UploadBatchResult,
    VoiceLineCatalogue,
)
from shriii_contracts._generated import __all__ as _generated_all
from shriii_contracts.invariants import (
    InvariantViolation,
    check_event_invariants,
    check_session_sequence,
    check_trial_spec_invariants,
    find_forbidden_field_names,
)
from shriii_contracts.strictness import (
    UnknownFieldsError,
    assert_no_unknown_fields,
    payload_ext,
    unknown_fields,
)

__version__ = "1.0.0"
SCHEMA_VERSION: Final = "1.0"

EVENT_ADAPTER: Final[TypeAdapter[EventEnvelope]] = TypeAdapter(EventEnvelope)
"""TypeAdapter for the discriminated event union."""

EVENT_TYPES: Final[tuple[str, ...]] = tuple(EventType.__args__)  # type: ignore[attr-defined]
"""Every v1 event type."""

CONTRACT_MODELS: Final[dict[str, type[ContractModel]]] = {
    "upload-batch": UploadBatch,
    "upload-batch-result": UploadBatchResult,
    "session-context": SessionContext,
    "content-manifest": ContentManifest,
    "game-trial-spec": GameTrialSpec,
    "criterion-response": CriterionResponse,
    "criterion-scale-score": CriterionScaleScore,
    "consent-artefact": ConsentArtefact,
    "report-artefact": ReportArtefact,
    "release-pack": ReleasePack,
    "scoring-dictionary-shared": ScoringDictionaryShared,
    "scoring-dictionary-pathway": ScoringDictionaryPathway,
    "hypotheses": Hypotheses,
    "gates": Gates,
    "instrument": Instrument,
    "game-config": GameConfig,
    "voice-line-catalogue": VoiceLineCatalogue,
    "session-plan": SessionPlan,
}
"""Contract name (kebab-case, matching fixture folders) -> model class (events use EVENT_ADAPTER)."""


def parse_event(data: Any, *, strict: bool = False) -> EventEnvelope:
    """Parse one event. ``strict=True`` also rejects unknown fields (writer side)."""
    event = EVENT_ADAPTER.validate_python(data)
    if strict:
        assert_no_unknown_fields(event)
    return event


def parse_contract(contract: str, data: Any, *, strict: bool = False) -> BaseModel:
    """Parse any contract by kebab-case name (``event-envelope`` included)."""
    if contract == "event-envelope":
        return parse_event(data, strict=strict)
    model = CONTRACT_MODELS[contract].model_validate(data)
    if strict:
        assert_no_unknown_fields(model)
    return model


__all__ = [  # noqa: PLE0604
    *_generated_all,
    "CONTRACT_MODELS",
    "EVENT_ADAPTER",
    "EVENT_TYPES",
    "FORBIDDEN_FIELD_NAMES",
    "SCHEMA_VERSION",
    "ContractModel",
    "InvariantViolation",
    "UnknownFieldsError",
    "__version__",
    "assert_no_unknown_fields",
    "check_event_invariants",
    "check_session_sequence",
    "check_trial_spec_invariants",
    "find_forbidden_field_names",
    "parse_contract",
    "parse_event",
    "payload_ext",
    "unknown_fields",
]
