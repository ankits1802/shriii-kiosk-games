# shriii-provision

The kiosk provisioning CLI (KSK-09, KSK-10, PRV-07). It is a standalone uv project with its own `uv.lock`,
not a member of the root workspace. It runs on the provisioning workstation. The device-side commands
(`enrol`, `verify`, `renew`) also run on any Linux host and are the reference for the snap's shell services
in `infra/kiosk-image/app/src/bin`.

```sh
cd tools/provision
uv sync
uv run pytest -q          # mock API + mock step-ca; no network, no database
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

## Commands

| Command | Runs on | What it does |
|---|---|---|
| `register` | workstation | `GET /healthz`, then `POST /api/v1/admin/kiosks` (device token, returned once; `--rotate-existing` uses `rotate-token` instead), then `POST /api/v1/admin/deployments` (site, `site_mode` `supervised` or `open_public`, policy and app version, ring). Mints a one-time step-ca token and writes a 0600 enrolment bundle. Refuses `open_public` with a study (PRV-01). |
| `push` | workstation | streams the bundle over SSH (stdin, never argv) to `/var/snap/shriii-kiosk/common/provision/bundle.json` and restarts `shriii-kiosk.enrol` |
| `enrol` | device | generates the key on the device, sends the CSR and token to step-ca, checks the issued certificate (key, CN), and writes `kiosk-config.json`, `recipient-keys.json`, `device.json`, `secrets/device-token` and `tls/*` atomically |
| `verify` | device | checks the config files, certificate validity (at least 10 min left), `GET /healthz`, an mTLS probe and a device-token heartbeat. Exit 1 if any check fails; `--json` for machines. |
| `renew` | device | `POST /1.0/renew` over mTLS |
| `token` | workstation, CI | prints a one-time token (`--revoke` for the revoke audience) |
| `revoke` | workstation | revokes a certificate by serial (passive, so it is also put on the CRL). Also revoke the API device token. |
| `model render` / `model validate` | CI, release | renders `${VARS}` (`--var`, `--vars-file`, `MODEL_VAR_*` env) and validates the Ubuntu Core model against kiosk rules |
| `wave-freeze` | release | writes the `shriii-wave-freeze` validation-set JSON pinning snap revisions, ready for `snap sign` |

Secrets: the admin token comes from `--admin-token-file` or `SHRIII_ADMIN_TOKEN`. The provisioner key is a
decrypted JWK or a PEM file. Error messages and stdout never contain the admin token or the device token.

The device file layout is documented in `src/shriii_provision/device_config.py`. It matches the
`SHRIII_KIOSK_CONFIG` file read by `frontend/apps/kiosk-electron/src/main/config.ts`.
