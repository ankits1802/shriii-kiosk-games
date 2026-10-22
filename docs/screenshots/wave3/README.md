# Wave 3 art-direction storyboard

`storyboard/` has 37 key frames from full kiosk sessions. The frames are 1920x1080 unless noted;
`P*` frames are 1080x1920 and `RM1` uses the reduced-motion tier. `00_contact_sheet.jpg` shows the
29 landscape frames in order. Watch them as one film.

## How the frames were made

- **Full sessions.** Pathway A and Pathway B were played on a bridge build of `apps/kiosk`
  (`VITE_E2E_BRIDGE=true`, served with `vite preview`). The bot was the `e2e/full-session.mjs` logic,
  with extra screenshots at each state and module change. Chromium ran on the local GPU (ANGLE D3D11).
  Both sessions passed the bot's checks: the session completed, every event was valid, and seq was
  gapless.
- **Phases a 10-minute bot run may not reach.** Each module's own dev harness filled these in:
  - Road Home stills: `episodes/road-home/dev/shoot-stills.mjs`
  - Stall portrait and reduced-motion: `episodes/stall/dev/shoot.mjs`
  - Weighing Post, Tower and Share-the-Pot: the in-app `?module=<id>&bot=1` harness

## The lighting arc

### Pathway A: one evening at the mela

| Frames | Scene | Light |
|---|---|---|
| 01-04 | Attract and onboarding | Golden hour, with the guide and her lantern |
| 06-09 | The Stall | Opens in warm late afternoon (time value 1.5) and closes at golden hour (2.16) |
| 10-12 | The Weighing Post | Picks up at 2.16 and slides to the edge of sunset (2.65, outro 2.72) |
| 13-19 | The Road Home | Sunset departure, then dusk at the fork, then a moonlit night: fodder stop, uphill crest, arrival home with diyas |
| 14, 16 | Errand map | Shares the same clock: an amber cast at sunset, a cool blue wash at night, lamp glows at houses and stalls |
| 20-21 | Report and survey | The night fair, with sky lanterns and a diya rangoli |

Before this pass, the Stall ran from midday to almost dusk (1.05 to 2.85) and the Weighing Post then
went back to golden afternoon (2.02). The light jumped backwards between episodes and the Stall
opened under a blue midday sky.

### Pathway B: the fair at golden hour and towards dusk

| Frame | Game | Light |
|---|---|---|
| 22 | Hub walk | Golden hour |
| 23 | Don't-Tap | Dusk stage |
| 24 | Card Sort | Fortune-teller's tent |
| 25 | Balloon | Golden hour |
| 26 | Tower | Warm late afternoon (time value 1.8) |
| 27 | Share-the-Pot | Golden hour to sunset |
| 28 | Steady Hands | Dusk |
| 29 | Report | Night |

Tower used to be a cool grey morning (0.55), the only cold frame in the run.

## What this pass changed (visual only)

None of these changes touch trial timing, response windows, stimulus onset, event payloads, phase
tags or trial counts.

- **Lighting arc.**
  - `episodes/stall/scene/StallScene.ts`: `BEAT_TIME`.
  - `episodes/weighing-post/scene/PixiWeighingScene.ts`: intro, `setProgress` and outro time
    values.
  - `games/tower/TowerView.ts`: time of day.
- **Errand map.** `road-home/view/MapScene.ts`: a stronger sunset cast and a bluer night. The night
  map is cooler than before but still lighter than the road scenes, so the map stays readable.
- **HUD overlap.** `road-home/view/RoadHomeView.ts`: the errand chit covered the replay button.
  It now sits to the button's right.
- **Particles.**
  - Road Home: the reserve-sack sparkle no longer fires a white burst on every move once the
    tray runs dry. It is a soft gold twinkle at most once every 2.5 s (`hud.ts`). Errand sparkles
    are gold too, through a new `EpisodeArt.burst` tint.
  - Dust bursts in all scenes (`art/fx/particles.ts`) are smaller, sandier and peak at 55 %
    opacity. Before, they piled up into a white blob on the Stall counter and the Weighing Post
    cloth.
- **Character rig.** `art/characters/rig/drawHead.ts`: the pagri's wrapped folds stuck out of the
  silhouette in side and three-quarter views, as a ghost crest. This affected the Stall customers
  and the Road Home driver.
- **Grounding.** `art/backdrop/scenes.ts`: far temples rest on the lowest ridge point under their
  footprint (`SceneKit.ridgeFoot`). In portrait, the attract temple used to float above the hills.
- **Weighing Post.**
  - The intro brass glint now sweeps only over the beam; before, it crossed the guide as a pale
    vertical bar.
  - The set's light shafts are subtler, so the people are no longer washed out.
- **Stability.** `art/ui/buttons.ts`: an icon button no longer crashes if it is asked to pulse in
  the same tick it is destroyed. This crashed a Pathway B bot session at onboarding.

## Checked and left as is

- **Readability.** Expressions read without text: the anger ladder, tone medallions with shape
  cues, thought bubbles with pictures.
- **Grounding.** Feet are grounded on the road and in the courtyard.
- **Touch targets.** Targets are at least 20 mm, and choices always differ in shape and picture,
  not colour alone. The age band uses figures, the Weighing Post stamps use circle, triangle and
  square, and the Stall tone tokens use flower, round and octagon frames.
- **Reduced motion (`RM1`).** The same composition with static light.
- **Portrait (`P1-P7`).** The layouts reflow without overlaps.

## Known gaps

- **Warm-up (frame 05).** The warm-up still runs the engine's generic placeholder: a flat
  terracotta screen with a hand button. It is the weakest frame in the film and sits right
  between onboarding and the first scene. It needs a bespoke warm-up module, or at least a Mela
  backdrop behind `engine/fallbacks/generic-module.ts`. Both are outside the art directories this
  pass may edit.
- **Steady Hands bloom (frame 28 and later).** When the lamp is lit, its glow and light pool wash
  the frame towards white. That glow is the go-stimulus, so its brightness was left alone for the
  measurement owners to decide.
- **Sunset errand map.** The map still has its daytime greens, under an amber cast.
- **Road Home practice map.** In one bridge-build bot run, the bot stayed on the practice map for
  the whole episode. The session still completed and every event was valid. This looks like a bot
  targeting issue rather than an art issue, but it is worth a look.
