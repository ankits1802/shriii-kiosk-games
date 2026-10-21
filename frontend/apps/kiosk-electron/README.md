# @shriii/kiosk-electron — kiosk runtime

Hardened Electron (44.x) shell for the offline kiosk (KSK-01, KSK-07, KSK-08, KSK-11). It loads the
built `frontend/apps/kiosk` renderer and owns everything that needs Node: the encrypted SQLite outbox, the
uploader, the thermal printer and updates.

## Security model

| Concern | Implementation |
| --- | --- |
| Window | one `kiosk: true` fullscreen window, no menu, no context menu, zoom/pinch/swipe-nav disabled, reload/devtools/zoom keys swallowed |
| Renderer isolation | `contextIsolation`, `sandbox`, no `nodeIntegration`, no `<webview>`, devtools only unpackaged |
| Bridge | `window.shriiiKiosk` (`src/shared/ipc-contract.ts`): outbox, printer, lifecycle state, power events; every payload validated (`src/main/ipc-handlers.ts`), every sender checked |
| Content | `app://kiosk/` standard secure scheme serving `resources/renderer` (no `file://` ES-module issues); traversal and symlink escapes refused |
| CSP | `default-src 'self'`, scripts only from self, `connect-src` self + API origin, no objects/frames |
| Network | `webRequest` allow-list: app, data/blob, API origin (and the dev server unpackaged); `file://` and everything else cancelled |
| Permissions | all denied (no camera, ever; mic arrives with VOX-04), no downloads, no new windows, no navigation away |
| Process | single instance; power-save blocker; watchdog: crash/hang → reload to attract (< 1 s measured), crash loop → app relaunch → out-of-service page; uncaught main error → relaunch |

## Data path

Renderer (kiosk-game logger) → `IpcOutbox` (`src/renderer-bridge`) → IPC → `SqliteOutbox`
(`frontend/packages/outbox-sqlite`, per-session DEK sealed to the backend X25519 key) → `MainUploader`
(`net.fetch`, paused unless the kiosk is in attract, backoff, 426 stop) → API.

## Configuration

`<userData>/kiosk-config.json` (or `SHRIII_KIOSK_CONFIG`), overridden by env:
`SHRIII_KIOSK_ID`, `SHRIII_API_ORIGIN`, `SHRIII_RECIPIENT_KEYS` (backend public keys JSON),
`SHRIII_PRINTER` (`virtual[:dir]`, `tcp://host:9100`, `device:/dev/usb/lp0`, `none`),
`SHRIII_UPDATE_FEED`, `SHRIII_UPDATE_RING`, `SHRIII_UPDATE_PUBKEY`, `SHRIII_OUTBOX_POLICY`,
`SHRIII_KIOSK_DEV_URL` (unpackaged only), `SHRIII_KIOSK_WINDOWED=1`. Packaged builds require a
provisioned kiosk id and backend keys (fail closed: no keys → no sessions).

## Updates (scaffold)

electron-updater generic feeds per ring (`lab`, `canary`, `ring10`, `stable`; ring10 by a stable
hash bucket of the kiosk id). Nothing downloads unless `release-manifest.json` verifies against the
pinned Ed25519 key and matches the offered version/sha512, is newer, unexpired and allowed by the
wave freeze; installs happen only after 60 s idle in attract. Snap installs are updated by snapd.

## Commands

```bash
pnpm --filter @shriii/kiosk-electron electron:install   # one-time Electron binary download
pnpm --filter @shriii/kiosk-electron test               # unit + integration (vitest)
pnpm --filter @shriii/kiosk-electron test:e2e           # build + real-Electron self-test
pnpm --filter @shriii/kiosk-electron start              # build + run (SHRIII_KIOSK_WINDOWED=1 for a window)
pnpm --filter @shriii/kiosk-electron pack               # renderer + main + electron-builder --dir
node scripts/smoke.mjs --exe "release/win-unpacked/SHRIII Kiosk.exe"   # self-test the packed app
# Linux artefacts from Windows: cross-pack, then build/verify in a container
npx electron-builder --linux dir --x64 --config electron-builder.yml
docker run --rm -v "$PWD:/app" node:24-trixie-slim sh /app/scripts/linux-smoke.sh
docker run --rm -v "$PWD:/app" node:24-trixie-slim sh /app/scripts/linux-dist.sh "snap AppImage"
```
