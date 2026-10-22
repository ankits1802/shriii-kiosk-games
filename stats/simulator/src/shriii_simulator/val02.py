"""VAL-02: minimum trials per indicator (Spearman-Brown + simulation) and the implied session time.

Method (configured in ``data/val02.yaml``; every threshold lives there):

1. Simulate two parallel occasions with identical latents (stability 1) per pathway; Pathway B once per
   planned-missingness slot form that carries individual indicators. Optionally at larger design scales
   (``design.scale``: every scored block of the scalable modules lengthened).
2. Score every indicator with the real engine at several block fractions (each scored block truncated to its
   first ``fraction`` of trials, which is what a shorter block in the game config would have delivered) and
   with ``min_valid_trials`` lowered to 1 so the curve is visible below the production minimums.
3. Per indicator and condition: parallel-form reliability (Spearman between occasions), r with the planted
   latent, the strongest other latent, the partition model reliability and the median number of valid units.
4. Fit the Spearman-Brown curve ``rel(n) = n rho / (1 + (n - 1) rho)`` (least squares on Fisher-z) to the
   (median valid units, reliability) points to get the single-unit reliability ``rho``; the minimum units
   for a target ``R`` is ``R (1 - rho) / (rho (1 - R))``.
5. Convert units to session time with the L2 seconds per trial of the indicator's selected blocks
   (``content/games/*.json``, read-only): seconds per valid unit = scheduled seconds / valid units delivered
   by the current schedule.

The output is a JSON document plus Markdown tables (``--out``); docs/science/VAL-02-trial-requirements.md
explains how to read them. Recovery on simulated data shows the pipeline is internally consistent; it is
not evidence that the games measure the traits.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np
from scipy import optimize
from shriii_scoring.resources import load_package_yaml

from shriii_simulator.discounting_design import DesignResult, EffortDesign, run_design_study
from shriii_simulator.params import load_sim_params
from shriii_simulator.studies import IndicatorStat, StudyEngine, parallel_stats, simulate_parallel

__all__ = [
    "CurvePoint",
    "IndicatorRequirement",
    "Val02Config",
    "fit_spearman_brown",
    "load_val02_config",
    "required_units",
    "run_val02",
    "spearman_brown",
]


# ----------------------------------------------------------------------------- configuration


@dataclass(frozen=True, slots=True)
class Val02Config:
    """Parsed ``val02.yaml`` for one profile."""

    targets: tuple[float, ...]
    level: str
    min_paired_persons: int
    max_extrapolation_factor: float
    min_single_unit_reliability: float
    infeasible_factor: float
    n_persons: int
    seeds: tuple[int, ...]
    fractions: tuple[float, ...]
    scales: tuple[float, ...]
    pathways: tuple[str, ...]
    b_slot_forms: tuple[str, ...]
    effort_design_persons: int
    estimator_variants: Mapping[str, Mapping[str, Mapping[str, Any]]]
    effort_designs: tuple[EffortDesign, ...]
    profile: str
    sha256: str


def load_val02_config(profile: str = "local", overrides: Mapping[str, Any] | None = None) -> Val02Config:
    doc = load_package_yaml("shriii_simulator.data", "val02.yaml")
    data = cast(Mapping[str, Any], doc.data)
    if data.get("schema") != "shriii-val02-study":
        raise ValueError("val02.yaml is not a shriii-val02-study document")
    prof = dict(data["profiles"][profile])
    prof.update(overrides or {})
    return Val02Config(
        targets=tuple(float(t) for t in data["targets"]),
        level=str(data["level"]),
        min_paired_persons=int(data["min_paired_persons"]),
        max_extrapolation_factor=float(data["max_extrapolation_factor"]),
        min_single_unit_reliability=float(data["min_single_unit_reliability"]),
        infeasible_factor=float(data["infeasible_factor"]),
        n_persons=int(prof["n_persons"]),
        seeds=tuple(int(s) for s in prof["seeds"]),
        fractions=tuple(float(f) for f in prof["fractions"]),
        scales=tuple(float(s) for s in prof["scales"]),
        pathways=tuple(str(p) for p in prof["pathways"]),
        b_slot_forms=tuple(str(s) for s in prof["b_slot_forms"]),
        effort_design_persons=int(prof["effort_design_persons"]),
        estimator_variants=data.get("estimator_variants") or {},
        effort_designs=tuple(EffortDesign.from_mapping(k, v) for k, v in (data.get("effort_designs") or {}).items()),
        profile=profile,
        sha256=doc.sha256,
    )


# ----------------------------------------------------------------------------- Spearman-Brown


def spearman_brown(n: float, rho: float) -> float:
    """Reliability of the mean of ``n`` parallel units with single-unit reliability ``rho``."""
    return n * rho / (1.0 + (n - 1.0) * rho)


def required_units(target: float, rho: float) -> float:
    """Units needed for reliability ``target`` given single-unit reliability ``rho`` (inverse Spearman-Brown)."""
    if rho <= 0.0:
        return math.inf
    if rho >= target:
        return 1.0
    return target * (1.0 - rho) / (rho * (1.0 - target))


def fit_spearman_brown(points: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Single-unit reliability fitted to (units, reliability) points; returns (rho, RMSE on the r scale).

    Least squares on Fisher-z (reliabilities clipped to [-.95, .95]); rho is searched on [1e-6, .999].
    """
    pts = [(n, r) for n, r in points if n > 0 and math.isfinite(r)]
    if not pts:
        return math.nan, math.nan
    ns = np.array([p[0] for p in pts], dtype=float)
    rs = np.clip(np.array([p[1] for p in pts], dtype=float), -0.95, 0.95)

    def loss(rho: float) -> float:
        pred = np.clip(ns * rho / (1.0 + (ns - 1.0) * rho), -0.95, 0.95)
        return float(np.sum((np.arctanh(pred) - np.arctanh(rs)) ** 2))

    res = optimize.minimize_scalar(loss, bounds=(1e-6, 0.999), method="bounded", options={"xatol": 1e-7})
    rho = float(res.x)
    pred = ns * rho / (1.0 + (ns - 1.0) * rho)
    rmse = float(np.sqrt(np.mean((pred - rs) ** 2)))
    return rho, rmse


# ----------------------------------------------------------------------------- session time model


def _block_seconds(cfg: Mapping[str, Any], block_id: str, level: str) -> tuple[int, float] | None:
    for b in cfg.get("blocks", []):
        if str(b["block_id"]) == block_id:
            trials = int(b.get("trials") or 0)
            per = b.get("budget_trial_ms")
            if per is not None:
                return trials, float(per) / 1000.0
            spt = (cfg.get("levels", {}).get(level, {}) or {}).get("seconds_per_trial", {}) or {}
            median = spt.get("median")
            return (trials, float(median)) if median is not None else None
    return None


def scheduled_seconds(engine: StudyEngine, pathway: str, indicator: str, level: str) -> tuple[int, float]:
    """Trials and L2 seconds of the blocks the engine selects for ``indicator`` (content configs)."""
    blocks = engine._blocks.get((pathway, indicator), {})
    trials = 0
    seconds = 0.0
    for module, chosen in blocks.items():
        cfg = engine.game_configs.get(module)
        if cfg is None:
            continue
        for b in sorted(chosen):
            got = _block_seconds(cfg, b, level)
            if got is not None:
                trials += got[0]
                seconds += got[0] * got[1]
    return trials, seconds


# ----------------------------------------------------------------------------- study


@dataclass(frozen=True, slots=True)
class CurvePoint:
    """One indicator under one condition (pooled over seeds and slot-form studies)."""

    scale: float
    fraction: float
    median_n_valid: float
    parallel_reliability: float
    r_latent: float
    model_reliability: float | None
    n_persons: int
    replicates: int
    best_other_construct: str | None
    r_best_other: float


@dataclass(slots=True)
class IndicatorRequirement:
    """VAL-02 result for one indicator."""

    pathway: str
    indicator_id: str
    construct: str
    unit: str
    min_valid_current: int
    basis: str
    kind: str
    gate_eligible: bool
    points: list[CurvePoint]
    rho: float
    sb_rmse: float
    units_delivered: float
    scheduled_trials: int
    scheduled_seconds: float
    seconds_per_unit: float
    reliability_at_current_schedule: float
    reliability_at_current_minimum: float
    required: dict[str, float | None] = field(default_factory=dict)
    required_seconds: dict[str, float | None] = field(default_factory=dict)
    extra_seconds: dict[str, float | None] = field(default_factory=dict)
    verdict: dict[str, str] = field(default_factory=dict)
    note: str = ""


def _fisher_mean(values: Sequence[float]) -> float:
    vals = [v for v in values if math.isfinite(v)]
    if not vals:
        return math.nan
    return float(math.tanh(float(np.mean(np.arctanh(np.clip(vals, -0.99, 0.99))))))


def _pool(stats: Sequence[IndicatorStat], scale: float, fraction: float) -> CurvePoint:
    models = [s.model_reliability for s in stats if s.model_reliability is not None]
    best = defaultdict(list)
    for s in stats:
        if s.best_other_construct is not None:
            best[s.best_other_construct].append(s.r_best_other)
    other = max(best.items(), key=lambda kv: abs(_fisher_mean(kv[1])))[0] if best else None
    return CurvePoint(
        scale=scale,
        fraction=fraction,
        median_n_valid=float(np.median([s.median_n_valid for s in stats])),
        parallel_reliability=_fisher_mean([s.parallel_reliability for s in stats]),
        r_latent=_fisher_mean([s.r_latent for s in stats]),
        model_reliability=float(np.mean(models)) if models else None,
        n_persons=int(sum(s.n_persons for s in stats)),
        replicates=len(stats),
        best_other_construct=other,
        r_best_other=_fisher_mean(best[other]) if other else math.nan,
    )


def _study_forms(pathway: str, cfg: Val02Config) -> list[str | None]:
    return list(cfg.b_slot_forms) if pathway == "B" else [None]


def _log(msg: str) -> None:
    print(f"[val02 {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def collect_curves(
    cfg: Val02Config, pathway: Literal["A", "B"]
) -> tuple[dict[tuple[float, float], dict[str, list[IndicatorStat]]], dict[str, dict[str, list[IndicatorStat]]]]:
    """Curve statistics per (scale, fraction) and estimator-variant statistics (scale 1, fraction 1)."""
    curves: dict[tuple[float, float], dict[str, list[IndicatorStat]]] = defaultdict(lambda: defaultdict(list))
    variants: dict[str, dict[str, list[IndicatorStat]]] = defaultdict(lambda: defaultdict(list))
    base = load_sim_params()
    for scale in cfg.scales:
        prm = base.with_overrides({"design.scale": scale})
        for seed in cfg.seeds:
            for form in _study_forms(pathway, cfg):
                _log(f"simulate {pathway} scale={scale} seed={seed} form={form} n={cfg.n_persons}")
                study = simulate_parallel(cfg.n_persons, pathway, seed=seed, params=prm, slot_form=form)
                for fraction in cfg.fractions:
                    engine = StudyEngine(pathways=(pathway,), fraction=fraction)
                    stats, _ = parallel_stats(study, engine, min_n=cfg.min_paired_persons)
                    for ind, st in stats.items():
                        curves[(scale, fraction)][ind].append(st)
                    _log(f"  scored fraction={fraction}: {len(stats)} indicators")
                if scale == 1.0:
                    for ind, alts in cfg.estimator_variants.items():
                        for name, overrides in alts.items():
                            eng = StudyEngine(pathways=(pathway,), indicators=[ind], scoring_overrides=overrides)
                            if ind not in eng.dictionaries[pathway].indicators:
                                continue
                            got, _ = parallel_stats(study, eng, min_n=cfg.min_paired_persons)
                            if ind in got:
                                variants[f"{pathway}:{ind}"][name].append(got[ind])
    return curves, variants


def summarise_requirements(
    cfg: Val02Config,
    pathway: str,
    curves: Mapping[tuple[float, float], Mapping[str, Sequence[IndicatorStat]]],
) -> list[IndicatorRequirement]:
    engine = StudyEngine(pathways=(pathway,))  # type: ignore[arg-type]
    prod = StudyEngine(pathways=(pathway,), min_valid_override=None)  # type: ignore[arg-type]
    dictionary = prod.dictionaries[pathway]
    out: list[IndicatorRequirement] = []
    ids = sorted({ind for per in curves.values() for ind in per})
    for ind in ids:
        spec = dictionary.indicators[ind]
        points = [_pool(per[ind], scale, fraction) for (scale, fraction), per in sorted(curves.items()) if per.get(ind)]
        base = [p for p in points if p.scale == 1.0 and p.fraction == 1.0]
        delivered = base[0].median_n_valid if base else math.nan
        trials, seconds = scheduled_seconds(engine, pathway, ind, cfg.level)
        rho, rmse = fit_spearman_brown([(p.median_n_valid, p.parallel_reliability) for p in points])
        sec_per_unit = seconds / delivered if delivered and delivered > 0 and seconds > 0 else math.nan
        req = IndicatorRequirement(
            pathway=pathway,
            indicator_id=ind,
            construct=spec.construct,
            unit=spec.min_valid_unit,
            min_valid_current=dictionary.indicators[ind].min_valid_count,
            basis=spec.min_valid_basis,
            kind=spec.kind,
            gate_eligible=spec.gate_eligible,
            points=points,
            rho=rho,
            sb_rmse=rmse,
            units_delivered=delivered,
            scheduled_trials=trials,
            scheduled_seconds=seconds,
            seconds_per_unit=sec_per_unit,
            reliability_at_current_schedule=base[0].parallel_reliability if base else math.nan,
            reliability_at_current_minimum=spearman_brown(dictionary.indicators[ind].min_valid_count, rho)
            if math.isfinite(rho)
            else math.nan,
        )
        max_units = max((p.median_n_valid for p in points), default=math.nan)
        for target in cfg.targets:
            key = f"{target:.1f}"
            if not math.isfinite(rho) or rho <= cfg.min_single_unit_reliability:
                req.required[key] = None
                req.required_seconds[key] = None
                req.extra_seconds[key] = None
                req.verdict[key] = "no_reliable_signal"
                continue
            n_req = math.ceil(required_units(target, rho))
            beyond = math.isfinite(max_units) and n_req > cfg.max_extrapolation_factor * max_units
            req.required[key] = None if beyond else float(n_req)
            if beyond:
                req.required_seconds[key] = None
                req.extra_seconds[key] = None
                req.verdict[key] = "beyond_projection_range"
                continue
            secs = n_req * sec_per_unit if math.isfinite(sec_per_unit) else math.nan
            req.required_seconds[key] = secs if math.isfinite(secs) else None
            req.extra_seconds[key] = (secs - seconds) if math.isfinite(secs) else None
            if math.isfinite(delivered) and n_req <= delivered:
                req.verdict[key] = "met_by_current_schedule"
            elif math.isfinite(delivered) and n_req > cfg.infeasible_factor * delivered:
                req.verdict[key] = "infeasible_in_session"
            else:
                req.verdict[key] = "needs_more_trials"
        out.append(req)
    return out


def run_val02(cfg: Val02Config) -> dict[str, Any]:
    """Run the whole study and return a JSON-serialisable document."""
    started = time.time()
    doc: dict[str, Any] = {
        "schema": "shriii-val02-results",
        "profile": cfg.profile,
        "config_sha256": cfg.sha256,
        "simulator_params_sha256": load_sim_params().sha256,
        "n_persons": cfg.n_persons,
        "seeds": list(cfg.seeds),
        "fractions": list(cfg.fractions),
        "scales": list(cfg.scales),
        "targets": list(cfg.targets),
        "requirements": [],
        "estimator_variants": {},
        "effort_designs": [],
    }
    for pathway in cfg.pathways:
        curves, variants = collect_curves(cfg, cast(Literal["A", "B"], pathway))
        doc["requirements"].extend(asdict(r) for r in summarise_requirements(cfg, pathway, curves))
        for key, alts in variants.items():
            doc["estimator_variants"][key] = {
                name: asdict(_pool(stats, 1.0, 1.0)) for name, stats in alts.items() if stats
            }
    if cfg.effort_designs:
        _log(f"effort designs n={cfg.effort_design_persons}")
        results: list[DesignResult] = run_design_study(
            cfg.effort_designs, n=cfg.effort_design_persons, seed=cfg.seeds[0]
        )
        doc["effort_designs"] = [asdict(r) for r in results]
    doc["elapsed_seconds"] = round(time.time() - started, 1)
    return doc


# ----------------------------------------------------------------------------- reporting


def _f(v: Any, digits: int = 2) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        if math.isnan(v):
            return "-"
        if math.isinf(v):
            return "inf"
        return f"{v:.{digits}f}"
    return str(v)


def render_markdown(doc: Mapping[str, Any]) -> str:
    """Markdown tables for the results document."""
    targets = [f"{t:.1f}" for t in doc["targets"]]
    lines = [
        f"# VAL-02 simulation results ({doc['profile']} profile)",
        "",
        f"n = {doc['n_persons']} persons x 2 parallel occasions per study; seeds {doc['seeds']}; block fractions "
        f"{doc['fractions']}; design scales {doc['scales']}; elapsed {doc.get('elapsed_seconds')} s.",
        "",
    ]
    for pathway in sorted({r["pathway"] for r in doc["requirements"]}, reverse=True):
        lines += [
            f"## Pathway {pathway}: reliability and minimum valid units",
            "",
            "| Indicator | Unit | Min (dict) | Delivered | Rel (schedule) | r latent | Strongest other latent | "
            "rho1 | SB RMSE | "
            + " | ".join(f"Units for {t}" for t in targets)
            + " | "
            + " | ".join(f"Extra s for {t}" for t in targets)
            + " | Verdict ("
            + targets[0]
            + ") |",
            "|" + "---|" * (10 + 2 * len(targets)),
        ]
        for r in (x for x in doc["requirements"] if x["pathway"] == pathway):
            base = [p for p in r["points"] if p["scale"] == 1.0 and p["fraction"] == 1.0]
            b = base[0] if base else {}
            other = f"{b.get('best_other_construct')} ({_f(b.get('r_best_other'))})" if b else "-"
            lines.append(
                "| "
                + " | ".join(
                    [
                        f"`{r['indicator_id']}`",
                        r["unit"],
                        str(r["min_valid_current"]),
                        _f(r["units_delivered"], 0),
                        _f(r["reliability_at_current_schedule"]),
                        _f(b.get("r_latent")),
                        other,
                        _f(r["rho"], 3),
                        _f(r["sb_rmse"]),
                        *[_f(r["required"].get(t), 0) for t in targets],
                        *[_f(r["extra_seconds"].get(t), 0) for t in targets],
                        r["verdict"].get(targets[0], "-"),
                    ]
                )
                + " |"
            )
        lines.append("")
    if doc.get("estimator_variants"):
        lines += [
            "## Estimator comparisons (scale 1, full schedule)",
            "",
            "| Indicator | Variant | r latent | Parallel rel | Model rel | Strongest other latent |",
            "|---|---|---|---|---|---|",
        ]
        for key, alts in sorted(doc["estimator_variants"].items()):
            for name, p in alts.items():
                lines.append(
                    f"| `{key}` | {name} | {_f(p['r_latent'])} | {_f(p['parallel_reliability'])} | "
                    f"{_f(p['model_reliability'])} | {p['best_other_construct']} ({_f(p['r_best_other'])}) |"
                )
        lines.append("")
    if doc.get("effort_designs"):
        lines += [
            "## Effort-discounting designs",
            "",
            "| Design | Choices | r(est, true log k) | Parallel rel | Model rel | All hard | All easy |",
            "|---|---|---|---|---|---|---|",
        ]
        for d in doc["effort_designs"]:
            lines.append(
                f"| {d['design']} | {d['n_choices']} | {_f(d['r_true'])} | {_f(d['parallel_reliability'])} | "
                f"{_f(d['model_reliability'])} | {_f(d['share_all_hard'])} | {_f(d['share_all_easy'])} |"
            )
        lines.append("")
    return "\n".join(lines)


def _json_default(o: Any) -> Any:
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    if isinstance(o, np.generic):
        return o.item()
    raise TypeError(type(o))


def _clean(o: Any) -> Any:
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list | tuple):
        return [_clean(v) for v in o]
    return o


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--profile", default="local", choices=["local", "full"])
    ap.add_argument("--out", type=Path, default=Path(".cache/val02"))
    ap.add_argument("--pathways", nargs="*", default=None, help="override the profile's pathways")
    ap.add_argument("--n", type=int, default=None, help="override persons per study")
    ap.add_argument("--no-effort-designs", action="store_true")
    ap.add_argument("--effort-designs-only", action="store_true", help="skip the pathway studies")
    args = ap.parse_args(argv)
    overrides: dict[str, Any] = {}
    if args.pathways:
        overrides["pathways"] = args.pathways
    if args.n:
        overrides["n_persons"] = args.n
        overrides["effort_design_persons"] = args.n
    cfg = load_val02_config(args.profile, overrides)
    if args.no_effort_designs:
        cfg = replace(cfg, effort_designs=())
    if args.effort_designs_only:
        cfg = replace(cfg, pathways=())
    doc = _clean(run_val02(cfg))
    args.out.mkdir(parents=True, exist_ok=True)
    tag = "-".join(cfg.pathways) or "effort-designs"
    (args.out / f"val02-{cfg.profile}-{tag}.json").write_text(
        json.dumps(doc, indent=1, default=_json_default), encoding="utf-8"
    )
    md = render_markdown(doc)
    (args.out / f"val02-{cfg.profile}-{tag}.md").write_text(md, encoding="utf-8")
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
