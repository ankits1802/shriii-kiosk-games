/**
 * Gallery routes. Each route mounts a showcase onto the shared Pixi application and returns a cleanup.
 * Onboarding and report previews register themselves from their own modules via {@link registerRoutes}.
 */
import { type Application, Container, Graphics } from 'pixi.js';
import type {
  ButtonSpec,
  CharacterRole,
  ParticleKind,
  SceneId,
  TimeOfDay,
  TransitionKind,
} from '../../core/contracts.ts';
import { createArtKit, type MelaArtKit } from '../ArtKit.ts';
import { VILLAGERS } from '../characters/appearance.ts';
import type { ExtendedExpression } from '../characters/expressions.ts';
import { createViewportLayout } from '../layout.ts';
import { MELA } from '../palettes.ts';
import { parseQualityTier } from '../quality.ts';
import { drawIcon, iconIds } from '../ui/icons.ts';

export interface GalleryRoute {
  readonly params: readonly string[];
  mount(app: Application, params: readonly string[]): (() => void) | Promise<() => void>;
}

export interface RouteDef {
  readonly pattern: RegExp;
  mount(app: Application, params: readonly string[]): (() => void) | Promise<() => void>;
}

export interface RouteGroup {
  readonly title: string;
  readonly prefix: string;
  readonly items: readonly { readonly path: string; readonly label: string }[];
}

export const SCENES: readonly SceneId[] = [
  'attract',
  'market_square',
  'hub',
  'stall_front',
  'weighing_post',
  'road_home',
  'tower_courtyard',
  'balloon_fair',
  'card_tent',
  'share_circle',
  'report',
];
export const TIMES: readonly TimeOfDay[] = ['morning', 'midday', 'golden_hour', 'dusk'];

/** Shared kit + layout for a gallery route. */
export function galleryKit(app: Application): {
  kit: MelaArtKit;
  layout: ReturnType<typeof createViewportLayout>;
  dispose: () => void;
} {
  const params =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const layout = createViewportLayout(app, Number(params.get('pxPerMm') ?? 4));
  const kit = createArtKit({
    app,
    layout,
    quality: {
      tier: parseQualityTier(params.get('tier')),
      reducedMotion: params.has('reducedMotion'),
    },
  });
  return {
    kit,
    layout,
    dispose: () => {
      kit.destroy();
      layout.dispose();
      for (const c of app.stage.removeChildren()) c.destroy({ children: true });
    },
  };
}

const EXPRESSION_ORDER: readonly ExtendedExpression[] = [
  'neutral',
  'calm',
  'pleased',
  'happy',
  'thinking',
  'surprised',
  'impatient',
  'annoyed',
  'angry',
];

const DEFS: RouteDef[] = [
  {
    pattern: /^\/backdrop\/([a-z_]+)\/([a-z_]+)$/,
    mount(app, [scene, tod]) {
      const { kit, dispose } = galleryKit(app);
      const b = kit.createBackdrop(scene as SceneId, tod as TimeOfDay);
      app.stage.addChildAt(b.view, 0);
      return dispose;
    },
  },
  {
    // Time-of-day journey: Stall (afternoon) -> Weighing Post (golden) -> Road Home (dusk), looping.
    pattern: /^\/daycycle\/([a-z_]+)$/,
    mount(app, [scene]) {
      const { kit, dispose } = galleryKit(app);
      const b = kit.createBackdrop(scene as SceneId, 'midday');
      app.stage.addChildAt(b.view, 0);
      let alive = true;
      void (async () => {
        const order: TimeOfDay[] = ['golden_hour', 'dusk', 'midday'];
        while (alive) {
          for (const t of order) {
            if (!alive) return;
            await b.setTimeOfDay(t, { durationMs: 3500 });
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
      })();
      return () => {
        alive = false;
        dispose();
      };
    },
  },
  {
    pattern: /^\/characters$/,
    mount(app) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('market_square', 'golden_hour');
      app.stage.addChild(b.view);
      const roles: { role: CharacterRole; variant: number }[] = [
        { role: 'guide', variant: 0 },
        ...VILLAGERS.map((_, i) => ({ role: 'customer' as const, variant: i })),
      ];
      const perRow = layout.orientation === 'portrait' ? 4 : 6;
      const rows = Math.ceil(roles.length / perRow);
      const cellW = layout.width / perRow;
      const cellH = (layout.height * 0.82) / rows;
      const chars = roles.map((r, i) => {
        const c = kit.createCharacter({
          id: `g${i}`,
          role: r.role,
          variant: r.variant,
          scale: Math.min(cellH / 380, cellW / 200) / kit.unit,
        });
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        c.view.position.set(cellW * (col + 0.5), layout.height * 0.16 + cellH * (row + 1) - 10);
        app.stage.addChild(c.view);
        return c;
      });
      const timer = setInterval(() => {
        const c = chars[Math.floor(Math.random() * chars.length)];
        void c?.play(Math.random() > 0.5 ? 'wave' : 'nod');
      }, 1400);
      return () => {
        clearInterval(timer);
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    // Every expression for one villager variant (plus the Stall tone ramp 0..4 on the last row).
    pattern: /^\/expressions\/(\d+)$/,
    mount(app, [variantStr]) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('stall_front', 'midday');
      app.stage.addChild(b.view);
      const dim = new Graphics()
        .rect(0, 0, layout.width, layout.height)
        .fill({ color: MELA.indigoDeep, alpha: 0.25 });
      app.stage.addChild(dim);
      const variant = Number(variantStr ?? 0);
      const items: { e?: ExtendedExpression; tone?: 0 | 1 | 2 | 3 | 4 }[] = [
        ...EXPRESSION_ORDER.map((e) => ({ e })),
        ...([0, 1, 2, 3, 4] as const).map((tone) => ({ tone })),
      ];
      const perRow = layout.orientation === 'portrait' ? 4 : 7;
      const rows = Math.ceil(items.length / perRow);
      const cellW = layout.width / perRow;
      const cellH = (layout.height * 0.9) / rows;
      const chars = items.map((it, i) => {
        const c = kit.createCharacter({
          id: `e${i}`,
          role: 'customer',
          variant,
          scale: Math.min(cellH / 300, cellW / 190) / kit.unit,
          ...(it.tone !== undefined ? { toneLevel: it.tone } : {}),
        });
        if (it.e) c.setExpression(it.e);
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        c.view.position.set(cellW * (col + 0.5), layout.height * 0.06 + cellH * (row + 1) - 8);
        app.stage.addChild(c.view);
        return c;
      });
      return () => {
        for (const c of chars) c.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/guide$/,
    mount(app) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('attract', 'golden_hour');
      app.stage.addChild(b.view);
      const guide = kit.createCharacter({ id: 'guide', role: 'guide', scale: 1.5 });
      guide.view.position.set(layout.width * 0.3, layout.height * 0.93);
      app.stage.addChild(guide.view);
      const btn = kit.createButton({
        id: 'go',
        iconId: 'play',
        audioKey: 'attract.touch_to_start',
        variant: 'primary',
        sizeMm: 40,
      });
      btn.view.position.set(layout.width * 0.66, layout.height * 0.7);
      app.stage.addChild(btn.view);
      let alive = true;
      void (async () => {
        while (alive) {
          await guide.entrance();
          guide.setExpression('happy');
          await guide.pointAt({ x: btn.view.x, y: btn.view.y });
          btn.pulse();
          await guide.speakFor(2200);
          await guide.play('idle');
          guide.setExpression('calm');
          await guide.play('nod');
          await new Promise((r) => setTimeout(r, 1500));
          if (!alive) return;
          await guide.play('celebrate');
          await new Promise((r) => setTimeout(r, 1500));
          await guide.exit();
          await new Promise((r) => setTimeout(r, 800));
        }
      })();
      return () => {
        alive = false;
        guide.destroy();
        btn.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/guide-still$/,
    mount(app) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('attract', 'golden_hour');
      app.stage.addChild(b.view);
      const guide = kit.createCharacter({ id: 'guide', role: 'guide', scale: 2.2 });
      guide.view.position.set(layout.width * 0.5, layout.height * 0.98);
      guide.setExpression('happy');
      app.stage.addChild(guide.view);
      return () => {
        guide.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/ui$/,
    mount(app) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('card_tent', 'golden_hour');
      app.stage.addChild(b.view);
      const variants: ButtonSpec['variant'][] = [
        'confirm',
        'cancel',
        'replay',
        'help',
        'exit',
        'primary',
        'secondary',
      ];
      const buttons = variants.map((v, i) => {
        const btn = kit.createButton({ id: v, iconId: '', audioKey: `ui.${v}`, variant: v });
        btn.view.position.set(
          (layout.width / (variants.length + 1)) * (i + 1),
          layout.height * 0.3,
        );
        app.stage.addChild(btn.view);
        return btn;
      });
      buttons[0]?.pulse();
      buttons[2]?.setEnabled(false);
      const globe = kit.createIconButton({
        id: 'globe',
        iconId: 'globe',
        audioKey: 'onboarding.globe_hint',
      });
      globe.view.position.set(layout.width * 0.08, layout.height * 0.1);
      app.stage.addChild(globe.view);
      // Icon sheet.
      const ids = iconIds();
      const sheet = new Container();
      const cols = layout.orientation === 'portrait' ? 8 : 16;
      const cell = Math.min(layout.width / (cols + 1), 92);
      ids.forEach((id, i) => {
        const bg = new Graphics()
          .roundRect(-cell * 0.45, -cell * 0.45, cell * 0.9, cell * 0.9, cell * 0.18)
          .fill({ color: MELA.cream, alpha: 0.92 });
        const ic = drawIcon(id, cell * 0.72, MELA.indigo);
        const c = new Container();
        c.addChild(bg, ic);
        c.position.set((i % cols) * cell + cell / 2, Math.floor(i / cols) * cell + cell / 2);
        sheet.addChild(c);
      });
      sheet.position.set((layout.width - cols * cell) / 2, layout.height * 0.45);
      app.stage.addChild(sheet);
      // Picture tiles with selection + hand hint.
      const tiles = ['face_happy', 'face_neutral', 'face_sad'].map((id, i) => {
        const pic = drawIcon(id, 120, MELA.ink);
        const holder = new Container();
        holder.addChild(pic);
        const t = kit.createPictureTile(id, holder, 38);
        t.view.position.set(layout.width * (0.3 + i * 0.2), layout.height * 0.82);
        app.stage.addChild(t.view);
        return t;
      });
      tiles[0]?.setSelected(true);
      const hint = kit.createHandHint();
      app.stage.addChild(hint.view);
      hint.show('tap', { x: tiles[1]?.view.x ?? 0, y: tiles[1]?.view.y ?? 0 });
      return () => {
        hint.destroy();
        for (const t of tiles) t.destroy();
        for (const btn of buttons) btn.destroy();
        globe.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/effects$/,
    mount(app) {
      const { kit, layout, dispose } = galleryKit(app);
      const b = kit.createBackdrop('report', 'dusk');
      app.stage.addChild(b.view);
      const kinds: ParticleKind[] = [
        'confetti',
        'sparkle',
        'dust',
        'petals',
        'smoke',
        'coins',
        'leaves',
      ];
      const emitters = kinds.map((k, i) => {
        const e = kit.createParticles({
          kind: k,
          origin: { x: (layout.width / (kinds.length + 1)) * (i + 1), y: layout.height * 0.6 },
        });
        app.stage.addChild(e.view);
        return e;
      });
      const timer = setInterval(() => {
        for (const e of emitters) e.burst();
      }, 2600);
      return () => {
        clearInterval(timer);
        for (const e of emitters) e.destroy();
        dispose();
      };
    },
  },
  {
    pattern: /^\/transition\/([a-z_]+)$/,
    mount(app, [kind]) {
      const { kit, dispose } = galleryKit(app);
      const scenes: SceneId[] = ['stall_front', 'weighing_post', 'road_home'];
      const tods: TimeOfDay[] = ['midday', 'golden_hour', 'dusk'];
      let idx = 0;
      let b = kit.createBackdrop(scenes[0] ?? 'hub', tods[0] ?? 'midday');
      app.stage.addChildAt(b.view, 0);
      let alive = true;
      void (async () => {
        while (alive) {
          await new Promise((r) => setTimeout(r, 1600));
          if (!alive) return;
          await kit.transition(kind as TransitionKind, {
            durationMs: 1400,
            midpoint: () => {
              idx = (idx + 1) % scenes.length;
              b.destroy();
              b = kit.createBackdrop(scenes[idx] ?? 'hub', tods[idx] ?? 'midday');
              app.stage.addChildAt(b.view, 0);
            },
          });
        }
      })();
      return () => {
        alive = false;
        dispose();
      };
    },
  },
];

const EXTRA_DEFS: RouteDef[] = [];
const EXTRA_GROUPS: RouteGroup[] = [];

/** Register additional routes (onboarding/report previews). */
export function registerRoutes(defs: readonly RouteDef[], group: RouteGroup): void {
  EXTRA_DEFS.push(...defs);
  EXTRA_GROUPS.push(group);
}

export function resolveRoute(path: string): GalleryRoute | null {
  for (const d of [...DEFS, ...EXTRA_DEFS]) {
    const m = d.pattern.exec(path);
    if (m) return { params: m.slice(1), mount: d.mount };
  }
  return null;
}

const BASE_GROUPS: readonly RouteGroup[] = [
  {
    title: 'Backdrops',
    prefix: '/backdrop',
    items: SCENES.flatMap((s) =>
      TIMES.map((t) => ({ path: `/backdrop/${s}/${t}`, label: `${s} · ${t}` })),
    ),
  },
  {
    title: 'Day cycle',
    prefix: '/daycycle',
    items: SCENES.map((s) => ({ path: `/daycycle/${s}`, label: s })),
  },
  {
    title: 'Characters',
    prefix: '/c',
    items: [
      { path: '/characters', label: 'all villagers + guide' },
      { path: '/guide', label: 'guide performance' },
      { path: '/guide-still', label: 'guide close-up' },
      ...VILLAGERS.map((_, i) => ({
        path: `/expressions/${i}`,
        label: `expressions · variant ${i}`,
      })),
    ],
  },
  { title: 'UI', prefix: '/ui', items: [{ path: '/ui', label: 'buttons, icons, tiles, hint' }] },
  {
    title: 'Effects',
    prefix: '/e',
    items: [
      { path: '/effects', label: 'particles' },
      ...(['fade', 'iris', 'wipe_left', 'wipe_right', 'curtain'] as const).map((k) => ({
        path: `/transition/${k}`,
        label: `transition · ${k}`,
      })),
    ],
  },
];

/** Route groups for the gallery menu (base + registered). */
export function galleryGroups(): readonly RouteGroup[] {
  return [...BASE_GROUPS, ...EXTRA_GROUPS];
}
