/**
 * Shared micro-game kit for the Pathway B set-2 modules and the carousel hub: runtime policy, trial
 * recording, touch targets, select/confirm choices, the scripted bot hand, the cross-module probe
 * segment, raw-tap classification, and the visual stage scaffolding.
 */
export {
  createBigCoin,
  createClothMat,
  createCoveredBasket,
  createLaddooPile,
  createLightPool,
  createSelectionRing,
  drawBigCoin,
  drawLaddoo,
} from './art.ts';
export { BotHand, lognormalMs } from './bot.ts';
export { type ChoiceOutcome, type ChoiceRequest, jitterPoint, runChoice } from './choice.ts';
export { type RawTapClassifier, routeInputLogging, withRawTapClassifier } from './logging.ts';
export { arcTo, bob, hop, popIn, popOut, squash, still } from './motion.ts';
export {
  type ProbeBotPolicy,
  type ProbeCode,
  type ProbeGeometry,
  ProbeScene,
  type ProbeSituation,
  probeGeometry,
  probeSituations,
  runProbeBlock,
} from './probe.ts';
export {
  GameRuntime,
  hasRenderer,
  MicroGameConfigError,
  type MicroGameHooks,
  ModuleAbortedError,
  type PhaseInfo,
  round3,
} from './runtime.ts';
export { type CameraShot, Fireflies, GameStage } from './stage.ts';
export { centerOf, minSpacingPx, minTargetPx, rectAt, squareAt, TargetBoard } from './targets.ts';
export {
  ActiveTrial,
  type ResponseRecord,
  responsePayload,
  TrialRecorder,
  type TrialSpec,
} from './trials.ts';
