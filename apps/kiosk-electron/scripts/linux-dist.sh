#!/bin/sh
# Build the Linux AppImage (and, where snapcraft is available, the snap) from the cross-packaged
# release/linux-unpacked inside a Linux container:
#   docker run --rm -v "$PWD:/app" node:24-trixie-slim sh /app/scripts/linux-dist.sh [AppImage|snap]
set -e
TARGETS="${1:-AppImage}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq git ca-certificates libfuse2t64 squashfs-tools >/dev/null
npm install -g --silent electron-builder@26.15.3
cd /app
chmod +x release/linux-unpacked/shriii-kiosk release/linux-unpacked/chrome_crashpad_handler 2>/dev/null || true
electron-builder --linux $TARGETS --x64 --prepackaged release/linux-unpacked --config electron-builder.yml --publish never
ls -la release
