/** MG-05 Share-the-Pot (public goods with scripted partners). */

export { type SharePotGeometry, sharePotGeometry } from './geometry.ts';
export { buildSharePotPlan, planIsValid, type SharePotPlan } from './plan.ts';
export {
  createSharePot,
  SHARE_POT_CONSTRUCTS,
  SHARE_POT_INDICATORS,
  SharePotModule,
} from './SharePotModule.ts';
