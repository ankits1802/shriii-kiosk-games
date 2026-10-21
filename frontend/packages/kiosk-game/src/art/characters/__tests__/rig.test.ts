/**
 * Character rig: kinematics and view projection, walk/run cycles, gesture library, facial life
 * (blinks, saccades, visemes), the expression state machine (incl. the Stall anger ladder), cloth
 * secondary motion and cloth colour variants.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { appearanceFor, CLOTH_COLOURWAYS, VILLAGERS, withCloth } from '../appearance.ts';
import { ANGER_LEVELS, EXPRESSION_LIST, EXPRESSIONS } from '../expressions.ts';
import { ClothChain, Pendulum } from '../rig/cloth.ts';
import { rigDims, torsoSection } from '../rig/dims.ts';
import { ExpressionMachine, transitionTime } from '../rig/expressionMachine.ts';
import {
  amplitudeOf,
  FaceController,
  SyntheticSpeech,
  trackAmplitude,
  type Viseme,
} from '../rig/face.ts';
import {
  GESTURE_NAMES,
  GESTURES,
  gestureKeys,
  gestureLocalTime,
  resolveChannel,
  sampleGesture,
} from '../rig/gestures.ts';
import {
  forearmDirection,
  fromBodyFrame,
  limbDirection,
  retargetArm,
  sectionExtent,
  segmentOf,
  solveArm,
  toBodyFrame,
  VIEW_YAW,
  viewForYaw,
  wrapX,
} from '../rig/kinematics.ts';
import { GAITS, gaitSpeed, legAt, locomotionPose } from '../rig/locomotion.ts';
import { createPose, POSE_KEYS, POSTURES, STAND } from '../rig/pose.ts';

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('kinematics', () => {
  it('a hanging limb points straight down in every view', () => {
    for (const view of ['front', 'three_quarter', 'side'] as const) {
      const s = segmentOf(limbDirection(1, 0, 0), VIEW_YAW[view]);
      expect(close(s.rotation, 0)).toBe(true);
      expect(close(s.scale, 1)).toBe(true);
    }
  });

  it('abduction reads in the front view and flexion in profile', () => {
    // Arm raised to the side: horizontal to screen-right in front, foreshortened in profile.
    const abd = limbDirection(1, Math.PI / 2, 0);
    expect(close(segmentOf(abd, 0).dx, 1)).toBe(true);
    expect(segmentOf(abd, VIEW_YAW.side).scale).toBeLessThan(0.01);
    // Arm swung forward: foreshortened in front, horizontal in profile (towards the facing direction).
    const flex = limbDirection(1, 0, Math.PI / 2);
    expect(segmentOf(flex, 0).scale).toBeLessThan(0.01);
    expect(close(segmentOf(flex, VIEW_YAW.side).dx, 1)).toBe(true);
  });

  it('far limbs have negative depth when turned', () => {
    const theta = VIEW_YAW.side;
    // Side +1 (screen-right in front) goes behind when the figure faces right.
    expect(segmentOf(limbDirection(1, 0.6, 0), theta).depth).toBeLessThan(0);
    expect(segmentOf(limbDirection(-1, 0.6, 0), theta).depth).toBeGreaterThan(0);
  });

  it('body-frame transforms are inverse of each other', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(-1 as const, 1 as const),
        fc.double({ min: -1, max: 3, noNaN: true }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (side, abd, flex, x, y) => {
          const v = { x, y, z: 0.3 };
          const back = fromBodyFrame(side, abd, flex, toBodyFrame(side, abd, flex, v));
          return close(back.x, v.x, 1e-9) && close(back.y, v.y, 1e-9) && close(back.z, v.z, 1e-9);
        },
      ),
    );
  });

  it('the forearm bend plane rotates with twist (up for a raised arm, medial for a hanging arm)', () => {
    const raised = forearmDirection(1, {
      abd: Math.PI / 2,
      flex: 0,
      twist: Math.PI / 2,
      elbow: Math.PI / 2,
      wrist: 0,
    });
    expect(raised.y).toBeLessThan(-0.99); // forearm points up
    const hanging = forearmDirection(1, {
      abd: 0,
      flex: 0,
      twist: -Math.PI / 2,
      elbow: Math.PI / 2,
      wrist: 0,
    });
    expect(hanging.x).toBeLessThan(-0.99); // forearm points to the body centre
  });

  it('retargeted arms look the same on screen in any view', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 2.6, noNaN: true }),
        fc.double({ min: -0.2, max: 0.6, noNaN: true }),
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: 0.05, max: 2.2, noNaN: true }),
        fc.constantFrom(VIEW_YAW.three_quarter, VIEW_YAW.side),
        (abd, flex, twist, elbow, theta) => {
          const src = { abd, flex, twist, elbow, wrist: 0 };
          const front = solveArm(1, src, 0, 50, 45);
          const rt = retargetArm(src, -1, theta);
          const turned = solveArm(-1, rt, theta, 50, 45);
          const ang = (dx: number, dy: number): number => Math.atan2(dx, dy);
          const d = (a: number, b: number): number =>
            Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
          return (
            d(ang(front.upper.dx, front.upper.dy), ang(turned.upper.dx, turned.upper.dy)) < 0.02 &&
            d(ang(front.fore.dx, front.fore.dy), ang(turned.fore.dx, turned.fore.dy)) < 0.02
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('wrap projection slides features round the surface and clamps hidden ones to the edge', () => {
    expect(wrapX(0, 40, 30, 0)).toEqual({ x: 0, facing: 1 });
    expect(close(wrapX(0, 40, 30, Math.PI / 2).x, 30)).toBe(true);
    // A feature on the far side clamps to the silhouette edge (never shows through).
    const hidden = wrapX(30, 40, 30, Math.PI / 2);
    expect(hidden.facing).toBeLessThan(0);
    expect(close(hidden.x, 30, 1e-6)).toBe(true);
    const e = sectionExtent(40, 30, 20, Math.PI / 2);
    expect(close(e.right, 30)).toBe(true);
    expect(close(e.left, -20)).toBe(true);
  });

  it('maps yaw to the nearest discrete view', () => {
    expect(viewForYaw(0.1)).toBe('front');
    expect(viewForYaw(-0.7)).toBe('three_quarter');
    expect(viewForYaw(1.4)).toBe('side');
  });
});

describe('proportions', () => {
  it('keep the wave-1 framing (feet at 0, head centre near -263 for height 1)', () => {
    const d = rigDims(appearanceFor('customer', 3));
    expect(d.headCY).toBeLessThan(-240);
    expect(d.headCY).toBeGreaterThan(-300);
    expect(d.thigh + d.shin).toBeCloseTo(d.ankleY - d.hipJointY, 6);
    const s = torsoSection(d, d.shoulderY + 30);
    expect(s.w).toBeGreaterThan(s.df);
  });
});

describe('locomotion', () => {
  it('phase 0 is the left contact pose and 0.25 the passing pose', () => {
    const g = GAITS.walk;
    const left = legAt(0, g);
    const right = legAt(0.5, g);
    expect(left.hip).toBeGreaterThan(0.3); // heel strikes in front
    expect(right.hip).toBeLessThan(-0.3); // trailing leg
    const support = legAt(0.25, g);
    const swing = legAt(0.75, g);
    expect(Math.abs(support.hip)).toBeLessThan(0.1); // straight support leg under the body
    expect(swing.knee).toBeGreaterThan(support.knee + 0.4); // swing leg bends past it
  });

  it('arms swing opposite to their leg and both legs mirror half a cycle apart', () => {
    for (const phase of [0, 0.1, 0.3, 0.6, 0.85]) {
      const p = locomotionPose(createPose(), phase, 'walk');
      if (Math.abs(p.lHip) > 0.05) expect(Math.sign(p.lFlex)).toBe(-Math.sign(p.lHip));
      const q = locomotionPose(createPose(), phase + 0.5, 'walk');
      expect(q.rHip).toBeCloseTo(p.lHip, 6);
      expect(q.rKnee).toBeCloseTo(p.lKnee, 6);
    }
  });

  it('runs faster than it walks and leaves the ground', () => {
    const d = rigDims(appearanceFor('customer', 3));
    const walk = gaitSpeed('walk', d.thigh, d.shin);
    const run = gaitSpeed('run', d.thigh, d.shin);
    expect(walk).toBeGreaterThan(80);
    expect(run).toBeGreaterThan(walk * 1.8);
    const airborne = [0, 0.1, 0.2, 0.3, 0.4].some(
      (ph) => locomotionPose(createPose(), ph, 'run').rootY < -1,
    );
    expect(airborne).toBe(true);
  });
});

describe('gesture library', () => {
  it('covers every gesture the brief asks for', () => {
    for (const name of [
      'wave',
      'point',
      'beckon',
      'hand_over',
      'receive',
      'place_on_scale',
      'shrug',
      'fold_arms',
      'foot_tap',
      'clap',
      'namaste',
      'carry_on_head',
      'push_cart',
      'steer_cart',
      'hold_lantern',
    ] as const)
      expect(GESTURES[name]).toBeDefined();
    expect(new Set(GESTURE_NAMES).size).toBe(GESTURE_NAMES.length);
  });

  it('keys are ordered, inside the duration, and hold windows are valid', () => {
    for (const name of GESTURE_NAMES) {
      const def = GESTURES[name];
      let prev = 0;
      for (const k of def.keys) {
        expect(k.t, name).toBeGreaterThanOrEqual(prev);
        expect(k.t, name).toBeLessThanOrEqual(def.duration + 1e-9);
        prev = k.t;
      }
      if (def.loop) {
        expect(def.loop.from).toBeLessThan(def.loop.to);
        expect(def.loop.to).toBeLessThanOrEqual(def.duration);
      }
      for (const e of def.events ?? []) expect(e.t).toBeLessThanOrEqual(def.duration);
    }
  });

  it('starts from the base pose (no pop) and returns to it after the blend-out', () => {
    for (const name of GESTURE_NAMES) {
      const def = GESTURES[name];
      const base = createPose(STAND);
      const at0 = createPose(base);
      sampleGesture(def, 0, 'r', base, at0);
      for (const k of POSE_KEYS) expect(at0[k], `${name}.${k}`).toBeCloseTo(base[k], 6);
      const end = createPose(base);
      const s = def.loop
        ? sampleGesture(def, def.loop.to, 'r', base, end, def.blendOut + 0.01)
        : sampleGesture(def, def.duration + def.blendOut + 0.01, 'r', base, end);
      expect(s.done, name).toBe(true);
      for (const k of POSE_KEYS) expect(end[k], `${name}.${k}`).toBeCloseTo(base[k], 6);
    }
  });

  it('maps main/off limbs to sides', () => {
    expect(resolveChannel('mAbd', 'r')).toBe('rAbd');
    expect(resolveChannel('oElbow', 'r')).toBe('lElbow');
    expect(resolveChannel('mHip', 'l')).toBe('lHip');
    expect(resolveChannel('headNod', 'l')).toBe('headNod');
    expect(gestureKeys(GESTURES.wave, 'l').has('lAbd')).toBe(true);
  });

  it('hold gestures loop until released', () => {
    const def = GESTURES.fold_arms;
    expect(gestureLocalTime(def, 50, true)).toBeLessThanOrEqual(def.loop?.to ?? 0);
    expect(gestureLocalTime(def, 50, true)).toBeGreaterThanOrEqual(def.loop?.from ?? 0);
    const out = createPose();
    const held = sampleGesture(def, gestureLocalTime(def, 50, true), 'r', STAND, out);
    expect(held.done).toBe(false);
    expect(held.weight).toBe(1);
  });

  it('a wave raises the hand above the shoulder and a namaste joins the hands at the chest', () => {
    const p = createPose(STAND);
    sampleGesture(GESTURES.wave, 0.62, 'r', STAND, p);
    const wave = solveArm(
      1,
      { abd: p.rAbd, flex: p.rFlex, twist: p.rTwist, elbow: p.rElbow, wrist: 0 },
      0,
      50,
      45,
    );
    expect(wave.wrist.y).toBeLessThan(-30);
    const n = createPose(STAND);
    sampleGesture(GESTURES.namaste, 1.0, 'r', STAND, n);
    const r = solveArm(
      1,
      { abd: n.rAbd, flex: n.rFlex, twist: n.rTwist, elbow: n.rElbow, wrist: 0 },
      0,
      50,
      45,
    );
    const l = solveArm(
      -1,
      { abd: n.lAbd, flex: n.lFlex, twist: n.lTwist, elbow: n.lElbow, wrist: 0 },
      0,
      50,
      45,
    );
    const shoulder = 33;
    expect(Math.abs(shoulder + r.wrist.x - (-shoulder + l.wrist.x))).toBeLessThan(8);
  });
});

describe('facial life', () => {
  it('blinks at randomised, human-like intervals with occasional double blinks', () => {
    const f = new FaceController(42);
    const starts: number[] = [];
    let prevBlink = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 600; i++) {
      const s = f.update(dt);
      if (s.blink > 0 && prevBlink === 0) starts.push(i * dt);
      prevBlink = s.blink;
    }
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(2.2);
    expect(mean).toBeLessThan(5);
    expect(Math.min(...gaps)).toBeGreaterThan(0.25);
    expect(gaps.filter((g) => g < 0.6).length).toBeGreaterThan(3); // double blinks
    expect(new Set(gaps.map((g) => g.toFixed(1))).size).toBeGreaterThan(10); // not periodic
  });

  it('is deterministic per seed and differs across seeds', () => {
    const run = (seed: number): number[] => {
      const f = new FaceController(seed);
      const out: number[] = [];
      for (let i = 0; i < 1200; i++) out.push(f.update(1 / 60).blink);
      return out;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('makes saccades and holds a look-at target', () => {
    const f = new FaceController(3);
    const xs = new Set<string>();
    for (let i = 0; i < 600; i++) xs.add(f.update(1 / 60).gazeX.toFixed(2));
    expect(xs.size).toBeGreaterThan(5);
    f.setLook({ x: 0.8, y: -0.4 });
    let s = f.update(0);
    for (let i = 0; i < 120; i++) s = f.update(1 / 60);
    expect(Math.abs(s.gazeX - 0.8)).toBeLessThan(0.1);
    expect(Math.abs(s.gazeY + 0.4)).toBeLessThan(0.1);
  });

  it('lip-flaps from the voice amplitude: rest in silence, open when loud, closed lips on sharp drops', () => {
    const f = new FaceController(5);
    let amp = 0;
    f.setTalking(true, () => amp);
    let s = f.update(1 / 60);
    for (let i = 0; i < 30; i++) s = f.update(1 / 60);
    expect(s.viseme).toBe('rest');
    expect(s.mouthOpen).toBeLessThan(0.02);
    amp = 1;
    let maxOpen = 0;
    for (let i = 0; i < 30; i++) maxOpen = Math.max(maxOpen, f.update(1 / 60).mouthOpen);
    expect(maxOpen).toBeGreaterThan(0.4);
    amp = 0.05;
    const seen = new Set<Viseme>();
    for (let i = 0; i < 6; i++) seen.add(f.update(1 / 60).viseme);
    expect(seen.has('mbp')).toBe(true);
    f.setTalking(false);
    for (let i = 0; i < 60; i++) s = f.update(1 / 60);
    expect(s.mouthOpen).toBeLessThan(0.02);
  });

  it('a synthetic speech envelope produces varied visemes when no amplitude is available', () => {
    const f = new FaceController(9);
    f.setTalking(true);
    const seen = new Set<Viseme>();
    for (let i = 0; i < 600; i++) seen.add(f.update(1 / 60).viseme);
    expect(seen.size).toBeGreaterThanOrEqual(4);
    const sp = new SyntheticSpeech(1);
    const vals = Array.from({ length: 300 }, () => sp.next(1 / 60));
    expect(Math.max(...vals)).toBeGreaterThan(0.3);
    expect(Math.min(...vals)).toBeLessThan(0.05);
  });

  it('reads amplitude from timing tracks and duck-typed playbacks', () => {
    let now = 0;
    const amp = trackAmplitude(
      [
        [0, 0],
        [100, 1],
        [200, 0],
      ],
      () => now,
    );
    now = 50;
    expect(amp()).toBeCloseTo(0.5, 6);
    now = 150;
    expect(amp()).toBeCloseTo(0.5, 6);
    now = 500;
    expect(amp()).toBe(0);
    expect(amplitudeOf({ level: () => 2 })?.()).toBe(1);
    expect(amplitudeOf({ amplitude: () => 0.25 })?.()).toBe(0.25);
    expect(amplitudeOf({})).toBeUndefined();
  });
});

describe('expression state machine', () => {
  it('crossfades from the previous face to the target over the edge time', () => {
    const m = new ExpressionMachine('neutral');
    m.set('happy');
    const f0 = m.update(0);
    expect(f0.params.smile).toBeCloseTo(EXPRESSIONS.neutral.params.smile, 6);
    expect(f0.changed).toBe(true);
    const dur = transitionTime('neutral', 'happy');
    m.update(dur / 2);
    const mid = m.update(0);
    expect(mid.params.smile).toBeGreaterThan(EXPRESSIONS.neutral.params.smile);
    expect(mid.params.smile).toBeLessThan(EXPRESSIONS.happy.params.smile);
    const end = m.update(dur);
    expect(end.params).toEqual(EXPRESSIONS.happy.params);
    expect(end.symbol).toBe('sparkle');
    expect(end.changed).toBe(false);
  });

  it('reacts fast, escalates briskly and calms down slowly', () => {
    expect(transitionTime('calm', 'surprised')).toBeLessThan(0.15);
    expect(transitionTime('angry', 'calm', 3, 1)).toBeGreaterThan(
      transitionTime('calm', 'angry', 1, 3),
    );
    expect(transitionTime('happy', 'happy')).toBe(0);
  });

  it('a flash returns to the base expression after its hold', () => {
    const m = new ExpressionMachine('calm');
    m.flash('surprised', 0.5);
    m.update(0.2);
    expect(m.update(0).expression).toBe('surprised');
    m.update(0.4);
    expect(m.expression).toBe('calm');
    const f = m.update(2);
    expect(f.params).toEqual(EXPRESSIONS.calm.params);
  });

  it('posture and symbol switch at the crossfade midpoint', () => {
    const m = new ExpressionMachine('calm');
    m.set('annoyed');
    const early = m.update(0.01);
    expect(early.posture).toBe('relaxed');
    const late = m.update(1);
    expect(late.posture).toBe('crossed');
    expect(late.symbol).toBe('vein');
  });

  it('the Stall anger ladder escalates monotonically with non-colour cues', () => {
    const frames = ([0, 1, 2, 3] as const).map((lvl) => {
      const m = new ExpressionMachine('neutral');
      m.setAnger(lvl);
      m.settle();
      return m.update(0);
    });
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (!a || !b) continue;
      expect(b.params.browAngle).toBeGreaterThanOrEqual(a.params.browAngle);
      expect(b.params.smile).toBeLessThanOrEqual(a.params.smile);
      expect(b.symbol).not.toBe('none');
      expect(b.posture).not.toBe('relaxed');
    }
    expect(frames[3]?.expression).toBe('angry');
    expect(frames[3]?.symbol).toBe('steam');
    expect(ANGER_LEVELS.map((l) => l.expression)).toEqual([
      'calm',
      'impatient',
      'annoyed',
      'angry',
    ]);
  });

  it('every expression (incl. delighted) has a posture defined in the rig', () => {
    expect(EXPRESSION_LIST).toContain('delighted');
    for (const e of EXPRESSION_LIST) expect(POSTURES[EXPRESSIONS[e].arms]).toBeDefined();
    expect(EXPRESSIONS.delighted.params.eyeSmile).toBe(1);
  });
});

describe('secondary motion', () => {
  it('cloth settles into its drape under a still anchor and stays finite under long frames', () => {
    const c = new ClothChain({ segments: 5, length: 100, restDir: { x: 0.1, y: 1 } }, 0, 0);
    for (let i = 0; i < 400; i++) c.update(1 / 60, { x: 0, y: 0 });
    const tip = c.points[c.points.length - 1];
    expect(tip?.y).toBeGreaterThan(80);
    c.update(5, { x: 300, y: -200 });
    for (const p of c.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('trails behind when the figure walks and lags when it accelerates', () => {
    const c = new ClothChain({ segments: 5, length: 100 }, 0, 0);
    for (let i = 0; i < 300; i++) c.update(1 / 60, { x: 0, y: 0 }, { x: 200, y: 0 });
    expect(c.points[c.points.length - 1]?.x).toBeLessThan(-5);
    const p = new Pendulum(10);
    p.update(0.05, 3000);
    expect(p.angle).toBeLessThan(0);
    for (let i = 0; i < 400; i++) p.update(1 / 60, 0);
    expect(Math.abs(p.angle)).toBeLessThan(0.01);
  });
});

describe('cloth colour variants', () => {
  it('recolour clothes deterministically without touching the body', () => {
    const base = VILLAGERS[0];
    if (!base) throw new Error('missing villager');
    expect(withCloth(base, 0)).toBe(base);
    const v = withCloth(base, 3);
    expect(v).toEqual(withCloth(base, 3));
    expect(v.skin).toBe(base.skin);
    expect(v.hair).toBe(base.hair);
    expect(v.lower).toBe(base.lower);
    expect(v.upperColor).not.toBe(base.upperColor);
    expect(withCloth(base, 1 + CLOTH_COLOURWAYS.length)).toEqual(withCloth(base, 1));
  });
});
