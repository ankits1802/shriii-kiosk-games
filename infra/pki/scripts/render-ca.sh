#!/bin/sh
# Render the step-ca configuration from infra/pki/step-ca/*.tmpl into $CA_DIR.
#
# Inputs (environment):
#   CA_DIR                      step-ca working directory (certs/, templates/, config/, db/)
#   CA_DNS                      CA TLS name (production: ca.<env>.shriii.internal)
#   CA_ADDRESS                  listen address (e.g. :9000)
#   DEVICE_DOMAIN               device identity domain (default shriii.internal)
#   INTERMEDIATE_KEY            file path, or a KMS URI (awskms:key-id=...) when KMS_TYPE is set
#   KMS_TYPE, KMS_REGION        optional: awskms + ap-south-1 in production (intermediate key never leaves KMS)
#   PROVISIONER_PUB_JWK         path to the kiosk-enrolment provisioner public JWK (JSON)
#   PROVISIONER_ENCRYPTED_KEY   path to the encrypted private JWK (JWE, JSON or compact)
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
: "${CA_DIR:?}" "${CA_DNS:?}" "${CA_ADDRESS:?}" "${INTERMEDIATE_KEY:?}"
: "${PROVISIONER_PUB_JWK:?}" "${PROVISIONER_ENCRYPTED_KEY:?}"
DEVICE_DOMAIN="${DEVICE_DOMAIN:-shriii.internal}"

echo "$DEVICE_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || { echo "bad DEVICE_DOMAIN" >&2; exit 1; }
mkdir -p "$CA_DIR/config" "$CA_DIR/templates" "$CA_DIR/db"

enc="$(cat "$PROVISIONER_ENCRYPTED_KEY")"
case "$enc" in
  "{"*) enc="$(printf '%s' "$enc" | step crypto jose format)" ;;
esac

export CA_DIR CA_DNS CA_ADDRESS DEVICE_DOMAIN INTERMEDIATE_KEY
PROVISIONER_ENCRYPTED_KEY_VALUE="$enc"
export PROVISIONER_ENCRYPTED_KEY="$PROVISIONER_ENCRYPTED_KEY_VALUE"

# shellcheck disable=SC2016
envsubst '${CA_DIR} ${CA_DNS} ${CA_ADDRESS} ${DEVICE_DOMAIN} ${INTERMEDIATE_KEY} ${PROVISIONER_ENCRYPTED_KEY}' \
  <"$here/step-ca/ca.json.tmpl" |
  jq --slurpfile jwk "$PROVISIONER_PUB_JWK" '.authority.provisioners[0].key = $jwk[0]' >"$CA_DIR/config/ca.json.new"

if [ -n "${KMS_TYPE:-}" ]; then
  jq --arg type "$KMS_TYPE" --arg region "${KMS_REGION:-ap-south-1}" '.kms = {type: $type, region: $region}' \
    "$CA_DIR/config/ca.json.new" >"$CA_DIR/config/ca.json.kms" && mv "$CA_DIR/config/ca.json.kms" "$CA_DIR/config/ca.json.new"
fi
mv "$CA_DIR/config/ca.json.new" "$CA_DIR/config/ca.json"
chmod 600 "$CA_DIR/config/ca.json"

for tpl in device-leaf intermediate-ca; do
  # shellcheck disable=SC2016
  envsubst '${DEVICE_DOMAIN} ${CA_DNS}' <"$here/step-ca/templates/$tpl.tpl" >"$CA_DIR/templates/$tpl.tpl"
done

# shellcheck disable=SC2016
if grep -q '\${' "$CA_DIR/config/ca.json" "$CA_DIR/templates/device-leaf.tpl"; then
  echo "unrendered placeholders left" >&2
  exit 1
fi
echo "rendered $CA_DIR/config/ca.json"
