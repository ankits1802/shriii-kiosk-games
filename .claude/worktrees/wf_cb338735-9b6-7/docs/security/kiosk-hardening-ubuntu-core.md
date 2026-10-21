# Secure kiosk hardening guide (Ubuntu Core 24)

Implements the design for KSK-09 (OS lockdown and tamper resistance), and supports KSK-01, KSK-07, KSK-10,
KSK-11, KSK-12 and PRV-07. Threats addressed: K-01 to K-14 in [threat-model.md](threat-model.md).
Pass criteria: the KSK-09 escape checklist and [pentest-checklist.md](pentest-checklist.md) §1.

Status: **design guide**. The wave-1 kiosk runs as a browser build plus an Electron scaffold; none of the
image work below exists yet. Commands are given for Ubuntu Core 24 with snapd 2.6x; verify each against the
current Canonical documentation when the image is built, and record the final model assertion and
validation set in the PLT-09 governance repository.

## 1. Target state (summary)

| Layer | Requirement |
|---|---|
| Hardware | Single reference SKU (KSK-08) with TPM 2.0, UEFI Secure Boot, firmware admin password, no boot from external media, chassis intrusion switch, ports inside a locked IK08 enclosure |
| Boot and disk | Ubuntu Core full-disk encryption sealed to the TPM against the secure-boot chain (measured boot); recovery keys escrowed offline per device |
| OS | Ubuntu Core 24 with a **dangerous=false, signed brand model**; only the gadget, kernel, base, `ubuntu-frame` and the kiosk app snap; no SSH in production; no console login |
| App | Electron app as a **strictly confined** snap running under `ubuntu-frame` (Wayland kiosk compositor); only the snap interfaces listed in §5 |
| Network | Outbound only: API host (443, mTLS), step-ca, NTP, snap store proxy. No inbound ports. Wi-Fi/LTE credentials provisioned per site |
| Updates | Snap store via a **brand store / dedicated snap store proxy** with **validation sets** pinning exact revisions; rings lab → 1 kiosk → 10% → all (KSK-11) |
| Keys | mTLS private key and device signing key generated on the device and kept in the TPM (non-exportable); device token in TPM-sealed storage, never in the app bundle |
| Monitoring | 60 s heartbeat (KSK-10) incl. tamper switch, secure-boot state, FDE state, snap revisions, clock offset |

## 2. Hardware and firmware

1. Choose a SKU whose firmware supports: UEFI Secure Boot with custom keys, TPM 2.0 (discrete or firmware),
   disabling USB boot and PXE, a supervisor password, and chassis intrusion reporting. Record the firmware
   version in `session.context` (KSK-08 AC).
2. Firmware settings (apply with the vendor's provisioning tool so they are reproducible):
   - set the supervisor/admin password (unique per device, stored in the fleet secret store);
   - boot order: internal disk only; disable USB boot, PXE, legacy/CSM, Thunderbolt pre-boot, and boot menu
     hotkeys;
   - enable Secure Boot (Microsoft UEFI CA for the Canonical shim, or enrol your own keys if the vendor
     supports it) and the TPM;
   - disable unused radios (Bluetooth unless needed), the camera device if present (no camera use is allowed:
     BUILD_DECISIONS non-negotiable 5), and wake-on-LAN;
   - enable chassis intrusion detection; configure the response to "log and require password".
3. Enclosure: IK08 or better; all USB, HDMI and Ethernet ports inside the locked enclosure; fit USB port
   blockers on unused internal ports; route the headset jack and printer through the enclosure only; tamper
   switch wired to a GPIO or USB input readable by the app snap; privacy filter film on the touchscreen
   (KSK-12); key-locked power button.
4. Keep a per-device record: serial, TPM EK certificate hash, firmware password reference, recovery key
   reference, site, ring.

## 3. Image: model assertion and gadget

Create a brand account and signing key (offline, two-person custody per PLT-09). Model assertion sketch:

```json
{
  "type": "model",
  "series": "16",
  "authority-id": "<brand-id>",
  "brand-id": "<brand-id>",
  "model": "shriii-kiosk-24",
  "base": "core24",
  "grade": "signed",
  "storage-safety": "encrypted",
  "store": "<brand-store-id>",
  "snaps": [
    { "name": "pc", "type": "gadget", "default-channel": "24/stable", "id": "<gadget-snap-id>" },
    { "name": "pc-kernel", "type": "kernel", "default-channel": "24/stable", "id": "<kernel-snap-id>" },
    { "name": "core24", "type": "base", "default-channel": "latest/stable", "id": "<core24-id>" },
    { "name": "snapd", "type": "snapd", "default-channel": "latest/stable", "id": "<snapd-id>" },
    { "name": "ubuntu-frame", "type": "app", "default-channel": "24/stable", "id": "<frame-id>" },
    { "name": "shriii-kiosk", "type": "app", "default-channel": "stable", "id": "<app-snap-id>" }
  ],
  "timestamp": "<RFC3339>"
}
```

Key choices:
- `grade: signed` (never `dangerous`): only store-signed snaps install; no sideloading.
- `storage-safety: encrypted`: installation fails if TPM-backed FDE cannot be set up.
- Use a **custom gadget snap** (fork of `pc`) to set defaults (below), disable the serial console in the
  kernel command line for production (`console=` removed or set to a non-exposed device), and ship
  `prepare-device` hooks for serial-vault enrolment.
- Build with `ubuntu-image snap model.signed`; store the image hash in the IRB pack (PRV-11).

Gadget `defaults` (system and snap configuration at first boot):

```yaml
defaults:
  system:
    service:
      ssh:
        disable: true            # no SSH in production images
      console-conf:
        disable: true            # no interactive first-boot console
    refresh:
      timer: "mon-fri,02:00-04:00"   # outside site hours; app refreshes only apply in attract (KSK-11)
      retain: 2
    system:
      timezone: Asia/Kolkata
      power-key-action: ignore
      disable-backlight-service: false
    homedirs: ""
  <ubuntu-frame-snap-id>:
    daemon: true
    config: |
      [display]
      cursor=null
  <shriii-kiosk-snap-id>:
    daemon: true
```

Disable the snapd REST API for anything except root (default) and do not install `snapd-control` consumers.

## 4. Disk encryption and keys

- Ubuntu Core FDE seals the volume keys to the TPM with PCR policies over the secure-boot chain; a modified
  bootloader, kernel or boot from other media yields no key (pentest 1.3, 1.4).
- Store the **recovery key** for each device in the fleet secret store, never on the device or on paper at
  the site. Using it is a logged break-glass event.
- App secrets:
  - mTLS key and device signing key: generate on the device inside the TPM (`tpm2-pkcs11` or the snap's
    TPM access), create a CSR, enrol with step-ca (KSK-10). Keys are non-exportable, so a cloned disk image
    cannot authenticate (K-13).
  - Device token (`kdt_...`): delivered at enrolment, stored sealed to the TPM (or in an encrypted file whose
    key is TPM-sealed); never in `VITE_*` variables or the app bundle.
  - Per-session DEKs: generated per session, sealed to the backend X25519 public key for upload and to the TPM
    for local purge (KSK-07). After upload acknowledgement and the grace period, the local DEK copy is
    destroyed.
- Pin the backend and step-ca CA certificates in the app (T-02).

## 5. App snap confinement

Snapcraft (sketch):

```yaml
name: shriii-kiosk
base: core24
confinement: strict
grade: stable
apps:
  shriii-kiosk:
    daemon: simple
    restart-condition: always
    command-chain: [bin/wayland-launch]
    command: bin/kiosk --ozone-platform=wayland
    plugs:
      - wayland              # display via ubuntu-frame
      - opengl
      - audio-playback       # speakers + headset
      - audio-record         # only for VOX-04 prompt windows; connected only where policy allows ASR
      - network              # outbound only
      - hardware-observe     # self-test (KSK-08), read-only
      - raw-usb              # ESC/POS printer and touch controller ONLY if no narrower interface exists
      - tpm                  # mTLS/device keys
      - shutdown             # scheduled restart
```

Rules:
- Do **not** connect: `home`, `removable-media`, `camera`, `x11`, `desktop`, `network-bind`, `ssh-keys`,
  `system-files`, `snapd-control`, `process-control`, `browser-support` with `allow-sandbox: false`.
- Prefer `serial-port` or a vendor-specific interface over `raw-usb` for the printer; if `raw-usb` is
  unavoidable, constrain with udev rules in the gadget to the printer and touch vendor/product IDs.
- `audio-record` is connected only on kiosks whose signed policy enables ASR (`asr_enabled`), and the app
  still opens the stream only in consented prompt windows (PRV-03).
- Electron flags: keep `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; set Electron
  **fuses** at package time: `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`,
  `EnableNodeCliInspectArguments=false`, `EnableEmbeddedAsarIntegrityValidation=true`,
  `OnlyLoadAppFromAsar=true`, `EnableCookieEncryption=true` (SF-09).
- Logs: journald with size caps; the app logs no participant data; "pull scrubbed logs" (KSK-10) applies a
  scrubber before upload.

## 6. Input devices and USB

- **USB storage:** no `removable-media` plug, no automount (Ubuntu Core has no desktop automounter); add a
  udev rule in the gadget that ignores the `usb-storage` and `uas` drivers:
  `ACTION=="add", SUBSYSTEM=="usb", DRIVERS=="usb-storage", ATTR{authorized}="0"`.
- **HID allow-list:** authorise only the touch controller (and the NFC reader if fitted) by vendor/product ID
  using USBGuard-style rules or a udev rule that sets `authorized=0` for any other HID. This blocks
  rubber-ducky keyboards (K-03).
- **Keyboard shortcuts:** `ubuntu-frame` has no VT switching for the app user; also disable VT switching in
  the kernel command line (`vt.global_cursor_default=0`, no getty on tty1-6 in production).
- **Touch gestures:** Frame does not implement desktop edge gestures; the Electron app blocks pinch-zoom
  (`setVisualZoomLevelLimits(1,1)`), right-click, text selection and swipe navigation (KSK-01).
- **Presence sensor:** non-imaging mmWave only; it may trigger the greeting but never starts a session
  (KSK-03).

## 7. Network

- Firewall: Ubuntu Core does not ship ufw as a snap by default; use the gadget's netplan config plus an
  nftables configuration delivered through a small confined "netfilter" snap with the `firewall-control`
  interface, allowing outbound 443 (API, step-ca, snap proxy) and 123/udp (NTP) only, no inbound.
- DNS: use DNS-over-TLS to a resolver you control where the venue network allows; certificate pinning in the
  app makes DNS hijack non-fatal (T-02).
- Time: `systemd-timesyncd` to two NTP sources; the server never trusts kiosk wall time for ordering
  (ING-02), and the heartbeat reports the offset (KSK-10).
- Wi-Fi credentials per site in netplan; prefer an LTE modem with a private APN for open sites.

## 8. Updates and rings (KSK-11)

- Host a **snap store proxy** (or brand store) and publish the app to `stable` only from CI with provenance
  (see [supply-chain-policy.md](supply-chain-policy.md)).
- Use **validation sets** to pin exact revisions of every snap per ring and per frozen wave; a wave freeze is a
  validation set that does not change until the wave ends.
- Refresh window outside site hours; the app defers restarts until attract (`snap refresh --hold` controlled
  by the app through the snapd `refresh-app-awareness` mechanism).
- Health check after refresh; snapd reverts automatically if the app fails to start; record the revision in
  the heartbeat.
- Content, dictionary, policy and release packs are separate signed manifests verified by the app (C-23);
  reject unsigned or older versions.

## 9. Provisioning (KSK-10)

1. Flash the signed image at the depot (not at the site).
2. First boot: FDE sealing, `prepare-device` hook obtains a serial assertion from your serial vault, app
   generates TPM keys and shows an enrolment QR.
3. An operator scans the QR with the fleet tool; the backend binds kiosk id, site and policy, issues the
   step-ca certificate and device token (`POST /api/v1/admin/kiosks`), and records the TPM EK hash.
4. Run the boot self-test and the KSK-09 escape checklist; seal the enclosure; record the seal number.
5. Target: boxed to session-ready in under 20 minutes (KSK-10 AC).

## 10. Operations, decommissioning and incidents

- **Remote commands** (KSK-10): lock, wipe, restart, pull scrubbed logs, sync. A remote wipe destroys the TPM
  key handles (crypto-erase) and then the outbox.
- **Stolen kiosk** (PRV-10 drill): revoke the step-ca certificate and device token immediately
  (`POST /api/v1/admin/kiosks/{id}/revoke`), mark its unsynced sessions as lost in the incident record,
  assess exposure (FDE + sealed DEKs mean no readable data if the TPM chain holds), notify per the DPDP runbook.
- **Tamper switch** event: kiosk shows out-of-service, stops new sessions, alerts fleet operations; a field
  visit re-seals and re-verifies secure-boot state before returning to service.
- **Decommission**: remote wipe, clear the TPM (`tpm2_clear` with platform auth from firmware), remove from
  the brand store device list, revoke credentials, record in the asset register.

## 11. Verification checklist (KSK-09 AC)

| Check | How |
|---|---|
| Secure boot on, FDE active | `snap model --assertion`; `snap debug boot-vars`; heartbeat fields |
| Only expected snaps and interfaces | `snap list`; `snap connections shriii-kiosk` matches §5 |
| No SSH, no console login | port scan from the LAN; check tty1-6 with a USB keyboard (should be ignored by the HID allow-list) |
| USB storage and unknown HID refused | pentest 1.2 |
| Escape checklist | pentest 1.1 |
| Power loss returns to attract without operator action | pull power 10× (KSK-09 AC) |
| Reproducible provisioning | provision two clean devices from the same image and compare `snap list` and validation set |
