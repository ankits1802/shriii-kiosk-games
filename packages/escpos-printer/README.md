# @shriii/escpos-printer

80 mm (576-dot, 203 dpi) ESC/POS raster printing of the one-page picture report (REP-02, KSK-08).

- **Image pipeline:** RGBA → gray (alpha on white, levels, gamma for dot gain) → area-average
  resize to the head width → dithering (`atkinson` default, `floyd-steinberg` serpentine,
  `threshold`).
- **Raster:** `GS v 0` in bands (default 128 rows) inside `ESC @`, centre, feed and partial cut.
- **QR:** rendered as raster dots with a 4-module quiet zone (no firmware QR command), verified by
  decoding the printed page with jsQR in tests.
- **Status:** `DLE EOT 1..4` decoded (offline, cover open, paper near end / out, cutter and other
  errors). `printReport` checks before printing (no print when paper is out → the kiosk shows the
  QR on screen instead) and after (roll ran out mid-print); paper-near-end is reported for the
  heartbeat but does not block.
- **Transports:** `NetworkTransport` (raw TCP 9100), `DeviceFileTransport` (Linux usblp
  `/dev/usb/lp0` or a configured tty), `StreamTransport` (any Duplex, e.g. `serialport`), and
  `VirtualPrinter`, which interprets the byte stream, simulates paper/sensors and writes each cut
  page as a PNG.
- Jobs are serialised per printer.

```ts
const printer = new ThermalPrinter(new NetworkTransport({ host: '192.168.1.50' }));
const result = await printer.printReport({ image: { width, height, data: rgba }, qrUrl });
if (!result.ok && result.reason === 'paper_out') showQrOnScreen();
```
