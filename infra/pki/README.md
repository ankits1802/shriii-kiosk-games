# infra/pki: kiosk device PKI (step-ca)

Kiosk mTLS identities for PRV-07 and KSK-10. Every kiosk holds a short-lived X.509 client certificate from
the SHRIII step-ca. The device generates and keeps its own key. The certificate is renewed automatically and
can be revoked.

| Path | What it is |
|---|---|
| `step-ca/ca.json.tmpl` | step-ca configuration: lifetimes, the `kiosk-enrolment` JWK provisioner, CRL, X.509 name policy, TLS |
| `step-ca/templates/device-leaf.tpl` | device certificate template. The identity comes only from the token subject. Client auth only. |
| `step-ca/templates/intermediate-ca.tpl` | issuing-CA template, name-constrained to kiosk identities and the CA's own TLS name |
| `scripts/render-ca.sh` | renders the templates into a step-ca directory (file key, or AWS KMS in production) |
| `scripts/init-dev-ca.sh` | throwaway two-tier CA for development and CI. Never used for field kiosks. |
| `scripts/ci-smoke.sh` | end-to-end test against a real step-ca: enrol (Python and step CLI), refusals, renewal, revocation, CRL |
| `CEREMONY.md` | root and intermediate key ceremony, plus key custody |

## Hierarchy

```
SHRIII Kiosk Root CA            offline. P-256 key generated on an air-gapped laptop and stored on two
  │                             YubiHSM/YubiKey tokens in two sealed safes. 20-year validity.
  │                             Used only in ceremonies (it signs intermediates and its own CRL).
  └── SHRIII Kiosk Issuing CA   online in step-ca. Key held in AWS KMS (ap-south-1, ECC_NIST_P256, SIGN_VERIFY),
        │                       never exported. 5-year validity. pathlen 0. Name constraints:
        │                       DNS .kiosk.<domain> + the CA host, URI <domain>.
        └── kiosk-xyz           device certificate, 24 h, EKU clientAuth only
                                CN=kiosk-xyz, DNS kiosk-xyz.kiosk.shriii.internal,
                                URI spiffe://shriii.internal/kiosk/kiosk-xyz
```

## Issuance (enrolment)

1. On the provisioning workstation, `shriii-provision register` registers the kiosk with the API (it gets a
   device token, a site and a `site_mode`). It then mints a **one-time token** signed with the
   `kiosk-enrolment` provisioner key:
   - ES256 JWT
   - `sub` is the kiosk id; `sans` holds the DNS and URI names
   - `aud` is `<ca>/1.0/sign`
   - `sha` is the root fingerprint
   - random `jti`; lifetime 15 min by default, 60 min at most
2. On the kiosk, the snap's `enrol` service generates an EC P-256 key **on the device** (the disk uses
   TPM-backed FDE) and sends a CSR with the token. step-ca checks the signature, `aud`, expiry, the `jti`
   replay cache and that the CSR SANs equal the token SANs. The template then rebuilds the identity from
   `sub` and rejects kiosk ids that do not match `^[a-z0-9][a-z0-9-]{1,63}$`.
3. The provisioner key is a decrypted JWK, used only on the provisioning workstation (or a CI job with
   secrets). It is never in the image and never on a kiosk. Inside step-ca the provisioner holds only the
   encrypted key.

## Lifetimes and renewal

| Item | Value | Why |
|---|---|---|
| Device certificate | 24 h (minimum 5 min) | A stolen certificate is useless within a day even without revocation |
| Renewal | `step ca renew --daemon` at about 2/3 of the lifetime (~16 h), with jitter, over mTLS | snap `cert-renew` service, then `cert-reimport` refreshes the Chromium NSS DB |
| Renewal after expiry | allowed **for the kiosk-enrolment provisioner only** | Kiosks are offline-first and a site can be offline for days. Renewal still proves possession of the device key, and a revoked certificate never renews. |
| Enrolment token | 15 min (60 max), single use | It lives in the bundle only between `register` and `enrol` |
| Issuing CA | 5 years, re-keyed at 4 | Ceremony |
| Root | 20 years | Ceremony |

## Revocation

A kiosk is revoked when it is stolen, decommissioned or compromised. Do all three steps:

1. **API device token**: `POST /api/v1/admin/kiosks/{id}/revoke`. Effective immediately: every request with
   the token gets 401.
2. **Certificate**: `shriii-provision revoke --serial <serial>`. The serial is in the kiosk's `device.json`
   and in the heartbeat. Revocation is passive, so the certificate can never renew again. It is also put on
   the CRL, which is regenerated on every revoke (`generateOnRevoke`) and otherwise every 5 minutes
   (`renewPeriod`).
3. **Edge**: the mTLS terminator in front of the API pulls `GET <ca>/1.0/crl` at least every 5 minutes and
   rejects listed serials. With the device-token revoke this meets PRV-07's "revoked certificate fails
   within 5 minutes". The 24 h lifetime is the backstop.

`scripts/ci-smoke.sh` checks that a revoked certificate cannot renew and that its serial is on the CRL.

## Production deployment

- step-ca runs as a small service in the private subnet (ECS, owned by the infra/tofu stream) behind an NLB
  with TLS passthrough. Clients pin the root.
- `render-ca.sh` with `KMS_TYPE=awskms KMS_REGION=ap-south-1 INTERMEDIATE_KEY=awskms:key-id=<id>`. The task
  role has `kms:Sign` and `kms:GetPublicKey` on that key only.
- The BadgerDB data directory is on EFS with backups. It holds the revocation and replay databases.
- Secrets Manager holds the provisioner JWE password (step-ca `--password-file`) and the workstation copy
  of the decrypted provisioner JWK. The workstation copy is released per provisioning session and audited.
- The edge pulls the CRL. Alerts fire on CRL fetch failure or on a CRL older than 15 minutes.
