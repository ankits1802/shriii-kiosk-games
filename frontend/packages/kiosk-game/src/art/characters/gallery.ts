/**
 * Dev gallery routes for the character rig (visual QA and Playwright screenshots):
 *
 * - `/rig/views/<page>`              every villager in front, three-quarter and side views
 * - `/rig/walk`                      walk and run cycle key poses (contact, down, passing, up) + live loops
 * - `/rig/gestures/<view>`           every gesture frozen at its key moment (front | three_quarter | side)
 * - `/rig/gestures-live/<view>`      every gesture looping
 * - `/rig/gesture/<name>`            one gesture, large, in front and side views
 * - `/rig/expressions/<variant>`     expressions, the Stall anger ladder 0-3 and visemes (close-ups)
 * - `/rig/life`                      blinks, saccades, look-at, lip-sync and idle variations
 * - `/rig/cloth`                     cloth colour variants
 * - `/rig/props`                     props: goods, baskets, sacks, coins, scale, carts, lantern, fuel can
 * - `/rig/scene`                     a busy market moment with 12 characters (records rig CPU time)
 *
 * Developer labels are drawn on these QA pages only; player screens never carry text.
 */
import { type Application, Container, Graphics, Text, Ticker } from 'pixi.js';
import type { CharacterRole } from '../../core/contracts.ts';
import type { MelaArtKit } from '../ArtKit.ts';
import { type GalleryRoute, galleryKit, type RouteDef, registerRoutes } from '../gallery/routes.ts';
import { MELA } from '../palettes.ts';
import {
  BrassScale,
  BullockCart,
  balanceForWeights,
  createBasket,
  createCoinPile,
  createCoinRow,
  createCoinStack,
  createFuelCan,
  createGoodsPile,
  createSack,
  GOODS_KINDS,
  HandCart,
  HandLantern,
} from '../props/index.ts';
import { VILLAGERS } from './appearance.ts';
import { EXPRESSION_LIST } from './expressions.ts';
import { ProceduralCharacter, type RigCharacterSpec } from './ProceduralCharacter.ts';
import { GESTURE_NAMES, type GestureName } from './rig/gestures.ts';
import { RIG_VIEWS, type RigView } from './rig/kinematics.ts';

/** Key moment (s) of each gesture for frozen sheets. */
export const GESTURE_KEY_TIME: Readonly<Record<GestureName, number>> = {
  wave: 0.62,
  point: 0.8,
  beckon: 0.52,
  hand_over: 0.85,
  receive: 0.62,
  place_on_scale: 0.82,
  shrug: 0.5,
  fold_arms: 1.0,
  foot_tap: 0.4,
  clap: 0.45,
  namaste: 1.0,
  carry_on_head: 1.0,
  push_cart: 0.9,
  steer_cart: 1.2,
  hold_lantern: 1.0,
  nod: 0.16,
  celebrate: 0.42,
  head_shake: 0.15,
};

function label(text: string, size = 15): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: 'system-ui, sans-serif',
      fontSize: size,
      fill: 0xfff4de,
      fontWeight: '600',
      dropShadow: { color: 0x1b1838, blur: 3, distance: 1, alpha: 0.9, angle: Math.PI / 2 },
    },
  });
  t.anchor.set(0.5, 0);
  return t;
}

interface Grid {
  readonly cellW: number;
  readonly cellH: number;
  at(i: number): { x: number; y: number };
}

function grid(app: Application, cols: number, rows: number, top = 0.06, bottom = 0.98): Grid {
  const w = app.screen.width;
  const h = app.screen.height;
  const cellW = w / cols;
  const cellH = ((bottom - top) * h) / rows;
  return {
    cellW,
    cellH,
    at: (i) => ({ x: cellW * ((i % cols) + 0.5), y: h * top + cellH * (Math.floor(i / cols) + 1) }),
  };
}

function backdrop(
  kit: MelaArtKit,
  app: Application,
  scene: Parameters<MelaArtKit['createBackdrop']>[0],
  dim = 0.3,
): void {
  const b = kit.createBackdrop(scene, 'golden_hour');
  app.stage.addChild(b.view);
  const d = new Graphics()
    .rect(0, 0, app.screen.width, app.screen.height)
    .fill({ color: MELA.indigoDeep, alpha: dim });
  app.stage.addChild(d);
}

function make(kit: MelaArtKit, spec: RigCharacterSpec): ProceduralCharacter {
  return kit.createCharacter(
    spec as Parameters<MelaArtKit['createCharacter']>[0],
  ) as ProceduralCharacter;
}

const ROLES: readonly { role: CharacterRole; variant: number }[] = [
  { role: 'guide', variant: 0 },
  ...VILLAGERS.map((_, i) => ({ role: 'customer' as const, variant: i })),
];

function propFor(name: GestureName): (() => Container) | null {
  switch (name) {
    case 'hand_over':
    case 'receive':
      return () => createCoinStack(4, 1.4);
    case 'place_on_scale':
      return () => createGoodsPile('onion', 3, 0.9);
    case 'carry_on_head':
      return () => createBasket({ contents: 'mango', count: 7, width: 66 });
    case 'hold_lantern':
      return () => new HandLantern(1).view;
    default:
      return null;
  }
}

function attachProp(c: ProceduralCharacter, name: GestureName, view: RigView): void {
  const p = propFor(name);
  if (!p) return;
  if (name === 'carry_on_head') c.hold(p(), 'head');
  else c.hold(p(), view === 'side' ? 'l' : 'r');
}

const DEFS: RouteDef[] = [
  {
    pattern: /^\/rig\/views\/(\d+)$/,
    mount(app, [pageStr]) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'market_square', 0.25);
      const page = Number(pageStr ?? 0);
      const people = ROLES.slice(page * 6, page * 6 + 6);
      const g = grid(app, people.length, 3, 0.04, 0.99);
      const chars: ProceduralCharacter[] = [];
      RIG_VIEWS.forEach((view, row) => {
        people.forEach((r, col) => {
          const c = make(kit, {
            id: `v${page}-${col}-${row}`,
            role: r.role,
            variant: r.variant,
            view,
            scale: Math.min(g.cellH / 350, g.cellW / 170) / kit.unit,
          });
          const pos = g.at(row * people.length + col);
          c.view.position.set(pos.x, pos.y - 6);
          c.setBlinking(false);
          app.stage.addChild(c.view);
          chars.push(c);
        });
        const t = label(view, 13);
        t.position.set(44, app.screen.height * 0.04 + g.cellH * row + 8);
        app.stage.addChild(t);
      });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/walk$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'road_home', 0.3);
      const chars: ProceduralCharacter[] = [];
      const phases = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
      const names = ['contact', 'down', 'passing', 'up', 'contact', 'down', 'passing', 'up'];
      const g = grid(app, 8, 3, 0.05, 0.99);
      const scale = Math.min(g.cellH / 330, g.cellW / 150) / kit.unit;
      (['walk', 'run'] as const).forEach((gait, row) => {
        phases.forEach((ph, i) => {
          const c = make(kit, {
            id: `w${row}${i}`,
            role: 'customer',
            variant: row === 0 ? 1 : 3,
            scale,
            view: 'side',
          });
          c.setBlinking(false);
          c.showGaitFrame(gait, ph);
          const pos = g.at(row * 8 + i);
          c.view.position.set(pos.x, pos.y - 8);
          app.stage.addChild(c.view);
          chars.push(c);
          const t = label(`${gait} · ${names[i]}`, 12);
          t.position.set(pos.x, pos.y - g.cellH + 2);
          app.stage.addChild(t);
        });
      });
      // Live loops: walk side, walk 3/4, run side, saree walk.
      const live: [number, RigView, 'walk' | 'run'][] = [
        [0, 'side', 'walk'],
        [4, 'three_quarter', 'walk'],
        [5, 'side', 'walk'],
        [9, 'side', 'walk'],
        [3, 'side', 'run'],
        [7, 'three_quarter', 'run'],
      ];
      live.forEach(([variant, view, gait], i) => {
        const c = make(kit, { id: `live${i}`, role: 'customer', variant, scale, view });
        c.setView(view, true);
        c.setLocomotion(gait);
        c.setView(view, true);
        const x = (app.screen.width / (live.length + 1)) * (i + 1);
        c.view.position.set(x, app.screen.height * 0.98);
        app.stage.addChild(c.view);
        chars.push(c);
      });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/gestures(-live)?\/(front|three_quarter|side)$/,
    mount(app, [live, viewStr]) {
      const view = (viewStr ?? 'front') as RigView;
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'hub', 0.3);
      const cols = app.screen.width > app.screen.height ? 6 : 3;
      const rows = Math.ceil(GESTURE_NAMES.length / cols);
      const g = grid(app, cols, rows, 0.02, 0.99);
      const chars: ProceduralCharacter[] = [];
      const timers: ReturnType<typeof setInterval>[] = [];
      GESTURE_NAMES.forEach((name, i) => {
        const c = make(kit, {
          id: `gs${i}`,
          role: 'customer',
          variant: [0, 1, 4, 3, 5, 8][i % 6] ?? 0,
          view,
          scale: Math.min(g.cellH / 360, g.cellW / 180) / kit.unit,
        });
        c.setBlinking(false);
        c.setIdleLife(false);
        attachProp(c, name, view);
        const pos = g.at(i);
        c.view.position.set(pos.x, name === 'steer_cart' ? pos.y - g.cellH * 0.32 : pos.y - 6);
        app.stage.addChild(c.view);
        chars.push(c);
        if (live) {
          const run = (): void => {
            void c.play(name).then(() => {
              if (
                name === 'fold_arms' ||
                name === 'carry_on_head' ||
                name === 'push_cart' ||
                name === 'steer_cart' ||
                name === 'hold_lantern' ||
                name === 'foot_tap'
              )
                setTimeout(() => void c.stopGesture(), 1800);
            });
          };
          run();
          timers.push(setInterval(run, 3600));
        } else {
          c.showGestureFrame(name, GESTURE_KEY_TIME[name]);
        }
        const t = label(name.replace(/_/g, ' '), 13);
        t.position.set(pos.x, pos.y - g.cellH + 2);
        app.stage.addChild(t);
      });
      return () => {
        for (const t of timers) clearInterval(t);
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/gesture\/([a-z_]+)$/,
    mount(app, [nameStr]) {
      const name = (
        GESTURE_NAMES.includes(nameStr as GestureName) ? nameStr : 'wave'
      ) as GestureName;
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'market_square', 0.2);
      const chars = RIG_VIEWS.map((view, i) => {
        const c = make(kit, {
          id: `one${i}`,
          role: i === 1 ? 'guide' : 'customer',
          variant: 4,
          view,
          scale: (app.screen.height * 0.8) / 340 / kit.unit,
        });
        c.setBlinking(false);
        if (i !== 1) attachProp(c, name, view);
        c.view.position.set(
          app.screen.width * (0.2 + i * 0.3),
          app.screen.height * (name === 'steer_cart' ? 0.7 : 0.97),
        );
        app.stage.addChild(c.view);
        return c;
      });
      let alive = true;
      void (async () => {
        while (alive) {
          await Promise.all(chars.map((c) => c.play(name)));
          await new Promise((r) => setTimeout(r, 1600));
          await Promise.all(chars.map((c) => c.stopGesture()));
          await new Promise((r) => setTimeout(r, 700));
        }
      })();
      return () => {
        alive = false;
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/expressions\/(\d+)$/,
    mount(app, [variantStr]) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'stall_front', 0.35);
      const variant = Number(variantStr ?? 0);
      type Item = { title: string; setup: (c: ProceduralCharacter) => void; view?: RigView };
      const items: Item[] = [
        ...EXPRESSION_LIST.map((e) => ({
          title: e,
          setup: (c: ProceduralCharacter) => c.setExpression(e),
        })),
        ...([0, 1, 2, 3] as const).map((lvl) => ({
          title: `stall anger ${lvl}`,
          view: 'three_quarter' as RigView,
          setup: (c: ProceduralCharacter) => c.setAngerLevel(lvl),
        })),
        ...EXPRESSION_LIST.slice(1, 7).map((e) => ({
          title: `${e} · 3/4`,
          view: 'three_quarter' as RigView,
          setup: (c: ProceduralCharacter) => c.setExpression(e),
        })),
      ];
      const cols = app.screen.width > app.screen.height ? 10 : 5;
      const rows = Math.ceil(items.length / cols);
      const g = grid(app, cols, rows, 0.01, 0.99);
      const chars = items.map((it, i) => {
        const c = make(kit, {
          id: `ex${i}`,
          role: 'customer',
          variant,
          view: it.view ?? 'front',
          scale: Math.min(g.cellH / 175, g.cellW / 120) / kit.unit,
        });
        c.setBlinking(false);
        c.setIdleLife(false);
        it.setup(c);
        const sc = Math.min(g.cellH / 175, g.cellW / 120);
        const pos = g.at(i);
        const cell = new Container();
        const mask = new Graphics()
          .rect(pos.x - g.cellW / 2 + 3, pos.y - g.cellH + 3, g.cellW - 6, g.cellH - 6)
          .fill(0xffffff);
        const frame = new Graphics()
          .roundRect(pos.x - g.cellW / 2 + 3, pos.y - g.cellH + 3, g.cellW - 6, g.cellH - 6, 8)
          .fill({ color: MELA.cream, alpha: 0.18 });
        c.view.position.set(pos.x, pos.y - g.cellH / 2 + 262 * sc);
        cell.addChild(frame, c.view);
        c.view.mask = mask;
        cell.addChild(mask);
        app.stage.addChild(cell);
        const t = label(it.title, 12);
        t.position.set(pos.x, pos.y - 22);
        app.stage.addChild(t);
        return c;
      });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/visemes$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'stall_front', 0.35);
      const levels = [0, 0.05, 0.2, 0.45, 0.7, 1];
      const g = grid(app, 6, 2, 0.02, 0.98);
      const chars: ProceduralCharacter[] = [];
      for (let row = 0; row < 2; row++)
        levels.forEach((amp, i) => {
          const c = make(kit, {
            id: `vs${row}${i}`,
            role: row === 0 ? 'guide' : 'customer',
            variant: 2,
            view: row === 0 ? 'front' : 'three_quarter',
            scale: Math.min(g.cellH / 175, g.cellW / 120) / kit.unit,
          });
          c.setBlinking(false);
          c.setIdleLife(false);
          void c.speakFor(600000, () => amp);
          const pos = g.at(row * 6 + i);
          c.view.position.set(
            pos.x,
            pos.y - g.cellH / 2 + 262 * Math.min(g.cellH / 175, g.cellW / 120),
          );
          const mask = new Graphics()
            .rect(pos.x - g.cellW / 2 + 3, pos.y - g.cellH + 3, g.cellW - 6, g.cellH - 6)
            .fill(0xffffff);
          c.view.mask = mask;
          app.stage.addChild(c.view, mask);
          chars.push(c);
          const t = label(`amplitude ${amp}`, 12);
          t.position.set(pos.x, pos.y - 22);
          app.stage.addChild(t);
        });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/life$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'market_square', 0.15);
      const w = app.screen.width;
      const h = app.screen.height;
      const scale = (h * 0.55) / 330 / kit.unit;
      const specs: RigCharacterSpec[] = [
        { id: 'life0', role: 'guide', scale },
        { id: 'life1', role: 'customer', variant: 0, scale, view: 'three_quarter' },
        { id: 'life2', role: 'customer', variant: 6, scale },
        { id: 'life3', role: 'customer', variant: 9, scale, view: 'three_quarter', facing: 'left' },
      ];
      const chars = specs.map((s, i) => {
        const c = make(kit, s);
        c.view.position.set(w * (0.15 + i * 0.235), h * 0.97);
        app.stage.addChild(c.view);
        return c;
      });
      const dot = new Graphics()
        .circle(0, 0, 14)
        .fill(MELA.marigold)
        .stroke({ width: 3, color: MELA.ink });
      app.stage.addChild(dot);
      let t = 0;
      const tick = (tk: Ticker): void => {
        t += tk.deltaMS / 1000;
        dot.position.set(
          w * (0.5 + 0.42 * Math.sin(t * 0.5)),
          h * (0.22 + 0.1 * Math.sin(t * 0.9)),
        );
        chars[0]?.lookAt(dot.position);
        chars[2]?.lookAt(dot.position);
      };
      app.ticker.add(tick);
      let alive = true;
      void (async () => {
        while (alive) {
          await chars[1]?.speakFor(2600);
          chars[3]?.react('surprised', 0.8);
          await new Promise((r) => setTimeout(r, 900));
          await chars[3]?.speakFor(2000);
          await new Promise((r) => setTimeout(r, 1200));
        }
      })();
      return () => {
        alive = false;
        app.ticker.remove(tick);
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/cloth$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'market_square', 0.3);
      const g = grid(app, 9, 2, 0.03, 0.99);
      const chars: ProceduralCharacter[] = [];
      [0, 1].forEach((row) => {
        for (let cloth = 0; cloth < 9; cloth++) {
          const c = make(kit, {
            id: `cl${row}${cloth}`,
            role: 'customer',
            variant: row === 0 ? 0 : 1,
            cloth,
            view: cloth % 2 === 0 ? 'front' : 'three_quarter',
            scale: Math.min(g.cellH / 350, g.cellW / 160) / kit.unit,
          });
          const pos = g.at(row * 9 + cloth);
          c.view.position.set(pos.x, pos.y - 6);
          app.stage.addChild(c.view);
          chars.push(c);
        }
      });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/props$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'weighing_post', 0.35);
      const w = app.screen.width;
      const h = app.screen.height;
      const u = (h / 1080) * 1.25;
      const root = new Container();
      root.scale.set(u);
      app.stage.addChild(root);
      const W = w / u;
      const H = h / u;
      const place = (c: Container, x: number, y: number, name: string): void => {
        c.position.set(x, y);
        root.addChild(c);
        const t = label(name, 12);
        t.position.set(x, y + 6);
        root.addChild(t);
      };
      // Goods row.
      GOODS_KINDS.forEach((kind, i) => {
        place(
          createGoodsPile(
            kind,
            kind === 'rice_sack' ? 3 : kind === 'clay_pot' ? 3 : 6,
            kind === 'coin' ? 1.4 : 1,
          ),
          W * (0.08 + i * 0.12),
          H * 0.2,
          kind.replace('_', ' '),
        );
      });
      // Pictured quantities: coin stacks, rows and piles.
      [1, 3, 6, 10].forEach((n, i) => {
        place(createCoinStack(n), W * (0.06 + i * 0.06), H * 0.42, 'stack');
      });
      [2, 5].forEach((n, i) => {
        place(createCoinRow(n, 1.2), W * (0.34 + i * 0.12), H * 0.42, 'row');
      });
      [4, 12, 30].forEach((n, i) => {
        place(createCoinPile(n, 1.2), W * (0.6 + i * 0.12), H * 0.42, 'pile');
      });
      // Baskets and sacks.
      place(createBasket({ contents: 'tomato', count: 9 }), W * 0.08, H * 0.62, 'basket');
      place(createBasket({ contents: 'onion', count: 5 }), W * 0.18, H * 0.62, 'basket');
      place(createSack({ open: true, contents: 'rice' }), W * 0.28, H * 0.62, 'sack open');
      place(createSack({ open: false }), W * 0.36, H * 0.62, 'sack tied');
      place(createSack({ open: true, contents: 'onion' }), W * 0.44, H * 0.62, 'sack onions');
      place(createFuelCan(), W * 0.52, H * 0.62, 'fuel can');
      place(createFuelCan(0x2e8b57, 40), W * 0.58, H * 0.62, 'fuel can');
      const lan = new HandLantern(1.4);
      place(lan.view, W * 0.65, H * 0.5, '');
      // Brass scale with an animated beam.
      const scale = new BrassScale();
      scale.leftPan.addChild(createGoodsPile('tomato', 4, 0.9));
      scale.rightPan.addChild(createCoinStack(5, 1.2));
      place(scale.view, W * 0.84, H * 0.64, 'brass scale');
      scale.attach(app.ticker);
      // Carts.
      const cart = new BullockCart();
      cart.bed.addChild(createSack({ open: false, height: 50 }));
      const sack2 = createSack({ open: true, contents: 'grain', height: 44 });
      sack2.x = -46;
      cart.bed.addChild(sack2);
      cart.setSpeed(140);
      cart.attach(app.ticker);
      const driver = make(kit, { id: 'driver', role: 'vendor', view: 'side', scale: 1 / kit.unit });
      driver.setIdleLife(false);
      void driver.play('steer_cart');
      // The driver's view lives in the cart (rig units match).
      driver.view.scale.set(1, 1);
      driver.view.position.set(cart.seat.x, cart.seat.y);
      cart.driverLayer.addChild(driver.view);
      place(cart.view, W * 0.2, H * 0.97, 'bullock cart');
      const hcart = new HandCart();
      hcart.tray.addChild(createGoodsPile('mango', 6, 0.9));
      place(hcart.view, W * 0.78, H * 0.97, 'hand cart');
      const tick = (t: Ticker): void => {
        const dt = t.deltaMS / 1000;
        lan.update(dt);
        hcart.setSpeed(40);
        hcart.update(dt);
      };
      app.ticker.add(tick);
      let alive = true;
      void (async () => {
        const seq = [0, -0.6, 0.4, 1, -1, 0];
        let i = 0;
        while (alive) {
          scale.setBalance(seq[i % seq.length] ?? 0);
          i++;
          await new Promise((r) => setTimeout(r, 2200));
        }
      })();
      void balanceForWeights;
      return () => {
        alive = false;
        app.ticker.remove(tick);
        driver.destroy();
        scale.destroy();
        cart.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/rig\/scene$/,
    mount(app) {
      const { kit, dispose } = galleryKit(app);
      backdrop(kit, app, 'market_square', 0.05);
      const w = app.screen.width;
      const h = app.screen.height;
      // Characters run on a private ticker so the route can time the rig's CPU cost per frame.
      const rigTicker = new Ticker();
      rigTicker.autoStart = false;
      const deps = {
        ticker: rigTicker,
        lighting: kit.lighting,
        quality: kit.profile,
        cache: kit.cache,
      };
      const sc = Math.min(h * 0.34, w * 0.2) / 330;
      const mk = (spec: RigCharacterSpec): ProceduralCharacter =>
        new ProceduralCharacter({ ...spec, scale: (spec.scale ?? 1) * sc }, deps);
      const chars: ProceduralCharacter[] = [];
      // Depth-sorted figure layer: whoever stands lower on the ground is drawn in front.
      const layer = new Container();
      layer.sortableChildren = true;
      app.stage.addChild(layer);
      const add = (c: ProceduralCharacter, x: number, y: number): ProceduralCharacter => {
        c.view.position.set(w * x, h * y);
        c.view.zIndex = c.view.y;
        layer.addChild(c.view);
        chars.push(c);
        return c;
      };
      const vendor = add(mk({ id: 's-vendor', role: 'vendor', view: 'three_quarter' }), 0.1, 0.8);
      const buyer = add(
        mk({ id: 's-buyer', role: 'customer', variant: 4, view: 'three_quarter', facing: 'left' }),
        0.22,
        0.8,
      );
      const scale = new BrassScale();
      scale.view.scale.set(sc);
      scale.view.position.set(w * 0.16, h * 0.8);
      scale.attach(app.ticker);
      scale.view.zIndex = scale.view.y - 1;
      layer.addChild(scale.view);
      const carrier = add(
        mk({ id: 's-carrier', role: 'customer', variant: 9, view: 'side' }),
        0.3,
        0.92,
      );
      carrier.hold(createBasket({ contents: 'mango', count: 7, width: 64 }), 'head');
      void carrier.play('carry_on_head');
      const walker = add(
        mk({ id: 's-walker', role: 'customer', variant: 3, view: 'side' }),
        0.05,
        0.97,
      );
      const runner = add(
        mk({ id: 's-runner', role: 'customer', variant: 7, view: 'side', facing: 'left' }),
        0.95,
        0.99,
      );
      const pusher = add(
        mk({ id: 's-pusher', role: 'vendor', variant: 1, view: 'side' }),
        0.42,
        0.86,
      );
      const hcart = new HandCart();
      hcart.view.scale.set(sc);
      hcart.tray.addChild(createGoodsPile('tomato', 6, 0.9));
      layer.addChild(hcart.view);
      void pusher.play('push_cart');
      pusher.setLocomotion('walk');
      const guide = add(mk({ id: 's-guide', role: 'guide' }), 0.62, 0.9);
      const clapper = add(mk({ id: 's-clap', role: 'customer', variant: 5 }), 0.72, 0.84);
      const angry = add(
        mk({ id: 's-angry', role: 'customer', variant: 1, view: 'three_quarter', facing: 'left' }),
        0.84,
        0.86,
      );
      angry.setAngerLevel(3);
      const namaste = add(mk({ id: 's-namaste', role: 'customer', variant: 2 }), 0.52, 0.78);
      const folder = add(
        mk({ id: 's-fold', role: 'customer', variant: 6, view: 'three_quarter' }),
        0.92,
        0.78,
      );
      void folder.play('fold_arms');
      const thinker = add(mk({ id: 's-think', role: 'customer', variant: 8 }), 0.36, 0.76);
      thinker.setExpression('thinking');
      let alive = true;
      let px = 0.42;
      const loop = async (fn: () => Promise<void>): Promise<void> => {
        while (alive) await fn();
      };
      void loop(async () => {
        vendor.hold(createGoodsPile('onion', 3, 0.9), 'l');
        await vendor.play('place_on_scale', {
          onEvent: (e) => {
            if (e !== 'place') return;
            const it = vendor.release('l');
            if (it) {
              it.position.set(0, 0);
              scale.leftPan.removeChildren();
              scale.leftPan.addChild(it);
              scale.setBalance(-0.6);
            }
          },
        });
        await new Promise((r) => setTimeout(r, 900));
        scale.leftPan.removeChildren();
        scale.setBalance(0);
        vendor.hold(createCoinStack(3, 1.3), 'l');
        void buyer.play('receive');
        await vendor.play('hand_over', {
          onEvent: (e) => {
            if (e !== 'give') return;
            const it = vendor.release('l');
            if (it) buyer.hold(it, 'l');
          },
        });
        await new Promise((r) => setTimeout(r, 700));
        buyer.release('l')?.destroy({ children: true });
        await buyer.play('namaste');
      });
      void loop(async () => {
        walker.view.x = w * 0.02;
        walker.setFacing('right');
        await walker.walkTo(w * 0.55);
        await walker.play('wave');
        await walker.walkTo(w * 0.02);
      });
      void loop(async () => {
        runner.view.x = w * 1.02;
        await runner.walkTo(w * 0.45, { gait: 'run' });
        runner.react('surprised');
        await runner.play('shrug');
        await runner.walkTo(w * 1.02, { gait: 'run' });
      });
      void loop(async () => {
        await guide.speakFor(2400);
        await guide.play('beckon');
        await new Promise((r) => setTimeout(r, 800));
      });
      void loop(async () => {
        await clapper.play('clap');
        await clapper.play('celebrate');
        await new Promise((r) => setTimeout(r, 1500));
      });
      void loop(async () => {
        await angry.play('point');
        await angry.speakFor(1800);
        await angry.play('foot_tap');
        await new Promise((r) => setTimeout(r, 2000));
        await angry.stopGesture();
      });
      void loop(async () => {
        await namaste.play('nod');
        await new Promise((r) => setTimeout(r, 2500));
      });
      // Timing.
      const samples: number[] = [];
      const start = performance.now();
      let last = performance.now();
      const tick = (): void => {
        const now = performance.now();
        const t0 = performance.now();
        rigTicker.update(now);
        const ms = performance.now() - t0;
        // Skip the first seconds (first-use texture bakes) so the figure reflects steady state.
        if (now - start > 3000) samples.push(ms);
        if (samples.length > 600) samples.shift();
        const dt = (now - last) / 1000;
        last = now;
        px += 0.02 * dt;
        if (px > 1.05) px = -0.1;
        pusher.view.x = w * px;
        hcart.view.position.set(pusher.view.x + 250 * sc, h * 0.86);
        hcart.view.zIndex = hcart.view.y + 1;
        for (const c of chars) c.view.zIndex = c.view.y;
        hcart.setSpeed(60);
        hcart.update(dt);
        const sorted = [...samples].sort((a, b) => a - b);
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        (globalThis as { __RIG_PERF__?: unknown }).__RIG_PERF__ = {
          characters: chars.length,
          frames: samples.length,
          avgMs: avg,
          p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          maxMs: sorted[sorted.length - 1] ?? 0,
        };
      };
      app.ticker.add(tick);
      // Pure CPU benchmark of the rig without rendering in between (called by the QA script).
      (globalThis as { __RIG_BENCH__?: (frames: number) => number }).__RIG_BENCH__ = (
        frames: number,
      ) => {
        app.ticker.stop();
        let t = performance.now();
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          t += 1000 / 60;
          rigTicker.update(t);
        }
        const per = (performance.now() - t0) / frames;
        app.ticker.start();
        return per;
      };
      return () => {
        alive = false;
        app.ticker.remove(tick);
        delete (globalThis as { __RIG_BENCH__?: unknown }).__RIG_BENCH__;
        for (const c of chars) c.destroy();
        scale.destroy();
        hcart.destroy();
        rigTicker.destroy();
        dispose();
      };
    },
  },
];

let registered = false;

/** Register the rig routes with the dev gallery (idempotent). */
export function registerCharacterRigGalleryRoutes(): void {
  if (registered) return;
  registered = true;
  registerRoutes(DEFS, {
    title: 'Character rig',
    prefix: '/rig',
    items: [
      { path: '/rig/views/0', label: 'views · guide + villagers 0-4' },
      { path: '/rig/views/1', label: 'views · villagers 5-9' },
      { path: '/rig/walk', label: 'walk & run cycles' },
      ...RIG_VIEWS.map((v) => ({ path: `/rig/gestures/${v}`, label: `gesture sheet · ${v}` })),
      ...RIG_VIEWS.map((v) => ({ path: `/rig/gestures-live/${v}`, label: `gestures live · ${v}` })),
      ...GESTURE_NAMES.map((n) => ({ path: `/rig/gesture/${n}`, label: `gesture · ${n}` })),
      ...VILLAGERS.map((_, i) => ({
        path: `/rig/expressions/${i}`,
        label: `expressions · variant ${i}`,
      })),
      { path: '/rig/visemes', label: 'visemes by amplitude' },
      { path: '/rig/life', label: 'blinks, gaze, look-at, lip-sync' },
      { path: '/rig/cloth', label: 'cloth colour variants' },
      { path: '/rig/props', label: 'props' },
      { path: '/rig/scene', label: 'market scene (perf)' },
    ],
  });
}

export type { GalleryRoute };
