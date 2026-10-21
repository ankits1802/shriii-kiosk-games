{{- /*
  SHRIII kiosk issuing (intermediate) CA, signed by the offline root during the ceremony (CEREMONY.md).
  Name constraints limit it to kiosk device identities and the CA's own TLS name: a stolen intermediate
  cannot mint certificates for the API, the web app or anything else.
*/ -}}
{
  "subject": {{ toJson .Subject }},
  "keyUsage": ["certSign", "crlSign"],
  "basicConstraints": {
    "isCA": true,
    "maxPathLen": 0
  },
  "nameConstraints": {
    "critical": true,
    "permittedDNSDomains": [".kiosk.${DEVICE_DOMAIN}", "${CA_DNS}"],
    "permittedURIDomains": ["${DEVICE_DOMAIN}"]
  }
}
