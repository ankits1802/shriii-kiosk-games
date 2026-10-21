#!/bin/sh
# End-to-end PKI check against a real step-ca (CI only; needs step, step-ca, jq, openssl, uv on PATH):
#   1. throwaway CA from the repository templates, step-ca started on localhost
#   2. shriii-provision enrol (Python) with a provisioner token -> device certificate; identity, EKU, lifetime
#   3. the snap's path: `step ca certificate` with a shriii-provision token (same as kiosk-enrol)
#   4. replayed token and SAN-mismatch token are refused; an invalid kiosk id is refused by the template
#   5. renewal over mTLS (shriii-provision renew)
#   6. revocation: renew is refused afterwards and the serial is on the CRL
set -eu

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
work="${RUNNER_TEMP:-/tmp}/shriii-pki-smoke"
rm -rf "$work"
mkdir -p "$work"
export CA_DIR="$work/ca" CA_DNS=localhost CA_ADDRESS=127.0.0.1:9443 DEVICE_DOMAIN=shriii.internal
CA_URL="https://localhost:9443"
ROOT="$CA_DIR/certs/root_ca.crt"
PROV="$CA_DIR/secrets/kiosk-enrolment.jwk.json"
prov() { uv run --project "$repo/tools/provision" shriii-provision "$@"; }

sh "$repo/infra/pki/scripts/init-dev-ca.sh"
step-ca --password-file "$CA_DIR/secrets/password" "$CA_DIR/config/ca.json" >"$work/step-ca.log" 2>&1 &
ca_pid=$!
trap 'kill $ca_pid 2>/dev/null || true; echo "--- step-ca log"; tail -n 40 "$work/step-ca.log"' EXIT
for _ in $(seq 1 30); do
  curl -fsS --cacert "$ROOT" "$CA_URL/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --cacert "$ROOT" "$CA_URL/health"
echo

fp=$(step certificate fingerprint "$ROOT")

echo "== 2. Python enrolment"
token=$(prov token --ca-url "$CA_URL" --provisioner-key "$PROV" --subject kiosk-ci-001 --root-ca "$ROOT" --ttl 600)
jq -n --arg ott "$token" --arg fp "$fp" --rawfile root "$ROOT" --arg ca "$CA_URL" '{
  schema: "shriii.enrolment-bundle/v1", created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  kiosk_id: "kiosk-ci-001", site_id: "site-ci", site_mode: "supervised", study_id: null, deployment_id: "d-ci",
  policy_version: "ci", app_version: "0.0.0", ring: "lab", api_origin: "https://api.example.invalid",
  device_token: "kdt_ci", recipient_keys: [{kid: "k", public_key: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", not_before: "2026-01-01T00:00:00Z", not_after: null}],
  ca: {url: $ca, root_fingerprint: $fp, root_pem: $root, provisioner: "kiosk-enrolment", domain: "shriii.internal", ott: $ott},
  config: {printer: {kind: "virtual"}, update: {}}, lockdown: {}
}' >"$work/bundle.json"
prov enrol --bundle "$work/bundle.json" --root "$work/device" --pinned-root-fingerprint "$fp"
leaf="$work/device/tls/device.crt"
# Fields kiosk-enrol and cert-reimport read from `step certificate inspect --format json`:
step certificate inspect "$leaf" --format json >"$work/leaf.json"
jq -e '(.serial_number | type) == "string" and (.validity.end | type) == "string"' "$work/leaf.json" >/dev/null || {
  echo "unexpected step inspect JSON:"; jq 'del(.signature)' "$work/leaf.json"; exit 1; }
text=$(openssl x509 -in "$leaf" -noout -nameopt RFC2253 -subject -ext subjectAltName,extendedKeyUsage,basicConstraints)
echo "$text"
expect() { echo "$text" | grep -q -- "$1" || { echo "missing in leaf: $1"; exit 1; }; }
expect "subject=CN=kiosk-ci-001"
expect "DNS:kiosk-ci-001.kiosk.shriii.internal"
expect "URI:spiffe://shriii.internal/kiosk/kiosk-ci-001"
expect "TLS Web Client Authentication"
expect "CA:FALSE"
if echo "$text" | grep -q "TLS Web Server Authentication"; then echo "leaf must not allow serverAuth"; exit 1; fi
start=$(date -d "$(openssl x509 -in "$leaf" -noout -startdate | cut -d= -f2)" +%s)
end=$(date -d "$(openssl x509 -in "$leaf" -noout -enddate | cut -d= -f2)" +%s)
[ $((end - start)) -le $((24 * 3600 + 120)) ] || { echo "certificate lifetime exceeds 24 h"; exit 1; }
step certificate verify "$work/device/tls/chain.crt" --roots "$ROOT"
echo "ok: identity, EKU clientAuth only, lifetime <= 24 h, chains to root"

echo "== 3. step CLI enrolment (snap path)"
token=$(prov token --ca-url "$CA_URL" --provisioner-key "$PROV" --subject kiosk-ci-002 --root-ca "$ROOT")
step ca certificate kiosk-ci-002 "$work/step.crt" "$work/step.key" --token "$token" --ca-url "$CA_URL" \
  --root "$ROOT" --kty EC --curve P-256 --force
openssl x509 -in "$work/step.crt" -noout -ext subjectAltName | grep -q "URI:spiffe://shriii.internal/kiosk/kiosk-ci-002"
echo "ok: step ca certificate with a shriii-provision token"

echo "== 4. refusals"
if step ca certificate kiosk-ci-002 "$work/replay.crt" "$work/replay.key" --token "$token" --ca-url "$CA_URL" --root "$ROOT" --force 2>/dev/null; then
  echo "replayed token was accepted"; exit 1
fi
bad=$(prov token --ca-url "$CA_URL" --provisioner-key "$PROV" --subject kiosk-ci-003 --san api.shriii.internal)
# A token carrying a foreign SAN (only a provisioner-key holder can mint one) still yields only the kiosk
# identity: the device template rebuilds the SANs from the subject, so api.shriii.internal never appears.
if step ca certificate kiosk-ci-003 "$work/bad.crt" "$work/bad.key" --token "$bad" --ca-url "$CA_URL" --root "$ROOT" --force 2>/dev/null; then
  sans=$(openssl x509 -in "$work/bad.crt" -noout -ext subjectAltName)
  echo "$sans"
  if echo "$sans" | grep -q "api.shriii.internal"; then echo "foreign SAN reached a certificate"; exit 1; fi
  echo "$sans" | grep -q "DNS:kiosk-ci-003.kiosk.shriii.internal, URI:spiffe://shriii.internal/kiosk/kiosk-ci-003" \
    || { echo "template did not enforce the kiosk identity"; exit 1; }
fi
bad=$(prov token --ca-url "$CA_URL" --provisioner-key "$PROV" --subject "Kiosk_Bad" --san Kiosk_Bad.kiosk.shriii.internal)
if step ca certificate "Kiosk_Bad" "$work/bad2.crt" "$work/bad2.key" --token "$bad" --ca-url "$CA_URL" --root "$ROOT" --force 2>/dev/null; then
  echo "invalid kiosk id was accepted"; exit 1
fi
echo "ok: replay and invalid kiosk ids refused; foreign SANs never reach a certificate"

echo "== 5. renewal over mTLS"
before=$(jq -r .certificate_serial "$work/device/device.json")
prov renew --root "$work/device"
after=$(jq -r .certificate_serial "$work/device/device.json")
[ "$before" != "$after" ] || { echo "serial did not change on renewal"; exit 1; }
echo "ok: renewed ($before -> $after)"

echo "== 6. revocation"
prov revoke --ca-url "$CA_URL" --provisioner-key "$PROV" --root-ca "$ROOT" --serial "$after"
if prov renew --root "$work/device"; then
  echo "revoked certificate renewed"; exit 1
fi
sleep 2
curl -fsS --cacert "$ROOT" "$CA_URL/1.0/crl" -o "$work/crl.der"
# Compare serials as integers (openssl pads hex serials with a leading 00 when the high bit is set).
uv run --project "$repo/tools/provision" python - "$work/crl.der" "$after" <<'EOF' || {
import sys
from cryptography import x509

crl = x509.load_der_x509_crl(open(sys.argv[1], "rb").read())
serials = {r.serial_number for r in crl}
print(f"CRL: {len(serials)} revoked serial(s), next update {crl.next_update_utc}")
sys.exit(0 if int(sys.argv[2]) in serials else 1)
EOF
  openssl crl -inform DER -in "$work/crl.der" -noout -text; echo "serial $after not on the CRL"; exit 1; }
echo "ok: revoked certificate cannot renew and is on the CRL"
echo "PKI smoke passed"
