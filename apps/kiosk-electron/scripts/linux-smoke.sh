#!/bin/sh
# Smoke-test the Linux build (release/linux-unpacked) in a clean Debian container under Xvfb.
#   docker run --rm -v "$PWD:/app" node:24-trixie-slim sh /app/scripts/linux-smoke.sh
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxshmfence1 \
  libdrm2 libxkbcommon0 libatk-bridge2.0-0t64 libcups2t64 >/dev/null
cd /app
# Executable bits are lost when the build was cross-packaged on Windows.
chmod +x release/linux-unpacked/shriii-kiosk release/linux-unpacked/chrome_crashpad_handler 2>/dev/null || true
xvfb-run -a -s "-screen 0 1280x800x24" node scripts/smoke.mjs --exe release/linux-unpacked/shriii-kiosk -- --no-sandbox
