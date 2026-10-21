# shellcheck shell=sh disable=SC2034
# Shared helpers for the shriii-kiosk snap scripts. Sourced, never executed.
#
# Device root: $SNAP_COMMON (survives refreshes and reverts; the outbox must never roll back with a revert).
# Layout matches tools/provision/src/shriii_provision/device_config.py.

: "${SNAP:?}" "${SNAP_COMMON:?}"

SHRIII_ROOT="$SNAP_COMMON"
CONFIG_FILE="$SHRIII_ROOT/kiosk-config.json"
RECIPIENT_KEYS_FILE="$SHRIII_ROOT/recipient-keys.json"
DEVICE_RECORD_FILE="$SHRIII_ROOT/device.json"
TOKEN_FILE="$SHRIII_ROOT/secrets/device-token"
TLS_DIR="$SHRIII_ROOT/tls"
KEY_FILE="$TLS_DIR/device.key"
CERT_FILE="$TLS_DIR/device.crt"
CHAIN_FILE="$TLS_DIR/chain.crt"
ROOT_FILE="$TLS_DIR/root_ca.crt"
PROVISION_DIR="$SHRIII_ROOT/provision"
BUNDLE_FILE="$PROVISION_DIR/bundle.json"
KIOSK_HOME="$SHRIII_ROOT/home"
NSS_DB="sql:$KIOSK_HOME/.pki/nssdb"
NSS_NICKNAME="shriii-device"
SNAPD_SOCKET=/run/snapd.socket

export PATH="$SNAP/usr/sbin:$SNAP/usr/bin:$SNAP/sbin:$SNAP/bin:$PATH"
export LD_LIBRARY_PATH="$SNAP/usr/lib/${SNAP_LAUNCHER_ARCH_TRIPLET:-x86_64-linux-gnu}:${LD_LIBRARY_PATH:-}"

log() {
  # journald adds timestamps; keep lines short and free of secrets.
  echo "[$(basename "$0")] $*"
}

die() {
  log "ERROR: $*"
  exit 1
}

is_enrolled() {
  [ -s "$CONFIG_FILE" ] && [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ]
}

# Block until a file exists (inotify with a polling fallback).
wait_for_file() {
  while [ ! -s "$1" ]; do
    mkdir -p "$(dirname "$1")"
    inotifywait -qq -t 60 -e create -e moved_to -e close_write "$(dirname "$1")" 2>/dev/null || true
  done
}

# snapd REST over the unix socket (needs the snapd-control plug).
snapd_api() {
  method="$1"
  path="$2"
  body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS --unix-socket "$SNAPD_SOCKET" -X "$method" -H 'Content-Type: application/json' \
      -d "$body" "http://localhost$path"
  else
    curl -fsS --unix-socket "$SNAPD_SOCKET" -X "$method" "http://localhost$path"
  fi
}

# Wait for an asynchronous snapd change to finish.
snapd_wait_change() {
  change_id="$1"
  for _ in $(seq 1 120); do
    status=$(snapd_api GET "/v2/changes/$change_id" | jq -r '.result.status')
    case "$status" in
      Done) return 0 ;;
      Error | Undone | Hold) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

# (Re-)import the device certificate and key into the Chromium NSS DB the Electron runtime uses for mTLS.
nss_import_device_cert() {
  mkdir -p "$KIOSK_HOME/.pki/nssdb"
  chmod 700 "$KIOSK_HOME" "$KIOSK_HOME/.pki" "$KIOSK_HOME/.pki/nssdb"
  if [ ! -f "$KIOSK_HOME/.pki/nssdb/cert9.db" ]; then
    certutil -N --empty-password -d "$NSS_DB"
  fi
  p12="$(mktemp "$TLS_DIR/.device.XXXXXX.p12")"
  # shellcheck disable=SC2064
  trap "rm -f '$p12'" EXIT INT TERM
  openssl pkcs12 -export -in "$CERT_FILE" -inkey "$KEY_FILE" -name "$NSS_NICKNAME" -passout pass: -out "$p12"
  while certutil -L -d "$NSS_DB" -n "$NSS_NICKNAME" >/dev/null 2>&1; do
    certutil -D -d "$NSS_DB" -n "$NSS_NICKNAME" || break
  done
  pk12util -i "$p12" -d "$NSS_DB" -W '' >/dev/null
  rm -f "$p12"
  trap - EXIT INT TERM
  # Trust the SHRIII root for the CA endpoints (the API uses a public certificate).
  certutil -A -d "$NSS_DB" -n shriii-root -t "C,," -i "$ROOT_FILE" 2>/dev/null || true
}

json_get() {
  jq -er "$1" "$2"
}
