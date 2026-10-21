#!/bin/sh
# Render gadget/gadget.yaml from gadget.yaml.in with brand-store values from the environment.
#
#   KIOSK_SNAP_ID, GADGET_SNAP_ID     brand-store snap ids (32 chars)
#   FRAME_SNAP_ID, PIPEWIRE_SNAP_ID   default to the public Canonical ids
#   CA_ROOT_FINGERPRINT                                               SHA-256 of the SHRIII root CA
#   SNAP_STORE_PROXY                                                  host:port of the store proxy (may be empty)
#
# PR builds (no brand store yet) pass --placeholders: well-formed dummy ids so the gadget packs and lints;
# such a gadget must never be used in an image (the release job refuses dummy ids).
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
# Canonical-published snaps: public, stable store ids.
: "${FRAME_SNAP_ID:=BPZbvWzvoMTrpec4goCXlckLe2IhfthK}"     # ubuntu-frame
: "${PIPEWIRE_SNAP_ID:=cXXVv4NGwXqlxTVSdrjsuvrPGAHfRSRs}"  # pipewire (audio-playback slot)
dummy=0
[ "${1:-}" = "--placeholders" ] && dummy=1

if [ "$dummy" = 1 ]; then
  : "${KIOSK_SNAP_ID:=SHRIIIKIOSKxxxxxxxxxxxxxxxxxxxxx}"
  : "${GADGET_SNAP_ID:=SHRIIIGADGETxxxxxxxxxxxxxxxxxxxx}"
  : "${CA_ROOT_FINGERPRINT:=0000000000000000000000000000000000000000000000000000000000000000}"
  : "${SNAP_STORE_PROXY:=}"
fi

for var in KIOSK_SNAP_ID GADGET_SNAP_ID FRAME_SNAP_ID PIPEWIRE_SNAP_ID; do
  eval "value=\${$var:-}"
  # shellcheck disable=SC2154
  echo "$value" | grep -Eq '^[A-Za-z0-9]{32}$' || { echo "$var must be a 32-character snap id" >&2; exit 1; }
done
echo "${CA_ROOT_FINGERPRINT:-}" | grep -Eq '^[0-9a-f]{64}$' || { echo "CA_ROOT_FINGERPRINT must be 64 hex chars" >&2; exit 1; }
if [ "$dummy" = 0 ] && echo "$KIOSK_SNAP_ID$GADGET_SNAP_ID$FRAME_SNAP_ID$PIPEWIRE_SNAP_ID" | grep -q 'xxxxxxxx'; then
  echo "refusing placeholder snap ids outside --placeholders" >&2
  exit 1
fi

export KIOSK_SNAP_ID GADGET_SNAP_ID FRAME_SNAP_ID PIPEWIRE_SNAP_ID CA_ROOT_FINGERPRINT SNAP_STORE_PROXY
# shellcheck disable=SC2016
envsubst '${KIOSK_SNAP_ID} ${GADGET_SNAP_ID} ${FRAME_SNAP_ID} ${PIPEWIRE_SNAP_ID} ${CA_ROOT_FINGERPRINT} ${SNAP_STORE_PROXY}' \
  <"$here/gadget/gadget.yaml.in" >"$here/gadget/gadget.yaml"
if grep -q '\${' "$here/gadget/gadget.yaml"; then
  echo "unrendered placeholders left in gadget.yaml" >&2
  exit 1
fi
echo "rendered $here/gadget/gadget.yaml"
