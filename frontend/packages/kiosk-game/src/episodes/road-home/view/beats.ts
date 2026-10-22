/**
 * Nominal durations (ms) of the Pixi view's non-stimulus beats. The view's choreography is timed to
 * these values (GSAP timelines scale to them) and the headless budget test replays them in virtual
 * time, so the trial budget check reflects the real pacing. Halved under soft-cap wrap-up.
 */
import type { BeatDurations } from '../null-presenter.ts';

export const VIEW_BEATS: BeatDurations = {
  intro: 7600,
  prepareMap: 850,
  prepareJourney: 700,
  prepareNext: 420,
  step: 420,
  mapDone: 450,
  rest: 1500,
  fork: 520,
  optionalTaken: 1150,
  optionalMissed: 400,
  fuel: 1300,
  effort: 750,
  probe: 600,
  outro: 3000,
};
