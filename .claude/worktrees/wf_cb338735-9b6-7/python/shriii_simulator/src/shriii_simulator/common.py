"""Response models shared by several modules: go/no-go, public goods, tone, probes, holds."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from shriii_simulator.builder import SessionWriter, TrialHandle
from shriii_simulator.params import SimParams
from shriii_simulator.population import Person

__all__ = [
    "Occasion",
    "contribution_round",
    "exgauss",
    "gng_trial",
    "hold",
    "jitter",
    "probe_block",
    "sigmoid",
    "tone_choice",
]

SERVE_XY = (0.5, 0.75)
OPTION_XY = {
    "pile_1": (0.2, 0.8),
    "pile_2": (0.4, 0.8),
    "pile_3": (0.6, 0.8),
    "pile_4": (0.8, 0.8),
    "stall_a": (0.2, 0.5),
    "stall_b": (0.4, 0.5),
    "stall_c": (0.6, 0.5),
    "stall_d": (0.8, 0.5),
    "safe": (0.3, 0.7),
    "risky": (0.7, 0.7),
    "firm": (0.25, 0.8),
    "neutral": (0.5, 0.8),
    "warm": (0.75, 0.8),
    "approve": (0.25, 0.8),
    "warn": (0.5, 0.8),
    "fine": (0.75, 0.8),
    "left": (0.3, 0.6),
    "right": (0.7, 0.6),
    "now": (0.3, 0.7),
    "wait": (0.7, 0.7),
    "easy": (0.3, 0.7),
    "hard": (0.7, 0.7),
    "accept": (0.3, 0.75),
    "decline": (0.7, 0.75),
    "return": (0.3, 0.75),
    "keep": (0.7, 0.75),
    "gamble": (0.3, 0.75),
    "inspect": (0.7, 0.75),
    "take": (0.3, 0.75),
    "skip": (0.85, 0.15),
    "contribute": (0.5, 0.85),
    "collect": (0.8, 0.85),
    "tap": (0.5, 0.5),
    "fallback": (0.5, 0.85),
}


@dataclass(frozen=True, slots=True)
class Occasion:
    """Occasion-level effects (retest practice shift, parallel form)."""

    index: int = 1
    practice_log_rt: float = 0.0
    form_id: str = "form_1"


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def exgauss(rng: np.random.Generator, mu: float, sigma: float, tau: float) -> float:
    return float(rng.normal(mu, sigma) + rng.exponential(max(tau, 1e-6)))


def jitter(rng: np.random.Generator, xy: tuple[float, float], sd: float = 0.02) -> tuple[float, float]:
    return (
        float(min(1.0, max(0.0, xy[0] + rng.normal(0, sd)))),
        float(min(1.0, max(0.0, xy[1] + rng.normal(0, sd)))),
    )


def option_xy(rng: np.random.Generator, person: Person, code: str) -> tuple[float, float]:
    if person.strategy == "same_position":
        return jitter(rng, (0.5, 0.5), 0.005)
    return jitter(rng, OPTION_XY.get(code, (0.5, 0.5)))


def gng_trial(
    w: SessionWriter,
    p: Person,
    rng: np.random.Generator,
    prm: SimParams,
    occ: Occasion,
    *,
    module_id: str,
    block: str,
    trial_type: str,
    phase: str,
    condition_id: str,
    window_ms: int,
    isi_ms: float,
    pressure: bool,
    episode: bool = False,
    feedback: str = "none",
    accuracy_drop: float = 0.0,
) -> bool:
    """One go/no-go trial. Returns correctness. ``accuracy_drop`` (logit) models post-feedback lapses."""
    g = "gng."
    cond = w.condition(phase, condition_id, timer=pressure, noise=pressure)
    h = w.start_trial(
        module_id,
        block,
        trial_type,
        cond,
        params={"feedback": feedback},
        response_window_ms=window_ms,
        expected_response="serve" if trial_type == "go" else "withhold",
        episode=episode,
    )
    z_rest = p.z("expressive_restraint")
    for _ in range(
        int(rng.poisson(math.exp(prm.f(g + "premature_log_rate") - prm.f(g + "premature_restraint") * z_rest)))
    ):
        w.tap(
            h,
            "premature",
            target_id=f"{module_id}.serve",
            xy=jitter(rng, SERVE_XY),
            at=h.onset_ms + float(rng.uniform(5, 140)),
        )
    mu = prm.f(g + "rt_mu_ms") - prm.f(g + "rt_speed_coef_ms") * p.speed
    tau = prm.f(g + "rt_tau_ms") * math.exp(-prm.f(g + "tau_consistency_coef") * p.z("response_consistency"))
    log_shift = occ.practice_log_rt
    if pressure:
        log_shift += (
            prm.f(g + "pressure_log_rt")
            - prm.f(g + "pressure_log_rt_composure") * p.z("composure")
            - prm.f(g + "pressure_log_rt_stability") * p.z("stability")
        )
    rt = exgauss(rng, mu, prm.f(g + "rt_sigma_ms"), tau) * math.exp(log_shift)
    if p.strategy == "speed_tapper":
        rt = float(rng.uniform(60, 140))
    responded: bool
    if trial_type == "go":
        lapse = sigmoid(-4.0 + accuracy_drop)
        responded = rt < window_ms and rng.random() >= lapse
    else:
        logit = (
            prm.f(g + "commission_intercept")
            - prm.f(g + "commission_self_control") * p.z("self_control")
            + prm.f(g + "commission_speed") * p.speed
            + accuracy_drop
            + float((prm.get("nuisance.trial_dif") or {}).get(f"{module_id}.{trial_type}", {}).get(p.language, 0.0))
        )
        if pressure:
            logit += (
                prm.f(g + "commission_pressure")
                - prm.f(g + "commission_pressure_composure") * p.z("composure")
                - prm.f(g + "commission_pressure_stability") * p.z("stability")
            )
        responded = rng.random() < sigmoid(logit) or p.strategy == "speed_tapper"
        rt = min(rt * 0.9, window_ms - 5.0)
    correct = responded if trial_type == "go" else not responded
    if responded:
        w.respond(
            h,
            "serve",
            latency_ms=max(rt, 1.0),
            correctness=correct,
            xy=jitter(rng, SERVE_XY),
            tap_target=f"{module_id}.serve",
        )
        for _ in range(int(rng.poisson(math.exp(prm.f(g + "extra_log_rate") - prm.f(g + "extra_restraint") * z_rest)))):
            w.advance(float(rng.uniform(40, 120)))
            w.tap(h, "extra", target_id=f"{module_id}.serve", xy=jitter(rng, SERVE_XY))
    else:
        w.t = max(w.t, h.anchor_ms + window_ms)
        w.respond(h, None, latency_ms=None, correctness=correct)
    w.t = max(w.t, h.onset_ms + window_ms)
    outcome = (
        ("correct" if correct else "omission") if trial_type == "go" else ("commission" if responded else "correct")
    )
    w.end_trial(h, outcome, correct, int(responded))
    w.advance(isi_ms + float(rng.uniform(-50, 50)))
    return correct


def contribution_round(
    w: SessionWriter,
    p: Person,
    rng: np.random.Generator,
    prm: SimParams,
    *,
    module_id: str,
    block: str,
    trial_type: str,
    round_index: int,
    endowment: int,
    partner_type: str,
    is_error: bool,
    previous_partner: str | None,
    previous_error: bool,
    episode: bool = False,
) -> None:
    """One public-goods round with a scripted partner (conditional cooperation)."""
    g = "public_goods."
    cond = w.condition("main", "scripted_partners", partner_type=partner_type)
    h = w.start_trial(
        module_id,
        block,
        trial_type,
        cond,
        params={},
        response_window_ms=8000,
        episode=episode,
        audio_prompt=f"{module_id}.round_prompt",
        audio_ms=1500,
    )
    share = sigmoid(prm.f(g + "base_logit") + prm.f(g + "teamwork_coef") * p.z("teamwork"))
    if previous_partner == "free_rider" and not previous_error:
        share *= 1.0 - prm.f(g + "defection_drop") * sigmoid(-prm.f(g + "defection_teamwork") * p.z("teamwork"))
    if previous_error:
        share -= prm.f(g + "error_drop")
    share = float(np.clip(share + rng.normal(0, prm.f(g + "noise_sd")), 0.0, 1.0))
    if p.strategy == "always_share":
        share = 1.0
    tokens = round(share * endowment)
    unprompted = bool(
        rng.random() < sigmoid(prm.f(g + "unprompted_logit") + prm.f(g + "unprompted_initiative") * p.z("initiative"))
    )
    latency = float(
        rng.lognormal(
            math.log(prm.f(g + "decision_ms")) - prm.f(g + "decision_decisiveness") * p.z("decisiveness"), 0.35
        )
    )
    n_rev = int(
        rng.poisson(prm.f(g + "revision_rate") * math.exp(-prm.f(g + "revision_decisiveness") * p.z("decisiveness")))
    )
    revisions = [
        (str(int(rng.integers(0, endowment + 1))), h.anchor_ms + latency * (i + 1) / (n_rev + 2)) for i in range(n_rev)
    ]
    revisions_codes = [(f"tokens_{v}", t) for v, t in revisions]
    w.respond(
        h,
        "contribute",
        latency_ms=latency,
        correctness=None,
        xy=jitter(rng, (0.5, 0.85)),
        revisions=revisions_codes,
        anchor="audio_end",
        tap_target=f"{module_id}.confirm",
    )
    partner_tokens = {"cooperative": endowment, "conditional_cooperator": tokens, "free_rider": 0}.get(
        partner_type, int(endowment * 0.6)
    )
    if is_error:
        partner_tokens = 0
    w.trial_event(
        h,
        "contribution",
        {
            "round": round_index,
            "endowment_tokens": endowment,
            "contributed_tokens": tokens,
            "partner_contributed_tokens": partner_tokens,
            "pot_return_tokens": int((tokens + partner_tokens) * 1.5 / 2),
            "unprompted": unprompted,
        },
    )
    w.advance(800)
    w.trial_event(
        h,
        "partner_action",
        {
            "partner_type": partner_type,
            "policy_id": f"{module_id}.policy.{partner_type}",
            "round": round_index,
            "action": "contribute" if partner_tokens > 0 else "keep",
            "tokens": partner_tokens,
            "is_error": is_error,
        },
    )
    w.advance(1200)
    w.end_trial(h, "not_applicable", None, 1)
    w.advance(500)


def tone_choice(
    w: SessionWriter,
    p: Person,
    rng: np.random.Generator,
    prm: SimParams,
    *,
    module_id: str,
    block: str,
    phase: str,
    condition_id: str,
    level: int | None,
    run_position: int | None,
    episode: bool,
    shift_active: bool = False,
) -> None:
    """Ordered-logit tone choice (firm / neutral / warm) with regulation, mirroring and drift."""
    t = "tone."
    er = p.z("emotional_regulation")
    eta = prm.f(t + "location") + prm.f(t + "regulation") * er
    if level is not None:
        mirroring = prm.f(t + "mirroring") - prm.f(t + "mirroring_regulation") * er
        eta -= mirroring * (level - 2)
    if run_position is not None:
        drift = prm.f(t + "drift") + prm.f(t + "drift_regulation") * er
        eta += drift * run_position / 10.0
    latent = eta + float(rng.logistic(0, 0.5))
    code = "firm" if latent < 0.5 else "neutral" if latent < 1.5 else "warm"
    cond = w.condition(phase, condition_id, shift_active=shift_active, customer_tone_level=level)
    h = w.start_trial(
        module_id,
        block,
        "tone_choice",
        cond,
        params={},
        response_window_ms=5500,
        episode=episode,
        audio_prompt=f"{module_id}.customer_line",
        audio_ms=1600,
    )
    lat = float(rng.lognormal(math.log(1800), 0.35))
    w.respond(
        h,
        code,
        latency_ms=lat,
        correctness=None,
        xy=option_xy(rng, p, code),
        anchor="audio_end",
        tap_target=f"{module_id}.tone_{code}",
    )
    w.end_trial(h, "not_applicable", None, 1)
    w.advance(600)


def probe_block(
    w: SessionWriter,
    p: Person,
    rng: np.random.Generator,
    prm: SimParams,
    style: np.ndarray,
    *,
    module_id: str,
    groups: Sequence[tuple[str, int]],
    episode: bool,
) -> None:
    """Probe segments: per-segment style = sqrt(w) * stable style + sqrt(1 - w) * noise (persistence)."""
    pr = "probes."
    weight = sigmoid(
        prm.f(pr + "style_weight_logit") + prm.f(pr + "style_weight_persistence") * p.z("persistence_of_style")
    )
    kappa = math.exp(prm.f(pr + "consistency_kappa") * p.z("response_consistency"))
    phi = prm.f(pr + "ar1_max") * sigmoid(
        prm.f(pr + "ar1_logit") + prm.f(pr + "ar1_persistence") * p.z("persistence_of_style")
    )
    position = 0
    for group_id, n in groups:
        seg = math.sqrt(weight) * style + math.sqrt(1.0 - weight) * rng.normal(size=style.size)
        ar = 0.0
        for _ in range(n):
            gid = f"probe_situation_{position}"
            cond = w.condition("main", "probe")
            h = w.start_trial(
                module_id,
                "probe",
                "probe",
                cond,
                params={"repeat_group_id": gid},
                response_window_ms=6000,
                episode=episode,
                probe_group=group_id,
            )
            situation = (-0.6, 0.0, 0.6, 0.2)[position % 4]
            sd = 0.12 * math.exp(0.35 * seg[1])
            ar = phi * ar + math.sqrt(1.0 - phi * phi) * float(rng.normal(0.0, sd))
            lat = float(math.exp(math.log(prm.f(pr + "rt_ms")) + 0.25 * seg[0] + ar))
            risky = rng.random() < sigmoid(kappa * (1.2 * seg[3] + situation))
            code = "risky" if risky else "safe"
            n_rev = int(rng.poisson(0.4 * math.exp(0.6 * seg[2])))
            revs = [("safe" if i % 2 else "risky", h.anchor_ms + lat * (i + 1) / (n_rev + 2)) for i in range(n_rev)]
            w.respond(
                h,
                code,
                latency_ms=lat,
                correctness=None,
                xy=option_xy(rng, p, code),
                revisions=revs,
                tap_target=f"{module_id}.probe_{code}",
            )
            w.end_trial(h, "not_applicable", None, 1)
            w.advance(400)
            position += 1


def hold(
    w: SessionWriter,
    h: TrialHandle,
    rng: np.random.Generator,
    p: Person,
    prm: SimParams,
    *,
    target: str,
    required_ms: float,
) -> bool:
    """A hold gesture whose completion depends on executive persistence."""
    d = "discounting."
    ok = rng.random() < sigmoid(
        prm.f(d + "hold_completion_logit") + prm.f(d + "hold_completion_persistence") * p.z("persistence")
    )
    held = required_ms + float(rng.uniform(0, 200)) if ok else float(rng.uniform(0.2, 0.9)) * required_ms
    w.advance(held)
    w.trial_event(
        h,
        "input.hold",
        {"target_id": target, "hold_ms": round(held, 3), "required_hold_ms": required_ms, "completed": ok},
    )
    return ok
