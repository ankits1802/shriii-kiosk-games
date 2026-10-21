"""Write the language pack's ASR config (``asr-config.<lang>.json``) from bake-off results (VOX-06 AC:
"the policy is written into the ASR config of the language pack").

The format is the ``AsrGrammar`` consumed by ``frontend/packages/asr-sherpa`` (validated here against
schemas/asr-config.schema.json, which mirrors the adapter's ``parseGrammar``). Only a sherpa-onnx KWS
engine can drive the kiosk adapter; when no such engine passes for a language, a touch-only config is
written (every prompt ``voice_enabled: false``), so the pilot runs touch only with no code change.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shriii_asr_bakeoff.config import Policy, Vocabulary
from shriii_asr_bakeoff.metrics import monotone_precision
from shriii_asr_bakeoff.runner import EngineLanguageArtifacts
from shriii_asr_bakeoff.schema import validate

KWS_KINDS = {"sherpa_kws"}
TOUCH_ONLY_PREFIXES = ("consent.", "optin.", "bands.", "report.private", "private.")


def _runtime(policy: Policy) -> dict[str, float]:
    return {
        "min_propose_confidence": policy.propose_min_precision,
        "min_commit_confidence": policy.commit_min_precision,
        "noise_max_dbfs": policy.runtime["noise_max_dbfs"],
        "max_listen_ms": policy.runtime["max_listen_ms"],
        "vad_preroll_ms": policy.runtime["vad_preroll_ms"],
        "settle_ms": policy.runtime["settle_ms"],
    }


def _tiers(art: EngineLanguageArtifacts) -> list[dict[str, float]]:
    """Propose and commit tiers with their calibrated (monotone) precision as confidence."""
    rows = {r["threshold"]: r for r in monotone_precision(art.calibration)}
    tiers: list[dict[str, float]] = []
    for thr in (art.propose_threshold, art.commit_threshold):
        if thr is None or rows.get(thr, {}).get("precision") is None:
            continue
        if tiers and thr <= tiers[-1]["keywords_threshold"]:
            continue
        tiers.append({"keywords_threshold": float(thr), "confidence": float(rows[thr]["precision"])})
    return tiers


def build_asr_config(
    language: str,
    results: dict[str, Any],
    artifacts: list[EngineLanguageArtifacts],
    vocab: Vocabulary,
    policy: Policy,
    grammar_version: str,
) -> dict[str, Any]:
    winner = results["winners"].get(language, {}).get("engine_id")
    art = next((a for a in artifacts if a.engine_id == winner and a.language == language), None)
    prompts_result: dict[str, bool] = {}
    if art is not None and art.kind in KWS_KINDS:
        for e in results["engines"]:
            if e["engine_id"] != winner:
                continue
            for lr in e["languages"]:
                if lr["language"] == language:
                    prompts_result = {p["prompt_id"]: p["voice_enabled"] for p in lr["prompts"]}
    tiers = _tiers(art) if art is not None and art.kind in KWS_KINDS else []
    usable = art is not None and art.kind in KWS_KINDS and bool(tiers) and bool(art.keyword_tokens)

    if usable:
        assert art is not None
        keywords = {
            code: {
                "phrases": [
                    {"tokens": tok, "text": text}
                    for tok, text in zip(art.keyword_tokens[code], vocab.phrases(language, code), strict=True)
                ]
            }
            for code in sorted(art.keyword_tokens)
        }
        engine, model_id = "sherpa-onnx-kws", art.model_id
    else:
        # Touch-only pack: phrases are listed for review but no engine is configured.
        keywords = {
            code: {"phrases": [{"tokens": "_".join(p.split()), "text": p} for p in vocab.phrases(language, code)]}
            for code in vocab.codes(language)
        }
        tiers = [{"keywords_threshold": 1.0, "confidence": 0.0}]
        engine, model_id = "none", "none"
    prompts = {
        pid: {
            "vocabulary": list(codes),
            "voice_enabled": bool(
                usable and prompts_result.get(pid, False) and not pid.startswith(TOUCH_ONLY_PREFIXES)
            ),
        }
        for pid, codes in vocab.prompts.items()
    }
    config = {
        "schema_version": "1.0",
        "language": language,
        "grammar_version": grammar_version,
        "engine": engine,
        "model_id": model_id,
        "keywords": keywords,
        "tiers": tiers,
        "prompts": prompts,
        "policy": _runtime(policy),
        "provenance": {
            "bakeoff_run_id": results["run_id"],
            "dataset_id": results["dataset"]["dataset_id"],
            "dataset_kind": results["dataset"]["kind"],
            "policy_sha256": results["policy"]["file_sha256"],
            "winner_engine_id": winner,
        },
    }
    validate(config, "asr-config.schema.json")
    return config


def write_asr_configs(
    out_dir: Path,
    results: dict[str, Any],
    artifacts: list[EngineLanguageArtifacts],
    vocab: Vocabulary,
    policy: Policy,
    grammar_version: str = "0.1.0",
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for language in sorted(results["winners"]):
        cfg = build_asr_config(language, results, artifacts, vocab, policy, grammar_version)
        p = out_dir / f"asr-config.{language}.json"
        p.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        paths.append(p)
    return paths
