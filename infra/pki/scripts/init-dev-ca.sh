#!/bin/sh
# Throwaway two-tier CA for development and CI (NEVER for kiosks in the field: production roots come from
# the ceremony in CEREMONY.md and the intermediate key lives in AWS KMS).
#
#   CA_DIR=/tmp/shriii-ca CA_DNS=localhost CA_ADDRESS=127.0.0.1:9443 sh infra/pki/scripts/init-dev-ca.sh
#   step-ca --password-file $CA_DIR/secrets/password $CA_DIR/config/ca.json
#
# Produces: certs/root_ca.crt, certs/intermediate_ca.crt (name-constrained), secrets/* (password, keys,
# the decrypted kiosk-enrolment JWK for shriii-provision), config/ca.json, templates/*.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
CA_DIR="${CA_DIR:-$PWD/.dev-ca}"
CA_DNS="${CA_DNS:-localhost}"
CA_ADDRESS="${CA_ADDRESS:-127.0.0.1:9443}"
DEVICE_DOMAIN="${DEVICE_DOMAIN:-shriii.internal}"
export CA_DIR CA_DNS CA_ADDRESS DEVICE_DOMAIN

umask 077
mkdir -p "$CA_DIR/certs" "$CA_DIR/secrets" "$CA_DIR/templates"
pw="$CA_DIR/secrets/password"
[ -s "$pw" ] || head -c 32 /dev/urandom | base64 >"$pw"

# Intermediate template first (needs CA_DNS / DEVICE_DOMAIN).
# shellcheck disable=SC2016
envsubst '${DEVICE_DOMAIN} ${CA_DNS}' <"$here/step-ca/templates/intermediate-ca.tpl" >"$CA_DIR/templates/intermediate-ca.tpl"

step certificate create "SHRIII Dev Root CA" "$CA_DIR/certs/root_ca.crt" "$CA_DIR/secrets/root_ca_key" \
  --profile root-ca --kty EC --curve P-256 --not-after 87600h \
  --password-file "$pw" --force
step certificate create "SHRIII Dev Kiosk Issuing CA" "$CA_DIR/certs/intermediate_ca.crt" "$CA_DIR/secrets/intermediate_ca_key" \
  --template "$CA_DIR/templates/intermediate-ca.tpl" --kty EC --curve P-256 --not-after 43800h \
  --ca "$CA_DIR/certs/root_ca.crt" --ca-key "$CA_DIR/secrets/root_ca_key" --ca-password-file "$pw" \
  --password-file "$pw" --force

step crypto jwk create "$CA_DIR/secrets/kiosk-enrolment.pub.json" "$CA_DIR/secrets/kiosk-enrolment.priv.json" \
  --kty EC --curve P-256 --use sig --password-file "$pw" --force
step crypto jwe decrypt --password-file "$pw" <"$CA_DIR/secrets/kiosk-enrolment.priv.json" \
  >"$CA_DIR/secrets/kiosk-enrolment.jwk.json"

INTERMEDIATE_KEY="$CA_DIR/secrets/intermediate_ca_key" \
PROVISIONER_PUB_JWK="$CA_DIR/secrets/kiosk-enrolment.pub.json" \
PROVISIONER_ENCRYPTED_KEY="$CA_DIR/secrets/kiosk-enrolment.priv.json" \
  sh "$here/scripts/render-ca.sh"

echo "root fingerprint: $(step certificate fingerprint "$CA_DIR/certs/root_ca.crt")"
