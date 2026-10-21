/**
 * Articulated vector character rig (wave 2).
 *
 * A 3-D-aware cut-out rig: anatomical joint angles (shoulder abduction/flexion/twist, elbow, wrist; hip,
 * knee, ankle; spine, head) are projected into the front, three-quarter or side view, so one gesture or
 * gait reads correctly from any angle. Static parts (torso with garment and drape, lower garment, limb
 * segments, hands per shape, feet, head layers) are drawn once per view and baked to textures with a
 * crisp outline; only the face features and cloth ropes are live vector/mesh work, so a dozen
 * characters cost well under 2 ms of CPU per frame.
 *
 * Layers of motion, composed each frame: base stance + expression posture (eased) + idle life
 * (breathing, weight shifts, glances, flourishes) -> locomotion (walk/run cycle with ground-locked feet)
 * -> gesture (keyframed, retargeted per view, crossfaded) -> secondary motion (dupatta, pallu, pagri
 * tail, gamcha, braid, earrings, a carried lantern). The face runs an expression state machine, blinks
 * with randomised timing, makes saccades or holds a look-at target and lip-syncs visemes to the
 * amplitude of the voice that is playing.
 *
 * Backwards compatible with the wave-1 `Character` API (and its extras: setTone, setAngerLevel,
 * setIntensity, speakFor, pointAt, clearLook, entrance, exit); {@link RigCharacterSpec} adds optional
 * fields.
 */
import {
  Container,
  Graphics,
  MeshRope,
  Point as PixiPoint,
  Sprite,
  Texture,
  type Ticker,
} from 'pixi.js';
import { OutlineFilter } from 'pixi-filters';
import type {
  Character,
  CharacterAnimation,
  CharacterSpec,
  Expression,
  Point,
  VoicePlayback,
} from '../../core/contracts.ts';
import { clamp, mixColor } from '../color.ts';
import { softShadow } from '../draw.ts';
import { FX_RADIUS, fxTexture } from '../fx/textures.ts';
import type { Lighting } from '../lighting.ts';
import { motionSettings } from '../motion.ts';
import { MELA } from '../palettes.ts';
import { HandLantern } from '../props/lantern.ts';
import type { QualityProfile } from '../quality.ts';
import { ArtRandom, hashString } from '../rand.ts';
import type { TextureCache } from '../textures.ts';
import { type Appearance, appearanceFor, withCloth } from './appearance.ts';
import type { ExpressionSymbol, ExtendedExpression } from './expressions.ts';
import { ClothChain, Pendulum } from './rig/cloth.ts';
import { type RigDims, rigDims } from './rig/dims.ts';
import {
  drawBraidStrip,
  drawClothStrip,
  drawFoot,
  drawForearm,
  drawHand,
  drawLowerGarment,
  drawShin,
  drawThigh,
  drawTorso,
  drawUpperArm,
} from './rig/drawBody.ts';
import { drawFeatures } from './rig/drawFeatures.ts';
import { drawHeadBase, drawHeadFront } from './rig/drawHead.ts';
import { type ExpressionFrame, ExpressionMachine } from './rig/expressionMachine.ts';
import { type AmplitudeSource, amplitudeOf, FaceController, type FaceState } from './rig/face.ts';
import {
  compileGesture,
  eventsBetween,
  GESTURES,
  type GestureChannel,
  type GestureDef,
  type GestureName,
  gestureLocalTime,
  resolveChannel,
  sampleGesture,
} from './rig/gestures.ts';
import {
  RIG_VIEWS,
  type RigView,
  retargetArm,
  type Side,
  solveArm,
  solveLeg,
  VIEW_YAW,
  viewForYaw,
} from './rig/kinematics.ts';
import { GAITS, type Gait, gaitSpeed, locomotionPose } from './rig/locomotion.ts';
import {
  angleDelta,
  applyPartial,
  armOf,
  copyPose,
  createPose,
  type HandShape,
  type LimbSide,
  legOf,
  type PartialPose,
  POSE_KEYS,
  POSTURE_HANDS,
  POSTURES,
  type Pose,
  type Posture,
  STAND,
  setArm,
} from './rig/pose.ts';
import { SymbolLayer } from './rig/symbols.ts';

export interface CharacterDeps {
  readonly ticker: Ticker;
  readonly lighting: Lighting;
  readonly quality: QualityProfile;
  readonly cache: TextureCache;
}

/** Contract spec plus optional rig fields (all optional: wave-1 specs work unchanged). */
export interface RigCharacterSpec extends CharacterSpec {
  /** Resting view (default front). */
  readonly view?: RigView;
  /** Cloth colour variant (0 = original clothes). */
  readonly cloth?: number;
  /** Idle variations (weight shifts, glances, flourishes); default true. */
  readonly idleVariations?: boolean;
}

/** Everything `play()` accepts: contract animations, gestures and runs. */
export type RigAnimation = CharacterAnimation | GestureName | 'run_in' | 'run_out';

export interface PlayOptions {
  /** Hand that performs a one-handed gesture (default: the screen-facing/near hand). */
  readonly hand?: LimbSide;
  /** Gesture events (e.g. `give`, `take`, `place`). */
  readonly onEvent?: (name: string) => void;
}

export type HoldSlot = LimbSide | 'head';

interface Seg {
  readonly holder: Container;
  art: Container | null;
}

interface ArmRig {
  readonly side: Side;
  readonly key: LimbSide;
  readonly root: Container;
  readonly upper: Seg;
  readonly fore: Seg;
  readonly hand: Seg;
  readonly socket: Container;
  shape: HandShape | null;
  layer: 'back' | 'front' | null;
}

interface LegRig {
  readonly side: Side;
  readonly key: LimbSide;
  readonly root: Container;
  readonly thigh: Seg;
  readonly shin: Seg;
  readonly foot: Seg;
}

interface Rope {
  readonly chain: ClothChain;
  readonly mesh: MeshRope;
  readonly pts: PixiPoint[];
  /** Attachment in body space (front view) and frame. */
  readonly anchor: { x: number; y: number; z: number };
  readonly frame: 'upper' | 'head';
  layer: 'back' | 'front' | null;
}

interface ActiveGesture {
  readonly def: GestureDef;
  readonly main: LimbSide;
  elapsed: number;
  lastT: number;
  holding: boolean;
  releaseT: number;
  resolve: (() => void) | null;
  readonly onEvent: ((name: string) => void) | undefined;
}

interface Locomotion {
  readonly gait: Gait;
  phase: number;
  weight: number;
  /** Rig units still to travel along the figure's forward axis (null = walk in place). */
  remaining: number | null;
  /** Travel by moving the view in its parent (walkTo) instead of the internal offset. */
  readonly moveView: boolean;
  stopping: boolean;
  resolve: (() => void) | null;
  fadeOut: boolean;
  restoreView: boolean;
}

type IdleName = 'shift_weight' | 'look_around' | 'clasp' | 'adjust' | 'sigh';

interface IdleFlourish {
  readonly duration: number;
  readonly pose: PartialPose;
}

const IDLES: Readonly<Record<IdleName, IdleFlourish>> = {
  shift_weight: {
    duration: 3.2,
    pose: {
      pelvisShift: 5,
      pelvisTilt: 0.04,
      lKnee: 0.28,
      lHip: 0.12,
      lAnkle: 0.05,
      headTilt: -0.03,
    },
  },
  look_around: { duration: 2.6, pose: { headTurn: 0.3, headTilt: 0.03 } },
  clasp: {
    duration: 3.4,
    pose: {
      rAbd: 0.16,
      rFlex: 0.32,
      rTwist: -1.45,
      rElbow: 1.32,
      lAbd: 0.16,
      lFlex: 0.3,
      lTwist: -1.45,
      lElbow: 1.28,
    },
  },
  adjust: {
    duration: 1.7,
    pose: { rAbd: 0.25, rFlex: 0.55, rTwist: -1.4, rElbow: 2.25, rWrist: 0.2, headTilt: 0.06 },
  },
  sigh: { duration: 1.6, pose: { shoulderLift: 4, headNod: -0.06, spine: -0.02 } },
};

const OUTLINE_COLOR = 0x3a2018;
/** Far-side limbs are shaded slightly so overlapping legs and arms stay readable. */
const FAR_LIMB_TINT = 0xd6ccc4;
const DEFAULT_SPAN = 440;

const ARM_KEYS: ReadonlySet<string> = new Set(
  (['l', 'r'] as const).flatMap((s) =>
    ['Abd', 'Flex', 'Twist', 'Elbow', 'Wrist'].map((p) => `${s}${p}`),
  ),
);

const VISEME_CODE: Readonly<Record<FaceState['viseme'], number>> = {
  rest: 0,
  mbp: 1,
  ee: 2,
  aa: 3,
  oh: 4,
  oo: 5,
};

/** Background bake jobs shared by all characters; at most one runs per ~frame. */
const PREWARM: (() => void)[] = [];
let lastPrewarm = 0;

function pumpPrewarm(): void {
  if (PREWARM.length === 0) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastPrewarm < 14) return;
  lastPrewarm = now;
  PREWARM.shift()?.();
}

export class ProceduralCharacter implements Character {
  readonly view = new Container();
  readonly spec: RigCharacterSpec;
  readonly appearance: Appearance;
  readonly dims: RigDims;

  private readonly deps: CharacterDeps;
  private readonly rnd: ArtRandom;
  private readonly appearanceKey: string;
  private readonly res: number;
  private readonly shadow = new Graphics();
  private readonly figure = new Container();
  private readonly legLayer = new Container();
  private readonly lower = new Container();
  private readonly upper = new Container();
  private readonly clothBack = new Container();
  private readonly clothFront = new Container();
  private readonly armBack = new Container();
  private readonly armFront = new Container();
  private readonly torso = new Container();
  private readonly head = new Container();
  private readonly headBase = new Container();
  private readonly headFront = new Container();
  private readonly features = new Graphics();
  private readonly headSocket = new Container();
  private readonly symbols: SymbolLayer;
  private readonly arms: Record<LimbSide, ArmRig>;
  private readonly legs: Record<LimbSide, LegRig>;
  private readonly ropes: Rope[] = [];
  private readonly earL = new Pendulum(9, 4);
  private readonly earR = new Pendulum(9, 4);
  private readonly held = new Map<HoldSlot, { item: Container; upright: boolean }>();
  private lantern: { lamp: HandLantern; swing: Pendulum; hand: LimbSide } | null = null;

  // Motion state.
  private readonly machine: ExpressionMachine;
  private readonly face: FaceController;
  private frame: ExpressionFrame;
  private faceState: FaceState;
  private readonly basePose = createPose();
  private readonly armBase = createPose();
  private readonly pose = createPose();
  private readonly snapshot = createPose();
  private crossfade = 1;
  private gesture: ActiveGesture | null = null;
  private loco: Locomotion | null = null;
  private idle: { name: IdleName; t: number; mirror: boolean } | null = null;
  private nextIdle: number;
  private bodyView: RigView;
  private restingView: RigView;
  private builtView: RigView | null = null;
  private headView: { view: RigView; mirror: boolean } | null = null;
  private turn: { t: number; to: RigView } | null = null;
  private lookTarget: Point | null = null;
  private headTurnLook = 0;
  private headNodLook = 0;
  private walkOffset = 0;
  private prevWorldX = 0;
  private prevVel = 0;
  private elapsed: number;
  private paused = false;
  private destroyed = false;
  private readonly sigScratch = new Int32Array(22);
  private readonly sigLast = new Int32Array(22);
  private sigDirty = true;
  private talkingTicket = 0;
  private readonly onTick = (t: Ticker): void => this.advance(Math.min(0.1, t.deltaMS / 1000));
  private unsubLight: (() => void) | null = null;
  private shadowParams = { dir: 0, length: 0, alpha: 0.3, color: 0x000000 };

  constructor(spec: RigCharacterSpec, deps: CharacterDeps) {
    this.spec = spec;
    this.deps = deps;
    this.appearance = withCloth(appearanceFor(spec.role, spec.variant ?? 0), spec.cloth ?? 0);
    this.dims = rigDims(this.appearance);
    this.rnd = new ArtRandom(hashString(spec.id));
    this.appearanceKey = hashString(JSON.stringify(this.appearance)).toString(36);
    const dpr =
      typeof globalThis.devicePixelRatio === 'number'
        ? Math.min(2, globalThis.devicePixelRatio)
        : 1;
    const sc = Math.abs(spec.scale ?? 1);
    this.res = Math.min(
      4,
      Math.max(0.5, Math.ceil(sc * dpr * deps.quality.bakeResolution * 2) / 2),
    );
    this.restingView = spec.view ?? 'front';
    this.bodyView = this.restingView;
    this.elapsed = this.rnd.range(0, 10);
    this.nextIdle = this.rnd.range(3, 7);

    this.view.label = `character:${spec.id}`;
    this.view.eventMode = 'none';
    this.symbols = new SymbolLayer(this.dims.headCY);
    this.arms = { l: this.makeArm('l'), r: this.makeArm('r') };
    this.legs = { l: this.makeLeg('l'), r: this.makeLeg('r') };

    this.upper.pivot.set(0, this.dims.waistY);
    this.upper.position.set(0, this.dims.waistY);
    this.head.pivot.set(0, this.dims.neckTop);
    this.head.position.set(0, this.dims.neckTop);
    this.headSocket.position.set(0, this.dims.headCY - this.dims.headRy - this.headwearHeight());
    this.head.addChild(this.headBase, this.features, this.headFront, this.headSocket);
    this.upper.addChild(
      this.clothBack,
      this.armBack,
      this.torso,
      this.clothFront,
      this.head,
      this.armFront,
    );
    this.figure.addChild(this.legLayer, this.lower, this.upper, this.symbols.view);
    this.view.addChild(this.shadow, this.figure);

    this.machine = new ExpressionMachine('neutral');
    this.face = new FaceController(hashString(`${spec.id}:face`));
    this.frame = this.machine.update(0);
    this.faceState = this.face.update(0);
    this.buildRopes();
    if (this.appearance.lantern) this.attachLantern();

    const facing = spec.facing ?? 'right';
    this.view.scale.set(facing === 'left' ? -sc : sc, sc);

    if (spec.toneLevel !== undefined) this.machine.setTone(spec.toneLevel);
    else this.machine.set(spec.role === 'guide' ? 'calm' : 'neutral');
    this.machine.settle();
    this.frame = this.machine.update(0);
    copyPose(this.armBase, this.postureTarget(this.frame.posture));

    this.buildView(this.bodyView);
    this.queuePrewarm();
    this.unsubLight = deps.lighting.subscribe((p) => {
      this.figure.tint = mixColor(p.lightTint, 0xffffff, 0.4);
      this.shadowParams = {
        dir: p.shadowDir,
        length: p.shadowLength,
        alpha: p.shadowAlpha,
        color: p.shadow,
      };
      this.drawShadow();
      this.lantern?.lamp.setLit(p.lights);
    });
    this.advance(0);
    deps.ticker.add(this.onTick);
  }

  /* ========================================= public API ========================================= */

  get currentExpression(): ExtendedExpression {
    return this.machine.expression;
  }

  get currentSymbol(): ExpressionSymbol {
    return this.frame.symbol;
  }

  /** Current body view. */
  get currentView(): RigView {
    return this.bodyView;
  }

  /** Snapshot of the composed pose (tests, debugging). */
  get currentPose(): Readonly<Pose> {
    return this.pose;
  }

  /** Name of the active gesture, if any. */
  get activeGesture(): GestureName | null {
    return this.gesture?.def.name ?? null;
  }

  /** Current gait, if moving. */
  get activeGait(): Gait | null {
    return this.loco && !this.loco.stopping ? this.loco.gait : null;
  }

  /** Viseme currently on the lips. */
  get currentViseme(): FaceState['viseme'] {
    return this.faceState.viseme;
  }

  setExpression(expression: Expression | ExtendedExpression): void {
    this.machine.set(expression);
  }

  /** Brief reaction (e.g. surprised) that returns to the current expression. */
  react(expression: ExtendedExpression, holdS = 0.9): void {
    this.machine.flash(expression, holdS);
  }

  /** Customer tone (0 calm .. 4 hostile): a stimulus property for The Stall. */
  setTone(level: 0 | 1 | 2 | 3 | 4): void {
    this.machine.setTone(level);
  }

  /** Anger/rudeness level 0..3 (0 calm, 1 impatient, 2 annoyed, 3 angry). */
  setAngerLevel(level: 0 | 1 | 2 | 3): void {
    this.machine.setAnger(level);
  }

  /** Exaggeration of the current negative expression (1..3). */
  setIntensity(intensity: 1 | 2 | 3): void {
    this.machine.setIntensity(intensity);
  }

  /** Turn to a view (front, three-quarter, side). Animated with a quick turn unless `immediate`. */
  setView(view: RigView, immediate = false): void {
    this.restingView = view;
    this.turnTo(view, immediate);
  }

  /** Face screen-left or screen-right. */
  setFacing(facing: 'left' | 'right'): void {
    const sc = Math.abs(this.view.scale.y);
    this.view.scale.x = facing === 'left' ? -sc : sc;
  }

  get facing(): 'left' | 'right' {
    return this.view.scale.x < 0 ? 'left' : 'right';
  }

  /** Enable/disable blinking (deterministic stills). */
  setBlinking(enabled: boolean): void {
    this.face.blinkEnabled = enabled;
  }

  /** Enable/disable idle saccades and flourishes. */
  setIdleLife(enabled: boolean): void {
    this.face.saccadesEnabled = enabled;
    if (!enabled) this.idle = null;
    this.nextIdle = enabled ? this.rnd.range(2, 5) : Number.POSITIVE_INFINITY;
  }

  /** Freeze clocks (gesture, gait, idle) while still rendering; used by the gallery's pose sheets. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Lip-sync to a voice playback until it ends. The mouth follows the clip's amplitude when the playback
   * (or `options.amplitude`) offers one; otherwise a speech-like envelope keeps the lips moving.
   */
  async speak(
    playback: VoicePlayback,
    options: { readonly amplitude?: AmplitudeSource } = {},
  ): Promise<void> {
    const ticket = ++this.talkingTicket;
    await Promise.race([
      playback.started.then(() => undefined),
      playback.ended.then(() => undefined),
    ]);
    if (this.destroyed || ticket !== this.talkingTicket) return;
    this.face.setTalking(true, options.amplitude ?? amplitudeOf(playback));
    try {
      await playback.ended;
    } finally {
      if (ticket === this.talkingTicket) this.face.setTalking(false);
    }
  }

  /** Lip-sync for a fixed duration (gallery previews, scripted beats without a playback object). */
  async speakFor(ms: number, amplitude?: AmplitudeSource): Promise<void> {
    const ticket = ++this.talkingTicket;
    this.face.setTalking(true, amplitude);
    await new Promise((r) =>
      setTimeout(r, Math.max(0, ms * Math.max(0, motionSettings.timeScale))),
    );
    if (ticket === this.talkingTicket) this.face.setTalking(false);
  }

  /** Stop talking now. */
  stopSpeaking(): void {
    this.talkingTicket++;
    this.face.setTalking(false);
  }

  play(animation: RigAnimation, options: PlayOptions = {}): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    switch (animation) {
      case 'idle':
        return this.toIdle();
      case 'walk_in':
      case 'walk_out':
      case 'run_in':
      case 'run_out': {
        const gait: Gait = animation.startsWith('run') ? 'run' : 'walk';
        const into = animation.endsWith('_in');
        return this.travelInternal(gait, into);
      }
      default:
        return this.startGesture(GESTURES[animation], options);
    }
  }

  /** Stop a held gesture (fold arms, carry, push, steer, lantern, foot tap) and blend back. */
  stopGesture(): Promise<void> {
    const g = this.gesture;
    if (!g) return Promise.resolve();
    g.holding = false;
    if (!g.def.loop) return Promise.resolve();
    return new Promise((resolve) => {
      const prev = g.resolve;
      g.resolve = () => {
        prev?.();
        resolve();
      };
    });
  }

  /** Walk or run in place (treadmill) until {@link stopLocomotion}; for scenes that move the parent. */
  setLocomotion(gait: Gait | null): void {
    if (gait === null) {
      void this.stopLocomotion();
      return;
    }
    this.turnTo('side');
    this.loco = this.newLoco(gait, null, false);
  }

  /** Stop walking/running (feet settle). */
  stopLocomotion(): Promise<void> {
    const l = this.loco;
    if (!l) return Promise.resolve();
    l.stopping = true;
    return new Promise((resolve) => {
      const prev = l.resolve;
      l.resolve = () => {
        prev?.();
        resolve();
      };
    });
  }

  /**
   * Walk (or run) to an x position in the parent's coordinates, turning to face the destination, then
   * return to the resting view. Resolves on arrival.
   */
  walkTo(parentX: number, options: { readonly gait?: Gait } = {}): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const dx = parentX - this.view.x;
    if (Math.abs(dx) < 1) return Promise.resolve();
    this.setFacing(dx < 0 ? 'left' : 'right');
    const dist = Math.abs(dx) / Math.max(1e-6, Math.abs(this.view.scale.y));
    this.loco?.resolve?.();
    this.turnTo('side');
    return new Promise((resolve) => {
      const l = this.newLoco(options.gait ?? 'walk', dist, true);
      l.resolve = resolve;
      l.restoreView = true;
      this.loco = l;
      this.settleInstantly();
    });
  }

  /** Point the main arm at a stage point and hold until `play('idle')`/`stopGesture()`. */
  pointAt(point: Point): Promise<void> {
    const local = this.figure.toLocal(point, undefined, undefined, true);
    const theta = VIEW_YAW[this.bodyView];
    const sx = this.shoulderX(theta < 0.05 ? 1 : -1, theta);
    const dx = local.x - sx;
    const dy = local.y - this.dims.shoulderJointY;
    const r = Math.atan2(-dx, dy);
    const useLeft = theta < 0.05 && dx < 0;
    const abd = clamp(useLeft ? r : -r, -0.3, 2.9);
    this.lookAt(point);
    const def: GestureDef = {
      name: 'point',
      duration: 0.4,
      blendOut: 0.35,
      retarget: true,
      loop: { from: 0.38, to: 0.4 },
      keys: [
        {
          t: 0.38,
          pose: { mAbd: abd, mFlex: 0.12, mTwist: 0, mElbow: 0.06, mWrist: 0 },
          ease: 'back',
          hands: { m: 'point' },
        },
      ],
    };
    return this.startGesture(def, useLeft ? { hand: 'l' } : {});
  }

  lookAt(point: Point): void {
    this.lookTarget = { x: point.x, y: point.y };
  }

  /** Release a lookAt (eyes return to the expression's gaze). */
  clearLook(): void {
    this.lookTarget = null;
    this.face.setLook(null);
  }

  /** Guide entrance: walk in, then wave. */
  async entrance(): Promise<void> {
    await this.play('walk_in');
    await this.play('wave');
  }

  /** Guide exit: wave, then walk out. */
  async exit(): Promise<void> {
    await this.play('wave');
    await this.play('walk_out');
  }

  /**
   * Hold an item in a hand (it follows the hand and stays upright) or on the head. Replaces and returns
   * whatever was held there.
   */
  hold(
    item: Container,
    slot: HoldSlot,
    options: { readonly upright?: boolean } = {},
  ): Container | null {
    const prev = this.release(slot);
    const parent = slot === 'head' ? this.headSocket : this.arms[slot].socket;
    parent.addChild(item);
    item.position.set(0, 0);
    this.held.set(slot, { item, upright: options.upright ?? true });
    return prev;
  }

  /** Remove and return the item in a slot (the caller re-parents it). */
  release(slot: HoldSlot): Container | null {
    const h = this.held.get(slot);
    if (!h) return null;
    this.held.delete(slot);
    h.item.removeFromParent();
    h.item.rotation = 0;
    h.item.scale.x = Math.abs(h.item.scale.x);
    return h.item;
  }

  /** Item currently held in a slot. */
  heldItem(slot: HoldSlot): Container | null {
    return this.held.get(slot)?.item ?? null;
  }

  /** Global position of a hand's grip point (for hand-overs and placing on a scale). */
  handPosition(hand: LimbSide): Point {
    const p = this.arms[hand].socket.getGlobalPosition();
    return { x: p.x, y: p.y };
  }

  /**
   * Show one frame of a gesture (time in seconds) frozen, for pose sheets. Clocks stay paused until
   * `setPaused(false)`.
   */
  showGestureFrame(name: GestureName, t: number, options: PlayOptions = {}): void {
    void this.startGesture(GESTURES[name], options);
    const g = this.gesture;
    if (g) {
      g.elapsed = t;
      g.lastT = t;
    }
    this.crossfade = 1;
    this.paused = true;
    this.advance(0);
  }

  /** Show one frame of a gait cycle (phase 0..1) frozen, for pose sheets. */
  showGaitFrame(gait: Gait, phase: number): void {
    this.loco = this.newLoco(gait, null, false);
    this.loco.phase = phase;
    this.loco.weight = 1;
    this.crossfade = 1;
    this.turnTo(this.restingView === 'front' ? 'side' : this.restingView, true);
    this.paused = true;
    this.advance(0);
  }

  /** Advance the rig by `dt` seconds (the ticker calls this; tests can drive it directly). */
  advance(dt: number): void {
    if (this.destroyed) return;
    pumpPrewarm();
    const ts = motionSettings.timeScale;
    const real = Math.max(0, dt);
    const scaled = ts <= 0 ? 10 : real / ts;
    const clockDt = this.paused ? 0 : Math.min(ts <= 0 ? 10 : 0.25, scaled);
    this.elapsed += clockDt;
    this.updateTurn(real);
    this.updateExpression(clockDt > 0 ? clockDt : real);
    this.composePose(clockDt);
    this.applyPose(real, clockDt);
    this.updateFace(this.paused ? 0 : real);
    this.symbols.update(real, this.deps.quality.motionScale);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.deps.ticker.remove(this.onTick);
    this.unsubLight?.();
    this.gesture?.resolve?.();
    this.gesture = null;
    this.loco?.resolve?.();
    this.loco = null;
    for (const h of this.held.values()) h.item.removeFromParent();
    this.held.clear();
    this.lantern?.lamp.destroy();
    this.lantern = null;
    if (!this.view.destroyed) {
      this.view.removeFromParent();
      this.view.destroy({ children: true });
    }
  }

  /* ======================================== composition ======================================== */

  private updateExpression(dt: number): void {
    this.frame = this.machine.update(dt);
    if (this.frame.changed && this.rnd.chance(0.4)) this.face.triggerBlink();
    this.symbols.set(this.frame.symbol, this.frame.intensity);
    this.face.setRestGaze(this.frame.params.gazeX, this.frame.params.gazeY);
  }

  private readonly postureCache = new Map<string, Pose>();

  private cachedPostureTarget(posture: Posture): Pose {
    const key = `${posture}:${this.bodyView}:${this.lantern?.hand ?? ''}`;
    let p = this.postureCache.get(key);
    if (!p) {
      p = this.postureTarget(posture);
      this.postureCache.set(key, p);
    }
    return p;
  }

  private postureTarget(posture: Posture): Pose {
    const p = createPose(STAND);
    // Postures are authored with `r` as the main arm (front view); turned views use the near arm.
    applyPartial(
      p,
      VIEW_YAW[this.bodyView] < 0.05 ? POSTURES[posture] : mirrorArms(POSTURES[posture]),
    );
    if (this.lantern) applyPartial(p, lanternArm(this.lantern.hand));
    return p;
  }

  private mainSide(def: GestureDef | null, requested?: LimbSide): LimbSide {
    if (requested) return requested;
    // Screen-directed gestures use the screen-right arm in front and three-quarter views (it does
    // not cross the body) and the near arm in profile.
    let main: LimbSide = this.bodyView === 'side' ? 'l' : 'r';
    if (def && !def.holdsItem && this.held.has(main) && !this.held.has(main === 'l' ? 'r' : 'l'))
      main = main === 'l' ? 'r' : 'l';
    const other: LimbSide = main === 'l' ? 'r' : 'l';
    if (def?.holdsItem && !this.held.has(main) && this.held.has(other)) main = other;
    if (def?.name === 'hold_lantern' && this.lantern) main = this.lantern.hand;
    return main;
  }

  private startGesture(def: GestureDef, options: PlayOptions): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const prev = this.gesture;
    if (prev) prev.resolve?.();
    this.beginCrossfade();
    const main = this.mainSide(def, options.hand);
    compileGesture(def, main);
    if (def.expression) {
      const base = this.machine.baseExpression;
      if (base === 'neutral' || base === 'calm' || base === 'pleased' || base === 'happy')
        this.machine.flash(def.expression, def.duration * 0.9);
    }
    if (def.sparkle) this.machine.flash('delighted', def.duration);
    this.idle = null;
    return new Promise((resolve) => {
      this.gesture = {
        def,
        main,
        elapsed: 0,
        lastT: 0,
        holding: def.loop !== undefined,
        releaseT: 0,
        resolve,
        onEvent: options.onEvent,
      };
      if (motionSettings.timeScale <= 0) this.advance(0);
    });
  }

  private toIdle(): Promise<void> {
    const pending: Promise<void>[] = [];
    if (this.gesture) {
      if (this.gesture.def.loop) pending.push(this.stopGesture());
      else {
        this.beginCrossfade();
        this.gesture.resolve?.();
        this.gesture = null;
      }
    }
    if (this.loco) pending.push(this.stopLocomotion());
    if (pending.length === 0) {
      this.beginCrossfade();
      return motionSettings.timeScale <= 0
        ? Promise.resolve()
        : new Promise((r) => setTimeout(r, 300 * motionSettings.timeScale));
    }
    return Promise.all(pending).then(() => undefined);
  }

  private newLoco(gait: Gait, distance: number | null, moveView: boolean): Locomotion {
    return {
      gait,
      phase: 0,
      weight: 0,
      remaining: distance,
      moveView,
      stopping: false,
      resolve: null,
      fadeOut: false,
      restoreView: false,
    };
  }

  private travelInternal(gait: Gait, into: boolean): Promise<void> {
    this.loco?.resolve?.();
    this.turnTo('side', into);
    if (into) {
      this.walkOffset = -DEFAULT_SPAN;
      this.view.alpha = 1;
      this.prevWorldX = this.worldX();
    }
    return new Promise((resolve) => {
      const l = this.newLoco(gait, DEFAULT_SPAN, false);
      l.resolve = resolve;
      l.fadeOut = !into;
      l.restoreView = into;
      if (into) l.weight = 1;
      this.loco = l;
      this.settleInstantly();
    });
  }

  /** With motion disabled (timeScale 0) run the few frames a move needs to complete now. */
  private settleInstantly(): void {
    if (motionSettings.timeScale > 0) return;
    for (let i = 0; i < 4 && this.loco; i++) this.advance(0);
  }

  private beginCrossfade(): void {
    copyPose(this.snapshot, this.pose);
    this.crossfade = 0;
  }

  private turnTo(view: RigView, immediate = false): void {
    if (immediate || this.builtView === null || motionSettings.timeScale <= 0) {
      this.turn = null;
      this.bodyView = view;
      this.buildView(view);
      return;
    }
    if (view === this.bodyView && !this.turn) return;
    this.turn = { t: 0, to: view };
  }

  private updateTurn(dt: number): void {
    if (!this.turn) {
      this.figure.scale.x = 1;
      return;
    }
    const dur = 0.2;
    this.turn.t += dt / Math.max(0.05, motionSettings.timeScale || 1);
    const u = Math.min(1, this.turn.t / dur);
    if (u >= 0.5 && this.bodyView !== this.turn.to) {
      this.bodyView = this.turn.to;
      this.buildView(this.bodyView);
    }
    this.figure.scale.x = 1 - 0.16 * Math.sin(Math.PI * u);
    if (u >= 1) {
      this.turn = null;
      this.figure.scale.x = 1;
    }
  }

  private composePose(dt: number): void {
    const ms = this.deps.quality.motionScale;
    const t = this.elapsed;
    const base = this.basePose;
    // Expression posture, eased.
    const target = this.cachedPostureTarget(this.frame.posture);
    const k = dt > 0 ? 1 - Math.exp(-dt * 7) : 0;
    for (const key of POSE_KEYS) this.armBase[key] += (target[key] - this.armBase[key]) * k;
    copyPose(base, this.armBase);
    const fr = this.frame;
    base.lean += fr.params.lean;
    base.headTilt += fr.params.tilt;
    // Breathing and sway.
    base.pelvisShift += Math.sin(t * 0.55) * 1.2 * ms;
    base.headTilt += Math.sin(t * 0.6) * 0.022 * ms;
    if (fr.fidget === 'shake') base.lean += Math.sin(t * 13) * 0.011 * fr.intensity * ms;
    if (fr.fidget === 'bounce') base.rootY -= Math.abs(Math.sin(t * 3.2)) * 3 * ms;
    if (fr.fidget === 'foot_tap' && !this.loco && this.gesture?.def.name !== 'foot_tap') {
      const tap = Math.max(0, Math.sin(t * Math.PI * 2 * 1.4));
      const m: LimbSide = VIEW_YAW[this.bodyView] < 0.05 ? 'r' : 'l';
      base[m === 'r' ? 'rAnkle' : 'lAnkle'] = 0.4 * tap * Math.max(0.4, ms);
      base[m === 'r' ? 'rKnee' : 'lKnee'] = 0.08;
    }
    // Talking: small emphasis nods.
    base.headNod += this.faceState.envelope * 0.035 * ms;
    // Look-at head turn.
    base.headTurn += this.headTurnLook;
    base.headNod += this.headNodLook;
    // Idle flourishes.
    this.updateIdle(dt, base);

    const out = this.pose;
    copyPose(out, base);
    // Locomotion.
    const l = this.loco;
    if (l) {
      const g = this.gesture;
      const armsFree = !g?.def.keys.some((kf) => 'mAbd' in kf.pose || 'oAbd' in kf.pose);
      const fade = dt > 0 ? dt / 0.2 : 0;
      if (l.stopping) l.weight = Math.max(0, l.weight - fade);
      else l.weight = Math.min(1, l.weight + fade);
      l.phase = (l.phase + dt * GAITS[l.gait].cadence) % 1;
      locomotionPose(out, l.phase, l.gait, l.weight, armsFree);
    }
    // Gesture.
    const g = this.gesture;
    if (g) {
      g.elapsed += dt;
      const kt = gestureLocalTime(g.def, g.elapsed, g.holding);
      if (!g.holding && g.def.loop) g.releaseT += dt;
      for (const ev of eventsBetween(g.def, g.lastT, kt)) g.onEvent?.(ev);
      g.lastT = kt;
      const s = sampleGesture(
        g.def,
        kt,
        g.main,
        out,
        out,
        g.def.loop && !g.holding ? g.releaseT : 0,
      );
      const prof = g.def.profile;
      if (prof && this.bodyView === 'side')
        for (const [ch, dv] of Object.entries(prof) as [GestureChannel, number][])
          out[resolveChannel(ch, g.main)] += dv * s.weight;
      if (g.def.retarget) this.retargetMain(out, g.main, s.weight);
      if (g.def.loop && g.holding && g.resolve && g.elapsed >= g.def.loop.from) {
        g.resolve();
        g.resolve = null;
      }
      if (s.done) {
        g.resolve?.();
        this.gesture = null;
      }
    }
    // Crossfade from the previous pose after interruptions.
    if (this.crossfade < 1) {
      this.crossfade = Math.min(1, this.crossfade + (dt > 0 ? dt / 0.22 : 0));
      const w = this.crossfade * this.crossfade * (3 - 2 * this.crossfade);
      for (const key of POSE_KEYS) {
        const a = this.snapshot[key];
        out[key] =
          a +
          (key === 'rootX' || key === 'rootY' || key === 'pelvisShift' || key === 'shoulderLift'
            ? out[key] - a
            : angleDelta(a, out[key])) *
            w;
      }
    }
  }

  private retargetMain(p: Pose, main: LimbSide, weight: number): void {
    const theta = VIEW_YAW[this.bodyView];
    if (theta < 0.05 || weight <= 0) return;
    const src = armOf(p, main);
    const side: Side = main === 'l' ? -1 : 1;
    const rt = retargetArm(src, side, theta);
    setArm(p, main, {
      abd: src.abd + angleDelta(src.abd, rt.abd) * weight,
      flex: src.flex + angleDelta(src.flex, rt.flex) * weight,
      twist: src.twist + angleDelta(src.twist, rt.twist) * weight,
      elbow: src.elbow + angleDelta(src.elbow, rt.elbow) * weight,
      wrist: src.wrist,
    });
  }

  private updateIdle(dt: number, base: Pose): void {
    const allowed =
      this.spec.idleVariations !== false &&
      !this.gesture &&
      !this.loco &&
      this.frame.posture === 'relaxed' &&
      !this.face.isTalking;
    if (!allowed) {
      if (this.idle && dt > 0)
        this.idle.t = Math.max(this.idle.t, IDLES[this.idle.name].duration - 0.4);
    }
    if (!this.idle && allowed && dt > 0) {
      this.nextIdle -= dt;
      if (this.nextIdle <= 0) {
        const names: IdleName[] = ['shift_weight', 'look_around', 'clasp', 'shift_weight', 'sigh'];
        if (this.appearance.drape !== 'none') names.push('adjust');
        if (this.lantern || this.held.size > 0) names.splice(names.indexOf('clasp'), 1);
        this.idle = { name: this.rnd.pick(names), t: 0, mirror: this.rnd.chance(0.5) };
        this.nextIdle = this.rnd.range(4.5, 10);
      }
    }
    const idle = this.idle;
    if (!idle) return;
    idle.t += dt;
    const def = IDLES[idle.name];
    if (idle.t >= def.duration) {
      this.idle = null;
      return;
    }
    const ramp = 0.45;
    const u = Math.min(1, idle.t / ramp, (def.duration - idle.t) / ramp);
    const w = u * u * (3 - 2 * u);
    for (const key of POSE_KEYS) {
      let v = def.pose[key];
      if (v === undefined) continue;
      let k2 = key;
      if (idle.mirror) {
        if (
          key === 'pelvisShift' ||
          key === 'pelvisTilt' ||
          key === 'headTurn' ||
          key === 'headTilt'
        )
          v = -v;
        else if (key.startsWith('l') && key !== 'lean') k2 = `r${key.slice(1)}` as typeof key;
        else if (key.startsWith('r') && key !== 'rootX' && key !== 'rootY')
          k2 = `l${key.slice(1)}` as typeof key;
      }
      const isArm = ARM_KEYS.has(k2);
      const holding =
        isArm && (this.held.has(k2.charAt(0) as LimbSide) || this.lantern?.hand === k2.charAt(0));
      if (holding) continue;
      base[k2] += (v - (isArm ? base[k2] : 0)) * w;
    }
  }

  /* ========================================== rendering ========================================= */

  private applyPose(realDt: number, clockDt: number): void {
    const p = this.pose;
    const d = this.dims;
    const theta = VIEW_YAW[this.bodyView];
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const ms = this.deps.quality.motionScale;

    // Locomotion travel.
    const l = this.loco;
    if (l && clockDt > 0) {
      const full = gaitSpeed(l.gait, d.thigh, d.shin);
      const step = full * l.weight * clockDt;
      if (l.remaining !== null) {
        const move = Math.min(step, l.remaining);
        l.remaining -= move;
        if (l.moveView)
          this.view.x += move * Math.sign(this.view.scale.x) * Math.abs(this.view.scale.y);
        else this.walkOffset += move;
        // Begin slowing so the last steps land on the mark (weight fades over 0.2 s).
        if (l.remaining <= full * 0.1 + 0.5) l.stopping = true;
      }
      if (l.fadeOut && l.remaining !== null && l.remaining < 90)
        this.view.alpha = Math.max(0, l.remaining / 90);
      if (l.stopping && l.weight <= 0) {
        if (l.fadeOut) {
          this.view.alpha = 0;
          this.walkOffset = 0;
        }
        if (!l.fadeOut && !l.moveView && l.remaining !== null) this.walkOffset = 0;
        if (l.restoreView) this.turnTo(this.restingView);
        this.loco = null;
        l.resolve?.();
      }
    }

    // Legs (ground-locked).
    const legChains = (['l', 'r'] as const).map((k) => {
      const side: Side = k === 'l' ? -1 : 1;
      const chain = solveLeg(side, legOf(p, k), theta, d.thigh, d.shin);
      const hip = { x: this.hipX(side, theta) + p.pelvisShift * ct, y: d.hipJointY };
      return { k, side, chain, hip, depth: -side * d.hipJointX * st + chain.thigh.depth * 10 };
    });
    let lowest = Number.NEGATIVE_INFINITY;
    for (const c of legChains) lowest = Math.max(lowest, c.hip.y + c.chain.ankle.y);
    const grounded = this.gesture?.def.grounded !== false;
    const gw = this.gesture && !grounded ? 1 : 0;
    const groundOffset = d.ankleY - lowest;
    const seatOffset = -d.hipJointY;
    const offY = groundOffset * (1 - gw) + seatOffset * gw;
    this.figure.x = this.walkOffset + p.rootX;
    this.figure.y = offY + p.rootY;
    this.figure.rotation = p.lean;
    this.figure.scale.y = 1 - p.squash * 0.5;
    if (!this.turn) this.figure.scale.x = 1 + p.squash * 0.4;

    legChains.sort((a, b) => a.depth - b.depth);
    legChains.forEach((c, i) => {
      const leg = this.legs[c.k];
      if (this.legLayer.getChildIndex(leg.root) !== i) this.legLayer.setChildIndex(leg.root, i);
      const tint = i === 0 && st > 0.3 ? FAR_LIMB_TINT : 0xffffff;
      if (leg.root.tint !== tint) leg.root.tint = tint;
      leg.thigh.holder.position.set(c.hip.x, c.hip.y);
      leg.thigh.holder.rotation = c.chain.thigh.rotation;
      leg.thigh.holder.scale.y = Math.max(0.3, c.chain.thigh.scale);
      leg.shin.holder.position.set(c.hip.x + c.chain.knee.x, c.hip.y + c.chain.knee.y);
      leg.shin.holder.rotation = c.chain.shin.rotation;
      leg.shin.holder.scale.y = Math.max(0.3, c.chain.shin.scale);
      const ankle = legOf(p, c.k).ankle;
      leg.foot.holder.position.set(c.hip.x + c.chain.ankle.x, c.hip.y + c.chain.ankle.y);
      leg.foot.holder.rotation = -ankle * st;
      const lift = Math.max(0, ankle) * ct;
      leg.foot.holder.scale.y = 1 - 0.45 * lift;
    });
    // Skirts swing with the legs.
    if (d.skirt) {
      const lA = legChains.find((c) => c.k === 'l')?.chain;
      const rA = legChains.find((c) => c.k === 'r')?.chain;
      const avg = lA && rA ? (lA.ankle.x + rA.ankle.x) / 2 : 0;
      const spread = lA && rA ? Math.abs(lA.ankle.x - rA.ankle.x) : 0;
      this.lower.skew.x = clamp(-avg / 260, -0.25, 0.25);
      this.lower.scale.x = 1 + Math.max(0, spread - 20) * 0.0035;
    } else {
      this.lower.skew.x = 0;
      this.lower.scale.x = 1;
    }
    this.lower.x = p.pelvisShift * ct;

    // Upper body.
    const breath = Math.sin(this.elapsed * 1.7);
    this.upper.rotation = p.spine * st + p.pelvisTilt * ct * 0.6;
    this.upper.scale.y = 1 + 0.012 * breath * ms - p.spine * ct * 0.05;
    this.upper.x = p.pelvisShift * ct * 0.7;
    this.head.rotation = p.headTilt;
    this.head.y = d.neckTop + p.headNod * 26 + breath * 0.6 * ms - p.shoulderLift * 0.3;
    this.head.skew.x = p.headNod * 0.1;

    // Head view follows body yaw + head turn.
    const yaw = theta + p.headTurn;
    const hv = viewForYaw(yaw);
    const mirror = yaw < 0 && hv !== 'front';
    if (!this.headView || this.headView.view !== hv || this.headView.mirror !== mirror) {
      this.headView = { view: hv, mirror };
      this.buildHead(hv);
    }
    this.head.scale.x = mirror ? -1 : 1;
    const featureYaw = mirror ? -yaw : yaw;
    this.headFront.x = (featureYaw - VIEW_YAW[hv]) * 10;

    // Arms.
    for (const k of ['l', 'r'] as const) this.applyArm(this.arms[k], p, theta, st);

    // Held items stay upright.
    const baseRot = this.upper.rotation + this.figure.rotation;
    for (const [slot, h] of this.held) {
      if (slot === 'head') {
        h.item.rotation = h.upright ? -(this.head.rotation + baseRot) * 0.7 : 0;
        continue;
      }
      const arm = this.arms[slot];
      const handRot = arm.hand.holder.rotation;
      h.item.scale.x = Math.abs(h.item.scale.x) * (arm.hand.holder.scale.x < 0 ? -1 : 1);
      h.item.rotation = h.upright
        ? -(handRot + baseRot) * (arm.hand.holder.scale.x < 0 ? -1 : 1)
        : 0;
    }

    // Secondary motion.
    const wx = this.worldX();
    const vel = realDt > 0 ? (wx - this.prevWorldX) / realDt : 0;
    const acc = realDt > 0 ? (vel - this.prevVel) / realDt : 0;
    this.prevWorldX = wx;
    this.prevVel = vel;
    const fVel = { x: vel, y: 0 };
    const fAcc = { x: clamp(acc, -4000, 4000), y: 0 };
    this.updateRopes(realDt, theta, fVel, fAcc, ms);
    this.earL.update(realDt, fAcc.x + (this.head.rotation - p.headTilt) * 0, ms);
    this.earR.update(realDt, fAcc.x, ms);
    if (this.lantern) {
      const arm = this.arms[this.lantern.hand];
      const handRot = arm.hand.holder.rotation;
      const mirrorHand = arm.hand.holder.scale.x < 0 ? -1 : 1;
      const sw = this.lantern.swing.update(realDt, fAcc.x * 0.6, ms);
      this.lantern.lamp.view.rotation = (-(handRot + baseRot) + sw) * mirrorHand;
      this.lantern.lamp.view.scale.x = mirrorHand;
      this.lantern.lamp.update(realDt, ms);
    }

    // Shadow follows the feet; shrinks in the air.
    this.shadow.x = this.figure.x;
    const air = Math.max(0, -p.rootY);
    this.shadow.scale.set(1 - Math.min(0.4, air / 60), 1 - Math.min(0.4, air / 60));
  }

  private applyArm(arm: ArmRig, p: Pose, theta: number, st: number): void {
    const d = this.dims;
    const a = armOf(p, arm.key);
    const chain = solveArm(arm.side, a, theta, d.upperArm, d.foreArm);
    const sx = this.shoulderX(arm.side, theta);
    const sy = d.shoulderJointY - p.shoulderLift;
    const shoulderDepth = -arm.side * d.shoulderX * st;
    const layer: 'back' | 'front' = shoulderDepth + chain.handDepth * 0.6 < -6 ? 'back' : 'front';
    if (arm.layer !== layer) {
      arm.layer = layer;
      (layer === 'back' ? this.armBack : this.armFront).addChild(arm.root);
      arm.root.tint = layer === 'back' ? FAR_LIMB_TINT : 0xffffff;
    }
    arm.upper.holder.position.set(sx, sy);
    arm.upper.holder.rotation = chain.upper.rotation;
    arm.upper.holder.scale.y = Math.max(0.25, chain.upper.scale);
    arm.fore.holder.position.set(sx + chain.elbow.x, sy + chain.elbow.y);
    arm.fore.holder.rotation = chain.fore.rotation;
    arm.fore.holder.scale.y = Math.max(0.25, chain.fore.scale);
    const foreOnTop = chain.fore.depth >= chain.upper.depth - 0.35;
    const want = foreOnTop ? 1 : 0;
    if (arm.root.getChildIndex(arm.fore.holder) !== want)
      arm.root.setChildIndex(arm.fore.holder, want);
    arm.hand.holder.position.set(sx + chain.wrist.x, sy + chain.wrist.y);
    // Hands are drawn for the screen-right arm (thumb towards the body centre). The screen-left arm
    // mirrors them; in turned views both thumbs lead in the facing direction.
    const mx = theta < 0.05 ? (arm.side < 0 ? -1 : 1) : -1;
    arm.hand.holder.scale.x = mx;
    arm.hand.holder.rotation = chain.fore.rotation + a.wrist * mx;
    const shape = this.handShapeFor(arm.key);
    if (shape !== arm.shape) {
      arm.shape = shape;
      this.setSegArt(
        arm.hand,
        this.bakePart(`hand_${shape}`, (g) => drawHand(g, this.appearance, shape)),
      );
    }
  }

  private handShapeFor(key: LimbSide): HandShape {
    if (this.lantern?.hand === key || this.held.has(key)) {
      const g = this.gesture;
      if (g?.def.holdsItem && g.main === key) {
        const hs = this.gestureHands();
        return hs.m ?? 'grip';
      }
      return 'grip';
    }
    const g = this.gesture;
    if (g) {
      const hs = this.gestureHands();
      const own = g.main === key ? hs.m : hs.o;
      if (own) return own;
    }
    if (this.loco?.gait === 'run' && !this.loco.stopping) return 'fist';
    if (this.idle?.name === 'clasp') return 'relaxed';
    const [m, o] = POSTURE_HANDS[this.frame.posture];
    const main: LimbSide = VIEW_YAW[this.bodyView] < 0.05 ? 'r' : 'l';
    return key === main ? m : o;
  }

  private gestureHands(): { m?: HandShape; o?: HandShape } {
    const g = this.gesture;
    if (!g) return {};
    const kt = gestureLocalTime(g.def, g.elapsed, g.holding);
    const out: { m?: HandShape; o?: HandShape } = {};
    if (!g.holding && g.def.loop && g.releaseT > g.def.blendOut * 0.5) return out;
    if (!g.def.loop && kt > g.def.duration + g.def.blendOut * 0.5) return out;
    for (const kf of g.def.keys) {
      if (kf.t - 0.12 > Math.min(kt, g.def.duration)) break;
      if (kf.hands?.m) out.m = kf.hands.m;
      if (kf.hands?.o) out.o = kf.hands.o;
    }
    return out;
  }

  private updateFace(dt: number): void {
    const d = this.dims;
    // Look-at: eyes take the target, the head turns part of the way.
    if (this.lookTarget) {
      const local = this.figure.toLocal(this.lookTarget, undefined, undefined, true);
      const dx = local.x - this.head.x;
      const dy = local.y - d.headCY;
      const turnTarget = clamp(dx / 900, -0.38, 0.38) * (VIEW_YAW[this.bodyView] > 1.2 ? 0.3 : 1);
      const nodTarget = clamp(dy / 1400, -0.12, 0.16);
      const k = dt > 0 ? 1 - Math.exp(-dt * 6) : 1;
      this.headTurnLook += (turnTarget - this.headTurnLook) * k;
      this.headNodLook += (nodTarget - this.headNodLook) * k;
      this.face.setLook({ x: clamp(dx / 260, -1, 1), y: clamp(dy / 260, -1, 1) });
    } else {
      const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
      this.headTurnLook -= this.headTurnLook * k;
      this.headNodLook -= this.headNodLook * k;
    }
    this.faceState = this.face.update(dt);
    const f = this.faceState;
    const pr = this.frame.params;
    const yaw = VIEW_YAW[this.bodyView] + this.pose.headTurn;
    const mirror = this.headView?.mirror ?? false;
    const fy = mirror ? -yaw : yaw;
    const env = f.envelope;
    const params = env > 0.02 ? { ...pr, browLift: pr.browLift + env * 1.6 } : pr;
    const gazeX = mirror ? -f.gazeX : f.gazeX;
    // Redraw only when a visible value changed (quantised; most idle frames are skipped).
    const q = this.sigScratch;
    q[0] = Math.round(params.browAngle * 1000);
    q[1] = Math.round(params.browLift * 100);
    q[2] = Math.round(params.browAsym * 100);
    q[3] = Math.round(params.eyeOpen * 1000);
    q[4] = Math.round(params.eyeSmile * 1000);
    q[5] = Math.round(params.pupil * 100);
    q[6] = Math.round(params.smile * 1000);
    q[7] = Math.round(params.mouthOpen * 1000);
    q[8] = Math.round(params.mouthWidth * 1000);
    q[9] = Math.round(params.teeth * 100);
    q[10] = Math.round(params.blush * 100);
    q[11] = Math.round(params.flush * 100);
    q[12] = Math.round(f.blink * 100);
    q[13] = Math.round(gazeX * 100);
    q[14] = Math.round(f.gazeY * 100);
    q[15] = Math.round(f.mouthOpen * 100);
    q[16] = Math.round(f.mouthWidth * 100);
    q[17] = Math.round(f.mouthRound * 100);
    q[18] = VISEME_CODE[f.viseme];
    q[19] = Math.round(fy * 1000);
    q[20] = Math.round(this.earL.angle * 100);
    q[21] = Math.round(this.earR.angle * 100);
    let same = !this.sigDirty;
    for (let k = 0; k < q.length && same; k++) if (q[k] !== this.sigLast[k]) same = false;
    if (same) return;
    this.sigLast.set(q);
    this.sigDirty = false;
    drawFeatures(
      this.features,
      this.appearance,
      d,
      params,
      {
        blink: f.blink,
        gazeX,
        gazeY: f.gazeY,
        mouthOpen: f.mouthOpen,
        mouthWidth: f.mouthWidth,
        mouthRound: f.mouthRound,
        pressed: f.viseme === 'mbp',
      },
      fy,
      { l: this.earL.angle, r: this.earR.angle },
    );
  }

  /* ========================================= building ========================================== */

  private makeSeg(): Seg {
    return { holder: new Container(), art: null };
  }

  private setSegArt(seg: Seg, art: Container): void {
    if (seg.art) {
      seg.art.removeFromParent();
      seg.art.destroy({ children: true });
    }
    seg.art = art;
    seg.holder.addChildAt(art, 0);
  }

  private makeArm(key: LimbSide): ArmRig {
    const root = new Container();
    root.label = `arm-${key}`;
    const arm: ArmRig = {
      side: key === 'l' ? -1 : 1,
      key,
      root,
      upper: this.makeSeg(),
      fore: this.makeSeg(),
      hand: this.makeSeg(),
      socket: new Container(),
      shape: null,
      layer: null,
    };
    arm.socket.position.set(0, 10 * this.appearance.build);
    arm.hand.holder.addChild(arm.socket);
    root.addChild(arm.upper.holder, arm.fore.holder, arm.hand.holder);
    return arm;
  }

  private makeLeg(key: LimbSide): LegRig {
    const root = new Container();
    root.label = `leg-${key}`;
    const leg: LegRig = {
      side: key === 'l' ? -1 : 1,
      key,
      root,
      thigh: this.makeSeg(),
      shin: this.makeSeg(),
      foot: this.makeSeg(),
    };
    root.addChild(leg.thigh.holder, leg.shin.holder, leg.foot.holder);
    this.legLayer.addChild(root);
    return leg;
  }

  private headwearHeight(): number {
    switch (this.appearance.headwear) {
      case 'turban':
        return 28;
      case 'pagri':
        return 18;
      case 'cap':
      case 'topi':
        return 10;
      case 'pallu_head':
        return 8;
      default:
        return this.appearance.hairStyle === 'bun' ? 6 : 2;
    }
  }

  /** Bake (or fetch) a static part. */
  private bakePart(part: string, draw: (g: Graphics) => void): Container {
    const cache = this.deps.cache;
    const key = `rig:${this.appearanceKey}:${part}:${this.res}`;
    return cache.bake(
      key,
      () => {
        const g = new Graphics();
        draw(g);
        if (cache.canBake) {
          // Thickness is in logical (rig) units; the filter samples at the bake resolution.
          const outline = new OutlineFilter({
            thickness: 2.2,
            color: OUTLINE_COLOR,
            alpha: 0.72,
            quality: 0.6,
          });
          // Filters default to resolution 1: render the outline at the bake resolution (crisp).
          outline.resolution = this.res;
          g.filters = [outline];
        }
        return g;
      },
      { padding: 6, resolution: this.res },
    );
  }

  /** Bake the other views' parts in the background (one part per frame across all characters). */
  private queuePrewarm(): void {
    if (!this.deps.cache.canBake) return;
    const a = this.appearance;
    const d = this.dims;
    for (const view of RIG_VIEWS) {
      const theta = VIEW_YAW[view];
      const parts: [string, (g: Graphics) => void][] = [
        [`torso_${view}`, (g) => drawTorso(g, a, d, theta)],
        [`lower_${view}`, (g) => drawLowerGarment(g, a, d, theta)],
        [`foot_${view}`, (g) => drawFoot(g, a, d, theta)],
        [`headbase_${view}`, (g) => drawHeadBase(g, a, d, theta)],
        [`headfront_${view}`, (g) => drawHeadFront(g, a, d, theta)],
      ];
      for (const [part, draw] of parts)
        PREWARM.push(() => {
          if (!this.destroyed) this.bakePart(part, draw).destroy({ children: true });
        });
    }
    for (const shape of ['open', 'fist', 'point', 'grip', 'flat'] as const)
      PREWARM.push(() => {
        if (!this.destroyed)
          this.bakePart(`hand_${shape}`, (g) => drawHand(g, a, shape)).destroy({ children: true });
      });
  }

  private buildView(view: RigView): void {
    if (this.builtView === view) return;
    this.builtView = view;
    const a = this.appearance;
    const d = this.dims;
    const theta = VIEW_YAW[view];
    for (const c of this.torso.removeChildren()) c.destroy({ children: true });
    this.torso.addChild(this.bakePart(`torso_${view}`, (g) => drawTorso(g, a, d, theta)));
    for (const c of this.lower.removeChildren()) c.destroy({ children: true });
    const lowerArt = this.bakePart(`lower_${view}`, (g) => drawLowerGarment(g, a, d, theta));
    // Skirts skew about the waist.
    this.lower.pivot.set(0, d.skirt ? d.waistY : 0);
    this.lower.y = d.skirt ? d.waistY : 0;
    this.lower.addChild(lowerArt);
    for (const k of ['l', 'r'] as const) {
      const arm = this.arms[k];
      if (!arm.upper.art) {
        this.setSegArt(
          arm.upper,
          this.bakePart('upperarm', (g) => drawUpperArm(g, a, d)),
        );
        this.setSegArt(
          arm.fore,
          this.bakePart('forearm', (g) => drawForearm(g, a, d)),
        );
      }
      const leg = this.legs[k];
      if (!leg.thigh.art) {
        this.setSegArt(
          leg.thigh,
          this.bakePart('thigh', (g) => drawThigh(g, a, d)),
        );
        this.setSegArt(
          leg.shin,
          this.bakePart('shin', (g) => drawShin(g, a, d)),
        );
      }
      this.setSegArt(
        leg.foot,
        this.bakePart(`foot_${view}`, (g) => drawFoot(g, a, d, theta)),
      );
      // Mirror the near foot direction: feet point the way the body faces.
      leg.foot.holder.scale.x = 1;
    }
    for (const r of this.ropes) {
      r.layer = null;
      const anchor = this.ropeAnchor(r, theta);
      r.chain.reset(anchor.x, anchor.y);
    }
    this.headView = null;
  }

  private buildHead(view: RigView): void {
    const a = this.appearance;
    const d = this.dims;
    const theta = VIEW_YAW[view];
    for (const c of this.headBase.removeChildren()) c.destroy({ children: true });
    for (const c of this.headFront.removeChildren()) c.destroy({ children: true });
    this.headBase.addChild(this.bakePart(`headbase_${view}`, (g) => drawHeadBase(g, a, d, theta)));
    this.headFront.addChild(
      this.bakePart(`headfront_${view}`, (g) => drawHeadFront(g, a, d, theta)),
    );
    this.sigDirty = true;
  }

  private ropeTexture(id: string, draw: (g: Graphics) => void): Texture {
    const t = this.deps.cache.texture(
      `rig:${this.appearanceKey}:rope_${id}:${this.res}`,
      () => {
        const g = new Graphics();
        draw(g);
        return g;
      },
      { padding: 1, resolution: this.res },
    );
    return t ?? Texture.WHITE;
  }

  private addRope(
    id: string,
    draw: (g: Graphics) => void,
    thickness: number,
    anchor: { x: number; y: number; z: number },
    frame: 'upper' | 'head',
    length: number,
    rest: { x: number; y: number },
    stiffness: number,
  ): void {
    const segments = 5;
    const chain = new ClothChain(
      {
        segments,
        length,
        restDir: rest,
        stiffness,
        damping: 0.982,
        drag: 1.6,
        wind: 26,
        phase: this.rnd.range(0, 10),
      },
      0,
      0,
    );
    const pts = chain.points.map((p) => new PixiPoint(p.x, p.y));
    const mesh = new MeshRope({
      texture: this.ropeTexture(id, draw),
      points: pts,
      textureScale: 0,
      width: thickness,
    });
    mesh.label = `rope:${id}`;
    this.ropes.push({ chain, mesh, pts, anchor, frame, layer: null });
  }

  private buildRopes(): void {
    const a = this.appearance;
    const d = this.dims;
    const top = d.shoulderY;
    switch (a.drape) {
      case 'dupatta':
        for (const sx of [-1, 1]) {
          this.addRope(
            `dupatta${sx}`,
            (g) => drawClothStrip(g, a.drapeColor, mixColor(a.drapeColor, 0xffffff, 0.4), 15),
            15,
            { x: sx * (d.sw + 1), y: top + 10, z: 6 },
            'upper',
            d.hipY - top + 4,
            { x: sx * 0.08, y: 1 },
            7,
          );
        }
        break;
      case 'pallu':
        this.addRope(
          'pallu',
          (g) => drawClothStrip(g, a.drapeColor, a.lowerBorder, 24),
          24,
          { x: d.sw * 0.82, y: top + 2, z: -d.backDepth * 0.8 },
          'upper',
          112 * (d.H0 / 330),
          { x: 0.12, y: 1 },
          5,
        );
        break;
      case 'gamcha':
        this.addRope(
          'gamcha',
          (g) => drawClothStrip(g, a.drapeColor, mixColor(a.drapeColor, 0xffffff, 0.55), 16),
          16,
          { x: -d.sw * 0.65 + 9, y: top + 20, z: d.chestDepth * 0.9 },
          'upper',
          48,
          { x: 0, y: 1 },
          8,
        );
        break;
      default:
        break;
    }
    if (a.headwear === 'pagri')
      this.addRope(
        'pagri',
        (g) => drawClothStrip(g, a.headwearColor, mixColor(a.headwearColor, 0x000000, 0.25), 12),
        12,
        { x: 28, y: d.headCY - 6, z: -32 },
        'head',
        58,
        { x: 0.1, y: 1 },
        6,
      );
    if (a.hairStyle === 'braid')
      this.addRope(
        'braid',
        (g) => drawBraidStrip(g, a.hair, 15),
        15,
        { x: 24, y: d.headCY + 22, z: -22 },
        'head',
        104,
        { x: 0.12, y: 1 },
        9,
      );
  }

  private ropeAnchor(r: Rope, theta: number): { x: number; y: number; depth: number } {
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    let x = r.anchor.x * ct + r.anchor.z * st;
    let y = r.anchor.y;
    const depth = r.anchor.z * ct - r.anchor.x * st;
    if (r.frame === 'head') {
      const h = this.head;
      const lx = (x - h.pivot.x) * h.scale.x;
      const ly = y - h.pivot.y;
      const c = Math.cos(h.rotation);
      const s = Math.sin(h.rotation);
      x = h.x + lx * c - ly * s;
      y = h.y + lx * s + ly * c;
    }
    return { x, y, depth };
  }

  private updateRopes(
    dt: number,
    theta: number,
    vel: { x: number; y: number },
    acc: { x: number; y: number },
    ms: number,
  ): void {
    for (const r of this.ropes) {
      const a = this.ropeAnchor(r, theta);
      const layer: 'back' | 'front' = a.depth < -2 ? 'back' : 'front';
      if (r.layer !== layer) {
        r.layer = layer;
        (layer === 'back' ? this.clothBack : this.clothFront).addChild(r.mesh);
      }
      r.chain.update(dt, a, vel, acc, ms);
      r.chain.points.forEach((p, i) => {
        const q = r.pts[i];
        if (q) q.set(p.x, p.y);
      });
    }
  }

  private shoulderX(side: Side, theta: number): number {
    return side * this.dims.shoulderX * Math.cos(theta);
  }

  private hipX(side: Side, theta: number): number {
    return side * this.dims.hipJointX * Math.cos(theta);
  }

  private worldX(): number {
    const sc = Math.abs(this.view.scale.y) || 1;
    return this.view.x / sc + this.figure.x * Math.sign(this.view.scale.x || 1);
  }

  private drawShadow(): void {
    const g = this.shadow;
    const { dir, length, alpha, color } = this.shadowParams;
    g.clear();
    const w = this.dims.hw * 1.5;
    softShadow(g, 0, 0, w, 10, color, Math.min(0.5, alpha * 1.4));
    const len = 1 + length * 0.8;
    g.ellipse(dir * w * length * 0.5, 0, w * len, 7).fill({
      color,
      alpha: Math.min(0.25, alpha * 0.6),
    });
  }

  private attachLantern(): void {
    const lamp = new HandLantern(1.05, MELA.marigold);
    const tex = fxTexture(this.deps.cache, 'glow');
    const glow = new Sprite(tex);
    glow.anchor.set(0.5);
    glow.blendMode = 'add';
    glow.tint = 0xffb04a;
    glow.scale.set((50 * 2.4) / FX_RADIUS.glow);
    lamp.setGlow(glow);
    const hand: LimbSide = 'l';
    this.arms[hand].socket.addChild(lamp.view);
    lamp.view.position.set(0, -4);
    this.lantern = { lamp, swing: new Pendulum(40, 2.6), hand };
    applyPartial(this.armBase, lanternArm(hand));
  }
}

/** Arm posture that carries a lantern in `hand` (overrides the expression posture for that arm). */
export function lanternArm(hand: LimbSide): PartialPose {
  const a = { Abd: 0.32, Flex: 0.5, Twist: -0.2, Elbow: 1.0, Wrist: 0.1 };
  const out: PartialPose = {};
  for (const [k, v] of Object.entries(a)) out[`${hand}${k}` as keyof PartialPose] = v;
  return out;
}

/** Swap left/right arm channels of a partial pose. */
export function mirrorArms(p: PartialPose): PartialPose {
  const out: PartialPose = {};
  for (const [k, v] of Object.entries(p) as [keyof PartialPose, number][]) {
    const m = /^([lr])(Abd|Flex|Twist|Elbow|Wrist)$/.exec(k);
    if (m) out[`${m[1] === 'l' ? 'r' : 'l'}${m[2]}` as keyof PartialPose] = v;
    else out[k] = v;
  }
  return out;
}
