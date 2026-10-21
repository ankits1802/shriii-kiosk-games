/**
 * Paradigm logic core: pure, deterministic, rendering-free logic shared by Pathway B micro-games and
 * Pathway A episodes (ENG-05 AC). See `common.ts` for the rules of this directory.
 *
 * | Paradigm                | File                | Modules                                  |
 * |-------------------------|---------------------|------------------------------------------|
 * | Go/No-Go + tap classes  | `go-nogo.ts`        | dont_tap, stall (serving)                |
 * | Held vs free responding | `held-free.ts`      | steady_hands                             |
 * | Delay / effort ladders  | `discounting.ts`    | wait_or_now                              |
 * | Card-sort rule engine   | `card-sort.ts`      | card_sort                                |
 * | Tower of London         | `tower.ts`          | tower                                    |
 * | BART                    | `bart.ts`           | balloon                                  |
 * | Public goods / partners | `public-goods.ts`   | share_pot, road_home (fuel pot), coplay  |
 * | Private report (mode a) | `private-report.ts` | private_dice, weighing_post (luck tokens)|
 * | Fork rule reversal      | `reversal.ts`       | road_home                                |
 * | Route planning          | `route-planning.ts` | road_home                                |
 * | Weighing decisions      | `weighing-post.ts`  | weighing_post                            |
 * | Customer queue          | `stall-queue.ts`    | stall                                    |
 *
 * `PARADIGM_INDICATORS` lists, per paradigm, the scoring-dictionary indicator ids that consume its
 * events and trial params (verified against `scoring/dictionary/*.yaml` by the tests).
 */
import { BART_INDICATORS } from './bart.ts';
import { CARD_SORT_INDICATORS } from './card-sort.ts';
import type { IndicatorBinding } from './common.ts';
import { DISCOUNTING_INDICATORS } from './discounting.ts';
import { GO_NOGO_INDICATORS } from './go-nogo.ts';
import { HELD_FREE_INDICATORS } from './held-free.ts';
import { PRIVATE_REPORT_INDICATORS } from './private-report.ts';
import { PUBLIC_GOODS_INDICATORS } from './public-goods.ts';
import { REVERSAL_INDICATORS } from './reversal.ts';
import { ROUTE_PLANNING_INDICATORS } from './route-planning.ts';
import { STALL_INDICATORS } from './stall-queue.ts';
import { TOWER_INDICATORS } from './tower.ts';
import { WEIGHING_POST_INDICATORS } from './weighing-post.ts';

export * from './bart.ts';
export * from './card-sort.ts';
export * from './common.ts';
export * from './content-defaults.ts';
export * from './discounting.ts';
export * from './go-nogo.ts';
export * from './held-free.ts';
export * from './private-report.ts';
export * from './public-goods.ts';
export * from './reversal.ts';
export * from './route-planning.ts';
export * from './stall-queue.ts';
export * from './tower.ts';
export * from './weighing-post.ts';

/** Indicator bindings per paradigm id (the `paradigms` values used in the module configs). */
export const PARADIGM_INDICATORS: Readonly<Record<string, readonly IndicatorBinding[]>> = {
  go_nogo: GO_NOGO_INDICATORS,
  held_vs_free_responding: HELD_FREE_INDICATORS,
  delay_discounting: DISCOUNTING_INDICATORS,
  card_sort: CARD_SORT_INDICATORS,
  tower_of_london: TOWER_INDICATORS,
  bart: BART_INDICATORS,
  public_goods: PUBLIC_GOODS_INDICATORS,
  private_report: PRIVATE_REPORT_INDICATORS,
  rule_reversal: REVERSAL_INDICATORS,
  route_planning: ROUTE_PLANNING_INDICATORS,
  weighing_decision: WEIGHING_POST_INDICATORS,
  tone_choice: STALL_INDICATORS,
};
