/**
 * Character rig public surface (wave 2): the articulated procedural character, its gesture, gait,
 * face and expression systems and appearance/cloth variants (the dev gallery registers itself via
 * `./gallery.ts`).
 */
export {
  type Appearance,
  appearanceFor,
  CHILD_VARIANT,
  CLOTH_COLOURWAYS,
  GUIDE_APPEARANCE,
  VILLAGERS,
  withCloth,
} from './appearance.ts';
export {
  ANGER_LEVELS,
  EXPRESSION_LIST,
  EXPRESSIONS,
  type ExpressionSymbol,
  type ExtendedExpression,
  toneExpression,
} from './expressions.ts';
export {
  type CharacterDeps,
  type HoldSlot,
  type PlayOptions,
  ProceduralCharacter,
  type RigAnimation,
  type RigCharacterSpec,
} from './ProceduralCharacter.ts';
export { ClothChain, Pendulum } from './rig/cloth.ts';
export {
  type ExpressionFrame,
  ExpressionMachine,
  transitionTime,
} from './rig/expressionMachine.ts';
export {
  type AmplitudeCapable,
  type AmplitudeSource,
  amplitudeOf,
  analyserAmplitude,
  FaceController,
  type FaceState,
  trackAmplitude,
  VISEMES,
  type Viseme,
} from './rig/face.ts';
export { GESTURE_NAMES, GESTURES, type GestureDef, type GestureName } from './rig/gestures.ts';
export { RIG_VIEWS, type RigView, VIEW_YAW } from './rig/kinematics.ts';
export { GAITS, type Gait, gaitSpeed } from './rig/locomotion.ts';
export { type HandShape, POSTURES, type Pose, STAND } from './rig/pose.ts';
