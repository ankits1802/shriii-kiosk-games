# Root and issuing-CA key ceremony

This ceremony creates the SHRIII Kiosk Root CA (offline) and the Kiosk Issuing CA, whose key lives in AWS
KMS. Run it again to re-key the issuing CA at year 4 or after a compromise. It needs two-person control
(PLT-09), and the evidence goes into the PRV-11 ethics/evidence pack.

## Roles

| Role | Who | Holds |
|---|---|---|
| Ceremony administrator | Engineering lead | runs the commands and reads them aloud |
| Witness / custodian A | Data protection officer (or delegate) | root token A, safe A key |
| Witness / custodian B | PI (or delegate) | root token B, safe B key |
| Recorder | anyone not holding a token | video recording, signed log |

Quorum: the administrator plus both custodians. No one person can ever use the root key.

## Materials

- An air-gapped laptop booted from a verified Ubuntu 24.04 live USB. Check the image's SHA-256 against
  Canonical's signed `SHA256SUMS`. The laptop's network hardware is removed or disabled in firmware.
- `step` and `step-kms-plugin` binaries copied from a release verified with its Sigstore bundle
  (`cosign verify-blob`). Record the checksums in the log.
- Two new YubiHSM 2 (or YubiKey 5 with PIV) tokens, still in tamper-evident bags. Record the serials.
- Two USB drives for **public** outputs only (certificates, CSRs, CRL).
- A printed copy of this document, the log template and tamper-evident bags.

## A. Root CA (offline, on the air-gapped laptop)

1. Open the bags on camera and read out the serials.
2. Initialise token A and generate the root key **on the token** (non-exportable, P-256). Then create the
   self-signed root:
   ```sh
   step kms create --kms "yubikey:pin-value=$PIN_A" 'yubikey:slot-id=9c' --kty EC --crv P256
   step certificate create "SHRIII Kiosk Root CA" root_ca.crt \
     --profile root-ca --kms "yubikey:pin-value=$PIN_A" --key 'yubikey:slot-id=9c' --not-after 175320h
   ```
   Token B is the backup. Depending on the token type, use either a wrapped key export to token B under
   split wrap keys, or (YubiKey PIV) a second root with cross-signing. Record which method you used.
3. `step certificate fingerprint root_ca.crt`. **Read it aloud.** All three people write it on the log. This
   fingerprint is pinned in the kiosk gadget (`ca.root-fingerprint`, set by `scripts/render-gadget.sh` from
   the `CA_ROOT_FINGERPRINT` repository variable) and in every enrolment bundle.

## B. Issuing CA (key in AWS KMS)

1. Separately, an AWS administrator with the `pki-ceremony` role (MFA, CloudTrail) creates the key:
   ```sh
   aws kms create-key --region ap-south-1 --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
     --description "SHRIII Kiosk Issuing CA <yyyy>" --tags TagKey=purpose,TagValue=kiosk-issuing-ca
   ```
   The key policy allows only `kms:Sign` and `kms:GetPublicKey` to the step-ca task role, and administration
   only to `pki-ceremony`. Deletion has a 30-day waiting period plus an alarm.
2. Generate the CSR with the KMS key (`step-kms-plugin`) on a connected admin workstation:
   ```sh
   step certificate create "SHRIII Kiosk Issuing CA" intermediate.csr --csr \
     --kms awskms:region=ap-south-1 --key "awskms:key-id=<key-id>"
   ```
   Copy the CSR (public) to the ceremony USB. **Read its public key hash aloud.**
3. On the air-gapped laptop, render `step-ca/templates/intermediate-ca.tpl` with the production
   `DEVICE_DOMAIN` and `CA_DNS`. Sign it with the root on token A:
   ```sh
   step certificate sign intermediate.csr root_ca.crt 'yubikey:slot-id=9c' \
     --kms "yubikey:pin-value=$PIN_A" --template intermediate-ca.tpl --not-after 43830h \
     > intermediate_ca.crt
   step certificate inspect intermediate_ca.crt   # check: pathlen 0, name constraints critical, 5 years
   ```
4. Sign an initial (empty) root CRL with a 1-year `nextUpdate`. The root CRL is re-signed every year in a
   short ceremony, or whenever an issuing CA is revoked.
5. Copy `root_ca.crt`, `intermediate_ca.crt` and the root CRL to the public USB. Seal tokens A and B in
   separate bags, write the bag numbers on the log, and lock them in safes A and B.

## C. Activation

1. Upload the certificates to the step-ca configuration bucket. Run `render-ca.sh` with `KMS_TYPE=awskms`.
2. Generate the `kiosk-enrolment` provisioner key and store its JWE password in Secrets Manager:
   `step crypto jwk create --kty EC --curve P-256 --use sig`. The encrypted private JWK goes into `ca.json`.
   The decrypted JWK goes to Secrets Manager (`shriii/pki/kiosk-enrolment-jwk`) for provisioning sessions.
3. Set the repository variable `CA_ROOT_FINGERPRINT`. Build and sign the gadget.
4. Smoke test: enrol a lab kiosk, renew it, revoke it, and check the CRL (as `scripts/ci-smoke.sh` does).
5. All present sign the log. Scan it and file it with the video hash in the PRV-11 evidence pack.

## Compromise and recovery

| Event | Action |
|---|---|
| Provisioner key leaked | Remove the provisioner and add a new one with a new key (step-ca config change and restart). Tokens minted with the old key stop working. Review enrolments since the suspected leak and revoke anything unexpected. |
| Issuing CA key misuse suspected | Disable the KMS key (issuance stops at once). Run this ceremony's section B for a new issuing CA. Revoke the old issuing CA on the root CRL. Re-enrol kiosks with `register --rotate-existing` (bench or remote). |
| Root token lost | Use the backup token B. Re-run section A within 30 days to restore two tokens. |
| Both root tokens lost or root compromised | New root and a new gadget pin (`ca.root-fingerprint`). Every kiosk is re-provisioned. This is the reason for the two-safe custody. |
