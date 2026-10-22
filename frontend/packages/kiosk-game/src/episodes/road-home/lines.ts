/**
 * Voice lines used by Road Home (`content/i18n/lines.yaml`, pre-recorded per language; VOX-01).
 *
 * The episode never relies on a line for comprehension: every instruction is also pictured (hand
 * hints, glowing waypoints, the errand chit). Optional lines are played only when the catalogue has
 * them for the current language (`VoiceService.has`). No line ever mentions the rule reversal or an
 * optional side task (EPI-03 AC; SCR-07 unprompted initiative).
 */
export const ROAD_HOME_LINES = {
  intro: 'road_home.intro',
  practice: 'road_home.practice',
  outro: 'road_home.outro',
  replay: 'road_home.replay',
  blockCue: 'road_home.block_cue',
} as const;

/** Lines the episode would use when recorded (requested from the content owner). */
export const ROAD_HOME_OPTIONAL_LINES = {
  /** "Tap a glowing stone to drive the cart." (practice route) */
  routeHint: 'road_home.route_hint',
  /** "Share some fodder in the trough, then tap the tick." (first fodder stop) */
  fuelHint: 'road_home.fuel_hint',
  /** "Hold the cart to push it up the hill." (first uphill) */
  uphillHint: 'road_home.uphill_hint',
} as const;

export type RoadHomeLineId =
  | (typeof ROAD_HOME_LINES)[keyof typeof ROAD_HOME_LINES]
  | (typeof ROAD_HOME_OPTIONAL_LINES)[keyof typeof ROAD_HOME_OPTIONAL_LINES];
