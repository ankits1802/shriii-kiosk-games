# Electron shell (KSK-01 scaffold)

`main.ts` opens one fullscreen `kiosk: true` window with `contextIsolation`, `sandbox`, no Node in the
renderer, a strict CSP (self plus the configured API origin only), devtools only in unpackaged runs,
navigation/new-window/zoom blocking, a deny-all permission handler (no camera, ever), a power-save
blocker and a watchdog that reloads a crashed renderer to attract. `preload.cts` exposes the minimal
typed `window.shriiiKiosk` bridge (`getAppVersion`, `relaunchToAttract`, `onPowerEvent`).

The renderer is the Vite build of `apps/kiosk` (`dist/`, built with `base: './'` for `file://`). The
renderer imports `pixi.js/unsafe-eval` so Pixi works under the CSP without `unsafe-eval`.

Electron is an optional dev dependency; pnpm blocks its binary download by default.

```bash
# One-time binary download (pnpm skips electron's install script):
pnpm --filter @shriii/kiosk exec node node_modules/electron/install.js
# Build the renderer and main process, then launch:
pnpm --filter @shriii/kiosk electron
# Against the Vite dev server instead of dist/:
SHRIII_KIOSK_DEV_URL=http://localhost:5173 pnpm --filter @shriii/kiosk exec electron electron/dist/main.js
```

Environment: `SHRIII_API_ORIGIN` (CSP `connect-src` for uploads, e.g. `http://localhost:8000`).

Later features, not implemented here: signed snap packaging on Ubuntu Core (KSK-09), the SQLite
outbox adapter behind the `Outbox` interface (KSK-07), crash-recovery
`session.abandoned{crash_recovery}` for the session open when the renderer died, fleet heartbeat
and OTA (KSK-10/11).
