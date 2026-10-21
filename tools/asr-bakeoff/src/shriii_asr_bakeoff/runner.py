"""Bake-off runner: engines x languages x SNR conditions -> trials -> calibrated metrics -> policy verdicts.

Speaker splits per language (no speaker appears in two roles):
* ``enroll`` speakers, first half: enrolment templates (only template engines use them);
* ``enroll`` speakers, second half: calibration trials, from which each engine's propose/commit
  thresholds are chosen at the policy's precision targets;
* ``heldout`` speakers: every reported accuracy, false-accept rate, subgroup gap and policy verdict.

Every engine hears byte-identical mixtures: noise offsets are seeded by (run seed, utterance, SNR).
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
import time
from collections import defaultdict
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import psutil

from shriii_asr_bakeoff.audio import RATE, Audio, load_16k, mix_at_snr, noise_window
from shriii_asr_bakeoff.config import Conditions, EngineSpec, Policy, Snr, Vocabulary
from shriii_asr_bakeoff.dataset import Dataset, SpeakerRow, UtteranceRow
from shriii_asr_bakeoff.engines import Engine, Enrollment, create_engine
from shriii_asr_bakeoff.metrics import (
    Scored,
    calibration,
    operating_threshold,
    percentile,
    proportion,
)
from shriii_asr_bakeoff.schema import validate
from shriii_asr_bakeoff.synth import market_noise

REFERENCE_SPEECH_DBFS = -20.0


@dataclass(slots=True)
class Trial:
    engine_id: str
    language: str
    split: str
    prompt_id: str
    kind: str  # keyword | oov | noise_only
    truth: str | None
    snr_db: Snr
    utterance_id: str | None
    speaker_id: str | None
    label: str | None
    score: float | None
    latency_ms: float
    audio_s: float
    cpu_ms: float


@dataclass(slots=True)
class EngineLanguageArtifacts:
    """What the config emitter needs beyond the results JSON."""

    engine_id: str
    kind: str
    language: str
    model_id: str
    propose_threshold: float | None
    commit_threshold: float | None
    calibration: list[dict[str, Any]]
    keyword_tokens: dict[str, list[str]] = field(default_factory=dict)


@dataclass(slots=True)
class RunOutput:
    results: dict[str, Any]
    artifacts: list[EngineLanguageArtifacts]
    trials_path: Path


def _seed(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "little")


def load_noise(conditions: Conditions) -> tuple[Audio, str]:
    files = sorted(conditions.noise_dir.glob("*.wav")) if conditions.noise_dir.is_dir() else []
    if files:
        return np.concatenate([load_16k(f) for f in files]).astype(np.float32), "recorded"
    if not conditions.synthetic_fallback:
        raise FileNotFoundError(f"no noise recordings in {conditions.noise_dir} and synthetic fallback is off")
    return market_noise(60.0, np.random.default_rng(conditions.seed)), "synthetic"


def _split_enroll(speakers: list[SpeakerRow]) -> tuple[set[str], set[str]]:
    ids = sorted(s.speaker_id for s in speakers)
    if len(ids) < 2:
        return set(ids), set(ids)
    half = len(ids) // 2
    return set(ids[:half]), set(ids[half:])


class _Meter:
    def __init__(self) -> None:
        self.proc = psutil.Process()
        self.peak = 0.0

    def sample(self) -> None:
        mi = self.proc.memory_info()
        self.peak = max(self.peak, float(getattr(mi, "peak_wset", mi.rss)) / 2**20)


def _recognize(engine: Engine, audio: Audio, codes: list[str]) -> tuple[str | None, float | None, float, float]:
    c0, t0 = time.process_time(), time.perf_counter()
    rec = engine.recognize(audio, codes)
    t1, c1 = time.perf_counter(), time.process_time()
    return rec.label, rec.score, 1000 * (t1 - t0), 1000 * (c1 - c0)


def run_engine_language(
    engine: Engine,
    language: str,
    dataset: Dataset,
    vocab: Vocabulary,
    conditions: Conditions,
    noise: Audio,
    meter: _Meter,
    progress: Callable[[str], None] | None = None,
) -> Iterator[Trial]:
    template_ids, calib_ids = _split_enroll(dataset.speakers_for(language, "enroll"))
    heldout_ids = {s.speaker_id for s in dataset.speakers_for(language, "heldout")}
    utts = [u for u in dataset.utterances if u.language == language]
    phrases = {c: vocab.phrases(language, c) for c in vocab.codes(language)}
    enrollment = [
        Enrollment(load_16k(u.file), u.code)
        for u in utts
        if u.speaker_id in template_ids and u.kind == "keyword" and u.code is not None
    ]
    engine.prepare(language, phrases, enrollment)
    meter.sample()
    cache: dict[str, Audio] = {}

    def clean(u: UtteranceRow) -> Audio:
        if u.utterance_id not in cache:
            cache[u.utterance_id] = load_16k(u.file)
        return cache[u.utterance_id]

    def condition(u: UtteranceRow, snr: Snr) -> Audio:
        x = clean(u)
        if snr == "clean":
            return x
        rng = np.random.default_rng(_seed(conditions.seed, u.utterance_id, snr))
        return mix_at_snr(x, noise, float(snr), rng).audio

    for split, ids in (("calib", calib_ids), ("heldout", heldout_ids)):
        subset = [u for u in utts if u.speaker_id in ids]
        for snr in conditions.snr_db:
            if progress:
                progress(f"{engine.id} {language} {split} snr={snr}")
            for prompt_id, codes in vocab.prompts.items():
                code_list = list(codes)
                for u in subset:
                    if u.kind == "keyword" and u.code not in code_list:
                        continue
                    audio = condition(u, snr)
                    label, score, lat, cpu = _recognize(engine, audio, code_list)
                    yield Trial(
                        engine.id,
                        language,
                        split,
                        prompt_id,
                        u.kind,
                        u.code,
                        snr,
                        u.utterance_id,
                        u.speaker_id,
                        label,
                        score,
                        lat,
                        audio.size / RATE,
                        cpu,
                    )
                if snr == "clean":
                    continue
                n_noise = (
                    conditions.noise_only_per_prompt if split == "heldout" else conditions.noise_only_per_prompt // 2
                )
                for k in range(n_noise):
                    rng = np.random.default_rng(_seed(conditions.seed, "noise", language, prompt_id, snr, split, k))
                    audio = noise_window(noise, conditions.window_s, REFERENCE_SPEECH_DBFS - float(snr), rng)
                    label, score, lat, cpu = _recognize(engine, audio, code_list)
                    yield Trial(
                        engine.id,
                        language,
                        split,
                        prompt_id,
                        "noise_only",
                        None,
                        snr,
                        None,
                        None,
                        label,
                        score,
                        lat,
                        audio.size / RATE,
                        cpu,
                    )
            meter.sample()


def _gap(groups: dict[str, dict[str, Any]], min_speakers: int) -> tuple[float | None, bool]:
    """Max-min accuracy gap in pp among qualified groups; second value False if any group is under-sampled."""
    qualified = [g for g in groups.values() if g["speakers"] >= min_speakers and g["accuracy"]["p"] is not None]
    all_ok = all(g["speakers"] >= min_speakers for g in groups.values())
    if len(qualified) < 2:
        return None, all_ok and len(qualified) >= 1
    ps = [g["accuracy"]["p"] for g in qualified]
    return round(100 * (max(ps) - min(ps)), 3), all_ok


def summarise(
    trials: list[Trial],
    language: str,
    dataset: Dataset,
    vocab: Vocabulary,
    policy: Policy,
    conditions: Conditions,
    peak_rss_mb: float,
) -> tuple[dict[str, Any], float | None, float | None, list[dict[str, Any]]]:
    calib = [t for t in trials if t.split == "calib"]
    held = [t for t in trials if t.split == "heldout"]
    cal_rows = calibration(Scored(t.label, t.score, t.truth) for t in calib)
    theta_p = operating_threshold(cal_rows, policy.propose_min_precision)
    theta_c = operating_threshold(cal_rows, policy.commit_min_precision)
    thr = theta_p if theta_p is not None else float("inf")
    lvl = policy.ci_level

    def ok(t: Trial) -> bool:
        return Scored(t.label, t.score, t.truth).correct(thr)

    def accepted(t: Trial) -> bool:
        return Scored(t.label, t.score, t.truth).accepted(thr)

    accuracy = []
    false_accepts = []
    for snr in conditions.snr_db:
        kw = [t for t in held if t.kind == "keyword" and t.snr_db == snr]
        confusions: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for t in kw:
            if accepted(t) and t.label != t.truth:
                confusions[str(t.truth)][str(t.label)] += 1
        accuracy.append(
            {
                "snr_db": snr,
                "accuracy": proportion(sum(ok(t) for t in kw), len(kw), lvl),
                "rejections": sum(1 for t in kw if not accepted(t)),
                "confusions": {k: dict(v) for k, v in confusions.items()},
            }
        )
        for source in ("noise_only", "oov"):
            neg = [t for t in held if t.kind == source and t.snr_db == snr]
            if neg:
                false_accepts.append(
                    {"snr_db": snr, "source": source, "rate": proportion(sum(accepted(t) for t in neg), len(neg), lvl)}
                )

    ref = policy.reference_snr_db
    speakers = dataset.speakers

    def subgroup_table(rows: list[Trial]) -> dict[str, dict[str, dict[str, Any]]]:
        table: dict[str, dict[str, dict[str, Any]]] = {}
        for fld in policy.subgroup_fields:
            groups: dict[str, list[Trial]] = defaultdict(list)
            for t in rows:
                if t.speaker_id:
                    groups[speakers[t.speaker_id].group(fld)].append(t)
            table[fld] = {
                g: {
                    "speakers": len({t.speaker_id for t in ts}),
                    "accuracy": proportion(sum(ok(t) for t in ts), len(ts), lvl),
                }
                for g, ts in sorted(groups.items())
            }
        return table

    ref_kw = [t for t in held if t.kind == "keyword" and t.snr_db == ref]
    sub = subgroup_table(ref_kw)
    subgroups = [
        {"field": f, "group": g, "speakers": v["speakers"], "accuracy": v["accuracy"]}
        for f, groups in sub.items()
        for g, v in groups.items()
    ]
    gap_pp = {f: _gap(groups, policy.min_speakers_per_subgroup)[0] for f, groups in sub.items()}

    lat = [t.latency_ms for t in held]
    rtf = [t.latency_ms / 1000 / t.audio_s for t in held if t.audio_s > 0]
    audio_s = sum(t.audio_s for t in held)
    heldout_speakers = len({s.speaker_id for s in dataset.speakers_for(language, "heldout")})
    # False-accept gate: per noisy SNR condition (keyword-free trials pooled across sources), judged at
    # the reference SNR only or at every condition (worst case), as the policy says.
    fa_snrs = [s for s in conditions.snr_db if s != "clean"]
    if policy.false_accept_judge_at == "reference":
        fa_snrs = [s for s in fa_snrs if s == ref]
    fa_by_snr: list[tuple[Snr, dict[str, Any]]] = []
    for snr in fa_snrs:
        neg = [t for t in held if t.kind in ("noise_only", "oov") and t.snr_db == snr]
        fa_by_snr.append((snr, proportion(sum(accepted(t) for t in neg), len(neg), lvl)))
    p95 = percentile(lat, 95)
    rtf95 = percentile(rtf, 95)

    prompts = []
    for prompt_id, codes in vocab.prompts.items():
        rows = [t for t in ref_kw if t.prompt_id == prompt_id]
        acc = proportion(sum(ok(t) for t in rows), len(rows), lvl)
        psub = subgroup_table(rows)
        pgap: dict[str, float | None] = {}
        reasons: list[str] = []
        for f, groups in psub.items():
            gap, sampled = _gap(groups, policy.min_speakers_per_subgroup)
            pgap[f] = gap
            if not sampled:
                reasons.append(f"{f}: a subgroup has fewer than {policy.min_speakers_per_subgroup} speakers")
            elif gap is not None and gap > policy.max_gap_pp:
                reasons.append(f"{f} gap {gap:.1f} pp > {policy.max_gap_pp} pp")
        judged = acc["p"] if policy.judge_on == "point" else acc["ci_low"]
        if judged is None or judged < policy.min_accuracy:
            reasons.append(f"accuracy at {ref:g} dB {judged} < {policy.min_accuracy}")
        if heldout_speakers < policy.min_heldout_speakers:
            reasons.append(f"{heldout_speakers} held-out speakers < {policy.min_heldout_speakers}")
        for c in codes:
            n_c = sum(1 for t in rows if t.truth == c)
            if n_c < policy.min_trials_per_code:
                reasons.append(f"code {c}: {n_c} trials < {policy.min_trials_per_code}")
        if not fa_by_snr:
            reasons.append("no keyword-free trials at the judged noise conditions")
        for snr, fa in fa_by_snr:
            if fa["p"] is None or fa["p"] > policy.max_false_accept_rate:
                reasons.append(f"false-accept rate at {snr:g} dB {fa['p']} > {policy.max_false_accept_rate}")
        if p95 > policy.max_p95_latency_ms:
            reasons.append(f"p95 latency {p95:.0f} ms > {policy.max_p95_latency_ms:g} ms")
        if rtf95 > policy.max_rtf:
            reasons.append(f"p95 RTF {rtf95:.2f} > {policy.max_rtf}")
        if theta_p is None:
            reasons.append(f"no threshold reaches propose precision {policy.propose_min_precision} on calibration")
        prompts.append(
            {
                "prompt_id": prompt_id,
                "vocabulary": list(codes),
                "accuracy": acc,
                "gap_pp": pgap,
                "speakers": len({t.speaker_id for t in rows}),
                "voice_enabled": not reasons,
                "reasons": reasons,
            }
        )

    lang = {
        "language": language,
        "heldout_speakers": heldout_speakers,
        "accuracy": accuracy,
        "false_accepts": false_accepts,
        "subgroups": subgroups,
        "gap_pp": gap_pp,
        "latency_ms": {
            "p50": round(percentile(lat, 50), 3),
            "p95": round(p95, 3),
            "mean": round(sum(lat) / len(lat), 3) if lat else 0.0,
        },
        "rtf": {"mean": round(sum(rtf) / len(rtf), 5) if rtf else 0.0, "p95": round(rtf95, 5)},
        "cpu": {
            "cpu_ms_per_audio_s": round(sum(t.cpu_ms for t in held) / audio_s, 3) if audio_s else 0.0,
            "peak_rss_mb": round(peak_rss_mb, 1),
        },
        "calibration": cal_rows,
        "prompts": prompts,
    }
    return lang, theta_p, theta_c, cal_rows


def _winners(engines_out: list[dict[str, Any]], languages: list[str]) -> dict[str, Any]:
    winners: dict[str, Any] = {}
    for lang in languages:
        best: tuple[Any, ...] | None = None
        for e in engines_out:
            for lr in e["languages"]:
                if lr["language"] != lang:
                    continue
                enabled = [p["prompt_id"] for p in lr["prompts"] if p["voice_enabled"]]
                ref_acc = min((p["accuracy"]["p"] or 0.0) for p in lr["prompts"]) if lr["prompts"] else 0.0
                key = (len(enabled), ref_acc, -lr["latency_ms"]["p95"], e["engine_id"], enabled)
                if best is None or key[:3] > best[:3]:
                    best = key
        if best is None or best[0] == 0:
            winners[lang] = {
                "engine_id": None,
                "voice_enabled_prompts": [],
                "reason": "no engine passed the VOX-06 policy for any prompt: this language runs touch only",
            }
        else:
            winners[lang] = {
                "engine_id": best[3],
                "voice_enabled_prompts": best[4],
                "reason": f"most voice-enabled prompts ({best[0]}), then worst-prompt accuracy, then p95 latency",
            }
    return winners


def run_bakeoff(
    dataset: Dataset,
    vocab: Vocabulary,
    specs: list[EngineSpec],
    policy: Policy,
    conditions: Conditions,
    out_dir: Path,
    *,
    languages: list[str] | None = None,
    progress: Callable[[str], None] | None = None,
) -> RunOutput:
    out_dir.mkdir(parents=True, exist_ok=True)
    langs = [
        lang for lang in dataset.languages() if (languages is None or lang in languages) and lang in vocab.languages
    ]
    noise, noise_source = load_noise(conditions)
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + dataset.manifest_sha256[:8]
    trials_path = out_dir / f"trials-{run_id}.jsonl"
    engines_out: list[dict[str, Any]] = []
    artifacts: list[EngineLanguageArtifacts] = []
    with trials_path.open("w", encoding="utf-8") as trial_log:
        for spec in specs:
            engine = create_engine(spec)
            entry: dict[str, Any] = {"engine_id": spec.id, "kind": spec.kind, "available": False, "languages": []}
            reasons = []
            for lang in langs:
                reason = engine.unavailable_reason(lang)
                if reason:
                    reasons.append(f"{lang}: {reason}")
                    continue
                meter = _Meter()
                trials = []
                for t in run_engine_language(engine, lang, dataset, vocab, conditions, noise, meter, progress):
                    trials.append(t)
                    trial_log.write(json.dumps(asdict(t), ensure_ascii=False) + "\n")
                lang_out, theta_p, theta_c, cal = summarise(
                    trials, lang, dataset, vocab, policy, conditions, meter.peak
                )
                entry["languages"].append(lang_out)
                entry["available"] = True
                tokens = engine.keyword_tokens() if hasattr(engine, "keyword_tokens") else {}
                model_id = Path(str(spec.params.get("model_dir", spec.params.get("model", spec.id)))).name
                artifacts.append(
                    EngineLanguageArtifacts(spec.id, spec.kind, lang, model_id, theta_p, theta_c, cal, dict(tokens))
                )
            version = engine.version()
            if version:
                entry["version"] = version
            if reasons:
                entry["unavailable_reason"] = "; ".join(reasons)
            engine.close()
            engines_out.append(entry)

    results = {
        "schema_version": "1.0",
        "run_id": run_id,
        "created_at": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "dataset": {
            "dataset_id": dataset.dataset_id,
            "kind": dataset.kind,
            "manifest_sha256": dataset.manifest_sha256,
            "utterances": len(dataset.utterances),
        },
        "conditions": {"snr_db": list(conditions.snr_db), "noise_source": noise_source, "seed": conditions.seed},
        "policy": {
            "file_sha256": policy.sha256,
            "reference_snr_db": policy.reference_snr_db,
            "min_accuracy": policy.min_accuracy,
            "max_gap_pp": policy.max_gap_pp,
            "min_heldout_speakers": policy.min_heldout_speakers,
            "max_false_accept_rate": policy.max_false_accept_rate,
            "false_accept_judge_at": policy.false_accept_judge_at,
        },
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": psutil.cpu_count(logical=True) or 0,
            "python": sys.version.split()[0],
        },
        "engines": engines_out,
        "winners": _winners(engines_out, langs),
    }
    validate(results, "results.schema.json")
    (out_dir / f"results-{run_id}.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return RunOutput(results, artifacts, trials_path)
