# infra/kiosk-image: Ubuntu Core 24 kiosk image (KSK-09, KSK-10, KSK-11)

There is one SKU and one image: **Ubuntu Core 24 + Ubuntu Frame + the `shriii-kiosk` snap**, with a brand
gadget that locks the device down. Provisioning takes a kiosk from bare hardware to a locked, enrolled
device. The device identity is an mTLS certificate from the SHRIII step-ca (`infra/pki`).

| Path | What it is |
|---|---|
| `app/snap/snapcraft.yaml` | strictly confined app snap: the Electron runtime under Frame plus the `enrol`, `cert-renew` and `netguard` services |
| `app/src/bin/*`, `app/src/share/lib.sh` | launcher, enrolment, renewal, NSS import and egress allow-list scripts |
| `app/snap/hooks/{install,configure}` | private device root; option validation; `enrolment-bundle` intake |
| `gadget/` | brand gadget (`shriii-kiosk-pc`): UEFI/Secure Boot boot assets from canonical/pc-gadget 24, lockdown defaults, auto-connections, the ESC/POS `custom-device` slot, the kernel command line |
| `model/shriii-kiosk-pc-24.json` | model assertion template (`grade: signed`, `storage-safety: encrypted`, wave-freeze validation set) |
| `scripts/prepare-app-build.sh` | builds `frontend/apps/kiosk-electron` (`electron-builder --linux dir`) into `app/build/` |
| `scripts/render-gadget.sh` | renders `gadget/gadget.yaml` from brand-store ids and the root CA fingerprint |
| `../../tools/provision` | `shriii-provision` CLI: register, push, enrol, verify, renew, revoke, model, wave-freeze |
| `../../.github/workflows/kiosk-image.yml` | CI: build both snaps, lint them, validate the model, run the CLI tests and the PKI smoke test |

The Electron app (`frontend/apps/kiosk-electron`) is packaged as is. Its `electron-builder.yml` snap target
is not used: core24 needs a real snapcraft build, and the Frame daemon, the enrolment services and the
interfaces belong to the image.

## What is on the device

```
model shriii-kiosk-pc-24 (brand-signed, grade signed, TPM-backed FDE)
├── snapd, core24, pc-kernel 24          Canonical
├── shriii-kiosk-pc 24/stable            brand gadget: lockdown defaults + auto-connections
├── mesa-2404                            graphics userspace (gpu-2404 content, required by Frame apps)
├── ubuntu-frame 24/stable               Wayland kiosk compositor: one fullscreen app, no shell, cursor hidden
├── pipewire                             audio server (audio-playback slot)
└── shriii-kiosk                         strict confinement
    ├── kiosk       (daemon) Electron  ── wayland ▶ Frame, audio-playback ▶ pipewire,
    │                                     escpos-printer ▶ /dev/usb/lp*, network (API only, see netguard)
    ├── enrol       (daemon) first-boot enrolment and lockdown finalisation (snapd-control)
    ├── cert-renew  (daemon) step ca renew --daemon (24 h certificates)
    └── netguard    (daemon) nftables egress allow-list (firewall-control)
```

### Interfaces

| Plug | Why | Connected by |
|---|---|---|
| `wayland`, `opengl`, gpu-2404 (gpu extension) | draw under Frame | gadget `connections` |
| `browser-support` | Chromium runtime | gadget |
| `audio-playback` | pre-recorded prompts (VOX-01). **No `audio-record`**: the microphone arrives with VOX-04 under PRV-03. | gadget → pipewire |
| `escpos-printer` (`custom-device`) | raw ESC/POS on `/dev/usb/lp[0-9]` only | gadget slot + connection |
| `hardware-observe` | hardware self-test (KSK-08); the paper sensor is read back over the `escpos-printer` node | gadget |
| `network` | the API, through netguard | auto |
| `firewall-control` (netguard only) | egress allow-list | gadget (brand store) |
| `snapd-control` (enrol only) | lockdown finalisation: SSH off, kernel command line, remove the bench user, reboot | gadget (brand store) |
| **not present** | `camera`, `audio-record`, `home`, `removable-media`, `raw-usb` (usbfs would bypass the USB storage blacklist), `x11`, `desktop` | |

## Lockdown (KSK-09)

| Control | Where |
|---|---|
| No desktop, no shell: Frame runs one fullscreen app | model (no desktop snaps, enforced by `model validate`), Frame |
| No TTY login | gadget `service.console-conf.disable: true`; `cmdline.extra` has `systemd.getty_auto=0` and `vt.global_cursor_default=0` |
| No SSH after enrolment | `enrol` sets `service.ssh.disable=true` and removes the bench system user |
| USB mass storage off | after enrolment: `system.kernel.cmdline-append=modprobe.blacklist=usb_storage,uas` (allowed by the gadget `kernel-cmdline.allow`). No automount ever: Ubuntu Core ships no udisks. |
| Power key and Ctrl-Alt-Del ignored | gadget `system.power-key-action: ignore`, `system.ctrl-alt-del-action: none` |
| Hardware watchdog | gadget `watchdog.runtime-timeout: 30s`, `shutdown-timeout: 10m` |
| Crash recovery | snap daemons `restart-condition: always`; Electron watchdog to attract or out-of-service (KSK-01) |
| Secure Boot + FDE | Canonical-signed shim and grub, `storage-safety: encrypted` (TPM-sealed keys). A pulled disk is unreadable (PRV-07 AC). |
| Egress only to API, CA and the store | `netguard` (nftables `inet shriii_netguard`, policy drop, re-resolved every 5 min) |
| Refresh window | gadget `refresh.timer: 02:00-04:30` (no sessions run then), `refresh.retain: 2`, `refresh.metered: hold` |
| Wave freeze (KSK-11) | model validation set `shriii-wave-freeze`, `mode: enforce`, no pinned sequence. Each published sequence pins the exact revisions of `shriii-kiosk`, `ubuntu-frame` (and anything else listed). snapd refuses any other revision, so T1 and T2 run on the same build. Create one with `shriii-provision wave-freeze`, then `snap sign` and `snapcraft upload-validation-set`. |
| Data survives a revert | the outbox, keys and config live in `$SNAP_COMMON` (not `$SNAP_DATA`) |

### Escape checklist (manual AC, run on every new SKU and every gadget change)

Log a pass or fail for each item on the SKU certification sheet (ENG-02):

- [ ] Edge swipes from all four edges, three- and four-finger swipes and pinch do nothing (Frame has no shell; Electron disables pinch and swipe-nav).
- [ ] A long press and a two-finger tap open no context menu.
- [ ] USB keyboard: Ctrl-Alt-F1..F12, Alt-Tab, Alt-F4, Super, Ctrl-W/R/Shift-I, F5, F11, F12 and Ctrl-Alt-Del give no VT, no login, no devtools, no reload and no exit.
- [ ] A USB stick is not mounted and does not appear in `/dev/sd*` (after enrolment).
- [ ] Short and long presses of the power button do nothing. Only a 10 s hold (firmware) cuts power, and the kiosk boots back to attract with no operator.
- [ ] Pull the power during a session: the kiosk returns to attract, and the outbox keeps the abandoned session (KSK-07).
- [ ] The network cable on a hostile LAN gives only DNS, NTP and the allow-listed endpoints (`nft list ruleset` on the bench before enrolment, then an external port scan after).
- [ ] Booting from USB or PXE is blocked (firmware password set, boot order locked, Secure Boot on).

## Provisioning: boxed to session-ready (KSK-10, target under 20 minutes)

```
 bench (provisioning network)                           API            step-ca
 ────────────────────────────                           ───            ───────
 1 flash   ubuntu-image of the signed model (one image for every kiosk)
 2 boot    first boot: snapd seeds, the gadget applies lockdown defaults, the device gets its brand serial
           (prepare-device), TPM FDE sealed. Frame shows an idle background; kiosk waits (not enrolled).
           A bench USB stick with auto-import.assert (system-user signed by the brand, SSH key for this
           bench session) creates the technician account.
 3 register (technician laptop)
           shriii-provision register --api ... --kiosk-id kiosk-pune-001 --site site-pune-library \
             --site-mode supervised --policy-version 2026.10.1 --app-version 0.1.0 \
             --ca-url https://ca.shriii.internal:9000 --root-ca root_ca.crt \
             --provisioner-key kiosk-enrolment.jwk.json --out kiosk-pune-001.bundle.json
           ── POST /admin/kiosks (device token, once) ──▶
           ── POST /admin/deployments (site, site_mode) ──▶
           mints the one-time step-ca token (15 min) into the 0600 bundle
 4 push    shriii-provision push --bundle kiosk-pune-001.bundle.json --host <kiosk ip> --user tech
           (the bundle travels over SSH on stdin into $SNAP_COMMON/provision/bundle.json; it never appears in argv)
 5 enrol   (kiosk, shriii-kiosk.enrol) checks schema, expiry and root fingerprint against the image pin
           ── CSR + token /1.0/sign ──────────────────────────────────────────▶ 24 h certificate
           writes kiosk-config.json, recipient-keys.json, device.json, secrets/device-token (0600);
           imports the certificate into the NSS DB
           ── GET /healthz, mTLS probe, POST /admin/kiosks/heartbeat (device token) ──▶
           finalises: SSH off, USB storage blacklisted, bench user removed, then reboots
 6 verify  after the reboot: attract loop on screen, heartbeat in the admin fleet view. On a dev host:
           shriii-provision verify --root <dir>.
```

To re-provision a kiosk (new site, a replaced disk, or a revoked certificate), run `register
--rotate-existing` to get a new bundle, then deliver it. On a locked kiosk SSH is off, so a remote
`snap set shriii-kiosk enrolment-bundle=<base64>` through the fleet channel (KSK-10 remote commands) does
the same as `push`.

## CI and signing

`.github/workflows/kiosk-image.yml` runs these steps:

1. Builds the Electron app on the runner, stages it, and builds the app snap and the gadget snap with
   `canonical/action-build` (snapcraft in LXD).
2. Lints both snaps with `snapcraft lint` and the store's `review-tools` (privileged interfaces are expected
   to need store assertions).
3. Renders and validates the model (`shriii-provision model validate --production`) and checks the public
   snap ids against the store.
4. Runs the CLI tests and the PKI smoke test against a real step-ca.

Signing never happens on PRs. The manual `workflow_dispatch` release job signs the model and builds the
image. It needs these repository settings:

| Setting | Kind | Use |
|---|---|---|
| `BRAND_ACCOUNT_ID`, `BRAND_STORE_ID` | variables | model `authority-id` / `brand-id` / `store` |
| `KIOSK_SNAP_ID`, `GADGET_SNAP_ID` | variables | brand-store snap ids (model, gadget connections) |
| `CA_ROOT_FINGERPRINT` | variable | root pin in the gadget (from the ceremony) |
| `SNAP_STORE_PROXY` | variable | `host:port` of the brand snap store proxy (netguard allow-list) |
| `SNAPCRAFT_STORE_CREDENTIALS` | secret | `snapcraft export-login` for upload and the model signing key |
| `MODEL_SIGNING_KEY_NAME` | variable | name of the registered signing key used by `snap sign -k` |
| `MODEL_APIKEY` | secret | serial-vault / model-service key injected into the gadget's prepare-device hook |

Until these exist, the release job stops with a clear message, and PR builds use well-formed placeholder
ids (`render-gadget.sh --placeholders`). Such a gadget must not be flashed.

## Local work

Docker and LXD builds stay off on developer laptops (project rule). Locally you can run the fast checks:

```sh
cd tools/provision && uv sync && uv run pytest -q && uv run ruff check . && uv run mypy
uv run shriii-provision model validate --allow-placeholders ../../infra/kiosk-image/model/shriii-kiosk-pc-24.json
```

On a Linux host with snapcraft and LXD, outside this project's laptops:
`sh infra/kiosk-image/scripts/prepare-app-build.sh && (cd infra/kiosk-image/app && snapcraft pack)`.

## Known gaps

- The runtime has to be checked on hardware: the Wayland and pipewire hand-off, NSS client-certificate
  selection in Electron, and the escape checklist. CI proves the build, the lint and the PKI, not the glass.
- The kiosk daemon runs as root with Chromium's sandbox disabled, inside strict confinement (Canonical's
  Electron-on-Frame pattern). Dropping to `snap_daemon` is a follow-up.
- Zero-touch enrolment (scan a QR token with no bench SSH) needs an enrolment endpoint in the API (backend
  stream). Until then the bench SSH path is used, and remote re-enrolment uses the snap option.
- `firewall-control` and `snapd-control` need store assertions from the brand store (super-privileged
  interfaces). review-tools flags them for manual review, as expected.
