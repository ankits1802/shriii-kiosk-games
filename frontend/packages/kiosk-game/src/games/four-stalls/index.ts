/** MG-09 Four Stalls (IGT-lite). */

export {
  createFourStalls,
  FOUR_STALLS_CONSTRUCTS,
  FOUR_STALLS_INDICATORS,
  FourStallsModule,
} from './FourStallsModule.ts';
export { type FourStallsGeometry, fourStallsGeometry } from './geometry.ts';
export {
  buildDeck,
  buildFourStallsPlan,
  type FourStallsPlan,
  type FourStallsTrialPlan,
  placeErrands,
  STALL_CODES,
  type StallCard,
  type StallCode,
} from './plan.ts';
