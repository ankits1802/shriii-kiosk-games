/**
 * Presenter without rendering, for headless bot runs (tests, CI, budget checks). Each scene beat can
 * take a nominal duration on the session clock so a virtual-time run reproduces the episode's real
 * pacing (the trial budget check in the tests uses the view's nominal durations).
 */
import type { Clock } from '../../core/contracts.ts';
import type { RoadHomePresenter } from './types.ts';

/** Nominal beat durations (ms) of the Pixi view; used to estimate real pacing in headless runs. */
export interface BeatDurations {
  readonly intro: number;
  /** Camera into a new map. */
  readonly prepareMap: number;
  /** Cut to a new journey scene (fork road, roadside, fodder stop, hill, crossing). */
  readonly prepareJourney: number;
  /** Next beat in the same scene (the next fork slides in, the next fodder round). */
  readonly prepareNext: number;
  readonly step: number;
  readonly mapDone: number;
  readonly rest: number;
  readonly fork: number;
  readonly optionalTaken: number;
  readonly optionalMissed: number;
  readonly fuel: number;
  readonly effort: number;
  readonly probe: number;
  readonly outro: number;
}

export const ZERO_BEATS: BeatDurations = {
  intro: 0,
  prepareMap: 0,
  prepareJourney: 0,
  prepareNext: 0,
  step: 0,
  mapDone: 0,
  rest: 0,
  fork: 0,
  optionalTaken: 0,
  optionalMissed: 0,
  fuel: 0,
  effort: 0,
  probe: 0,
  outro: 0,
};

export class NullPresenter implements RoadHomePresenter {
  private hurry = false;
  private lastKind: string | null = null;
  readonly calls: string[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly beats: BeatDurations = ZERO_BEATS,
  ) {}

  private async beat(name: string, ms: number, signal?: AbortSignal): Promise<void> {
    this.calls.push(name);
    const d = this.hurry ? ms * 0.5 : ms;
    if (d <= 0) return;
    try {
      await this.clock.delay(d, signal);
    } catch {
      // aborted: resolve quietly (the director checks the signal)
    }
  }

  async init(): Promise<void> {}
  intro(signal: AbortSignal): Promise<void> {
    return this.beat('intro', this.beats.intro, signal);
  }
  prepare(trial: Parameters<RoadHomePresenter['prepare']>[0], signal: AbortSignal): Promise<void> {
    const map =
      trial.kind === 'errand_map' || trial.kind === 'blocked_route' || trial.kind === 'practice';
    const same = trial.kind === this.lastKind && !map;
    this.lastKind = trial.kind;
    const ms = map
      ? this.beats.prepareMap
      : same
        ? this.beats.prepareNext
        : this.beats.prepareJourney;
    return this.beat(`prepare:${trial.kind}`, ms, signal);
  }
  reveal(): void {
    this.calls.push('reveal');
  }
  conceal(): void {}
  offer(): void {}
  hint(): void {}
  step(): Promise<void> {
    return this.beat('step', this.beats.step);
  }
  nudge(): void {
    this.calls.push('nudge');
  }
  rest(): Promise<void> {
    return this.beat('rest', this.beats.rest);
  }
  mapDone(): Promise<void> {
    return this.beat('mapDone', this.beats.mapDone);
  }
  forkOutcome(): Promise<void> {
    return this.beat('fork', this.beats.fork);
  }
  optionalOutcome(_t: unknown, taken: boolean): Promise<void> {
    return this.beat('optional', taken ? this.beats.optionalTaken : this.beats.optionalMissed);
  }
  fuelOutcome(): Promise<void> {
    return this.beat('fuel', this.beats.fuel);
  }
  effortOutcome(): Promise<void> {
    return this.beat('effort', this.beats.effort);
  }
  probeOutcome(): Promise<void> {
    return this.beat('probe', this.beats.probe);
  }
  setHurry(hurry: boolean): void {
    this.hurry = hurry;
  }
  outro(signal: AbortSignal): Promise<void> {
    return this.beat('outro', this.beats.outro, signal);
  }
  touched(): void {}
  fuelChanged(): void {}
  effortProgress(): void {}
  destroy(): void {}
}
