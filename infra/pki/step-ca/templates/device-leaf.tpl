{{- /*
  SHRIII kiosk device certificate (PRV-07, KSK-10). The identity is derived ONLY from the one-time token's
  subject (the kiosk id), which only the kiosk-enrolment provisioner key holder can mint:
    CN  = <kiosk id>
    DNS = <kiosk id>.kiosk.${DEVICE_DOMAIN}
    URI = spiffe://${DEVICE_DOMAIN}/kiosk/<kiosk id>
  Client authentication only; never a CA; never a server certificate.
  On renewal step-ca re-uses the existing certificate's identity, so the template is not re-evaluated.
*/ -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9-]{1,63}$" .Token.sub) }}
{{- fail "kiosk id must match ^[a-z0-9][a-z0-9-]{1,63}$" }}
{{- end }}
{
  "subject": {
    "commonName": {{ toJson .Token.sub }},
    "organization": ["SHRIII"],
    "organizationalUnit": ["kiosk"]
  },
  "sans": [
    {"type": "dns", "value": {{ printf "%s.kiosk.${DEVICE_DOMAIN}" .Token.sub | toJson }}},
    {"type": "uri", "value": {{ printf "spiffe://${DEVICE_DOMAIN}/kiosk/%s" .Token.sub | toJson }}}
  ],
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["clientAuth"],
  "basicConstraints": {"isCA": false}
}
