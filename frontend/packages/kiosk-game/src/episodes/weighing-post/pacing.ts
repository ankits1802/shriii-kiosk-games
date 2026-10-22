/**
 * Budget pacing (EPI-04: "optional beats are trimmed while every minimum is protected"). Before an
 * OPTIONAL trial (its block already has `min_trials` done), the episode projects the time still needed
 * for every remaining mandatory trial plus the set pieces and the outro. If doing the optional trial
 * would push the projection past the soft cap, the optional trial is skipped. Mandatory trials are never
 * skipped here (the soft-cap wrap-up and hard cap stay with the module host).
 *
 * Trial costs start from presentation priors and are replaced by the running mean of the trials of
 * the same kind actually played, so slow and fast players are both paced on their own evidence.
 */

import { CHOREO } from './scene/types.ts';
import type { EpisodeTrial } from './schedule.ts';

type CostKind = 'weigh' | 'dilemma' | 'gamble' | 'luck' | 'probe';

function costKind(t: EpisodeTrial): CostKind {
  switch (t.kind) {
    case 'weigh':
      return 'weigh';
    case 'gamble':
      return 'gamble';
    case 'luck':
      return 'luck';
    case 'probe':
      return 'probe';
    default:
      return 'dilemma';
  }
}

/** Optional/mandatory status of every trial: within-block position < min_trials is mandatory. */
export function mandatoryFlags(trials: readonly EpisodeTrial[]): boolean[] {
  const seen = new Map<string, number>();
  return trials.map((t) => {
    const k = seen.get(t.block.block_id) ?? 0;
    seen.set(t.block.block_id, k + 1);
    return k < t.block.min_trials;
  });
}

export class BudgetPacer {
  private readonly sums = new Map<CostKind, { total: number; n: number }>();
  private readonly mandatory: boolean[];
  private readonly priors: Readonly<Record<CostKind, number>>;

  constructor(
    private readonly trials: readonly EpisodeTrial[],
    timing: { readonly settleMs: number; readonly decisionMs: number; readonly dilemmaMs: number },
    private readonly softCapMs: number,
    private readonly outroMs: number,
  ) {
    this.mandatory = mandatoryFlags(trials);
    // Priors: presentation time plus about a third of the response window.
    this.priors = {
      weigh:
        CHOREO.weighPrepareMs + timing.settleMs + timing.decisionMs * 0.33 + CHOREO.weighExitMs,
      dilemma: CHOREO.dilemmaPrepareMs + timing.dilemmaMs * 0.33 + CHOREO.dilemmaExitMs,
      gamble: CHOREO.gamblePrepareMs + timing.dilemmaMs * 0.3 + CHOREO.gambleOutcomeMs,
      luck: CHOREO.luckRollMs + 1500 + CHOREO.luckOutcomeMs,
      probe: CHOREO.probePrepareMs + 900 + CHOREO.probeOutcomeMs,
    };
  }

  isMandatory(index: number): boolean {
    return this.mandatory[index] ?? true;
  }

  /** Record the duration of a played trial (ms, start to end of its exit). */
  record(trial: EpisodeTrial, ms: number): void {
    const k = costKind(trial);
    const s = this.sums.get(k) ?? { total: 0, n: 0 };
    s.total += Math.max(0, ms);
    s.n += 1;
    this.sums.set(k, s);
  }

  /** Expected cost of a trial (running mean of its kind, else the prior). */
  cost(trial: EpisodeTrial): number {
    const k = costKind(trial);
    const s = this.sums.get(k);
    return s && s.n > 0 ? s.total / s.n : this.priors[k];
  }

  /** Set pieces still ahead of `index` (announcement, screen, probe intro) in ms. */
  private setPiecesAfter(index: number): number {
    let ms = 0;
    const rest = this.trials.slice(index + 1);
    if (rest.some((t) => t.contextShift)) ms += CHOREO.newRuleMinMs + 3600 + CHOREO.newRuleSettleMs;
    if (rest.some((t) => t.kind === 'luck')) ms += CHOREO.luckBeginMs + CHOREO.luckEndMs;
    if (rest.some((t) => t.kind === 'probe')) ms += CHOREO.probeBeginMs + CHOREO.probeEndMs;
    return ms;
  }

  /** True when the optional trial at `index` should be skipped to protect the remaining minimums. */
  shouldSkip(index: number, elapsedMs: number): boolean {
    if (this.isMandatory(index)) return false;
    const trial = this.trials[index];
    if (!trial) return false;
    let need = this.cost(trial) + this.setPiecesAfter(index) + this.outroMs;
    for (let j = index + 1; j < this.trials.length; j++) {
      const t = this.trials[j];
      if (t && this.isMandatory(j)) need += this.cost(t);
    }
    return elapsedMs + need > this.softCapMs;
  }
}
