#!/bin/sh
# Stage the Electron kiosk build for the snap: build the renderer + main process, run electron-builder
# `--linux dir` (fuses flipped, asar integrity, no installer, unsigned) and copy release/linux-unpacked into
# infra/kiosk-image/app/build/ together with version.txt. Linux only; used by CI before canonical/action-build.
#
#   sh infra/kiosk-image/scripts/prepare-app-build.sh [--skip-electron-build]
set -eu

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$repo/frontend/apps/kiosk-electron"
out="$repo/infra/kiosk-image/app/build"

if [ "${1:-}" != "--skip-electron-build" ]; then
  (
    cd "$app"
    node scripts/build.mjs --with-renderer
    CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --linux dir --x64 \
      --config electron-builder.yml --publish never
  )
fi

test -x "$app/release/linux-unpacked/shriii-kiosk" || { echo "missing $app/release/linux-unpacked" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
cp -a "$app/release/linux-unpacked" "$out/linux-unpacked"

version=$(node -p "require('$app/package.json').version")
sha=$(git -C "$repo" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)
# Snap versions: max 32 chars, [A-Za-z0-9.+~-].
printf '%s+git%s\n' "$version" "$sha" | cut -c1-32 >"$out/version.txt"
echo "staged $(cat "$out/version.txt") into $out"
