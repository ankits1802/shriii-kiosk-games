"""``shriii-provision``: kiosk registration, enrolment, health and image assertions.

Workstation (field technician / fleet operator):
  register      register a kiosk with the API, assign site + site_mode, mint the step-ca token -> bundle
  push          copy a bundle to a kiosk on the bench network over SSH and trigger enrolment
  token         mint a one-time step-ca token (sign or revoke audience)
  revoke        revoke a device certificate by serial (and, with --kiosk-id, the kiosk's API device token)
  model render  render the Ubuntu Core model template
  model validate
  wave-freeze   build the wave-freeze validation-set assertion

Device (inside the shriii-kiosk snap, or any Linux host for testing):
  enrol         generate the device key, get the certificate, write the device config
  verify        config, certificate, API health, mTLS and device-token heartbeat checks
  renew         renew the device certificate over mTLS

Exit codes: 0 ok, 1 failed check or provisioning error, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from shriii_provision import ProvisionError, __version__, flows, stepca
from shriii_provision import assertions as asr
from shriii_provision import device_config as dc
from shriii_provision.api import SITE_MODES, ApiClient, SiteMode

SNAP_NAME = "shriii-kiosk"
DEVICE_BUNDLE_PATH = f"/var/snap/{SNAP_NAME}/common/provision/bundle.json"


def _read_secret(path: str | None, env: str) -> str | None:
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    value = os.environ.get(env)
    return value.strip() if value else None


def _default_root() -> Path | None:
    common = os.environ.get("SNAP_COMMON")
    return Path(common) if common else None


def _print_json(obj: Any) -> None:
    print(json.dumps(obj, indent=2, sort_keys=True, default=str))


# ------------------------------------------------------------------------------------------- commands


def cmd_register(args: argparse.Namespace) -> int:
    admin_token = _read_secret(args.admin_token_file, "SHRIII_ADMIN_TOKEN")
    provisioner = stepca.load_provisioner_key(Path(args.provisioner_key), name=args.provisioner_name)
    req = flows.RegisterRequest(
        kiosk_id=args.kiosk_id,
        site_id=args.site,
        site_mode=cast(SiteMode, args.site_mode),
        policy_version=args.policy_version,
        app_version=args.app_version,
        ca_url=args.ca_url,
        root_ca_pem=Path(args.root_ca).read_bytes(),
        provisioner=provisioner,
        label=args.label,
        hardware_sku=args.hardware_sku,
        study_id=args.study,
        ring=args.ring,
        domain=args.domain,
        token_ttl_s=args.token_ttl,
        rotate_existing=args.rotate_existing,
        printer=dc.PrinterSpec.parse(args.printer),
        update=dc.UpdateSpec(
            feed_url=args.update_feed,
            ring=args.update_ring,
            manifest_public_key=args.update_pubkey,
            frozen_version=args.frozen_version,
        ),
    )
    api_origin = dc.validate_origin(args.api, "--api", allow_http=args.allow_http)
    with ApiClient(api_origin, admin_token=admin_token) as api:
        bundle = flows.register(api, req)
    out = Path(args.out)
    flows.write_bundle(out, bundle)
    print(f"registered {req.kiosk_id} at {req.site_id} ({req.site_mode}); deployment {bundle['deployment_id']}")
    print(f"enrolment bundle: {out} (contains the device token; expires {bundle['expires_at']})")
    return 0


def cmd_push(args: argparse.Namespace) -> int:
    bundle_path = Path(args.bundle)
    flows.load_bundle(bundle_path)  # refuse expired / malformed bundles before touching the device
    target = f"{args.user}@{args.host}" if args.user else args.host
    remote = " && ".join(
        [
            f"sudo install -d -m 700 {shlex.quote(str(Path(DEVICE_BUNDLE_PATH).parent.as_posix()))}",
            f"sudo sh -c 'umask 077 && cat > {DEVICE_BUNDLE_PATH}'",
            f"sudo snap restart {SNAP_NAME}.enrol",
        ]
    )
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]
    if args.identity:
        ssh += ["-i", args.identity]
    ssh += [target, remote]
    if args.dry_run:
        print(shlex.join(ssh))
        return 0
    with bundle_path.open("rb") as fh:
        proc = subprocess.run(ssh, stdin=fh, check=False)
    if proc.returncode != 0:
        raise ProvisionError(f"ssh to {target} failed with exit code {proc.returncode}")
    print(f"bundle delivered to {target}; enrolment started (journalctl -u snap.{SNAP_NAME}.enrol)")
    return 0


def cmd_enrol(args: argparse.Namespace) -> int:
    root = Path(args.root) if args.root else _default_root()
    if root is None:
        raise ProvisionError("--root is required outside the snap")
    bundle = flows.load_bundle(Path(args.bundle))
    result = flows.enrol(bundle, root, pinned_root_fingerprint=args.pinned_root_fingerprint)
    print(
        f"enrolled {result.kiosk_id}: certificate {result.certificate_serial} valid until "
        f"{result.certificate_not_after.isoformat()}; config in {result.root}"
    )
    if args.delete_bundle:
        Path(args.bundle).unlink(missing_ok=True)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    root = Path(args.root) if args.root else _default_root()
    if root is None:
        raise ProvisionError("--root is required outside the snap")
    checks = flows.verify(root, check_mtls=not args.no_mtls)
    if args.json:
        _print_json([asdict(c) for c in checks])
    else:
        for c in checks:
            print(f"[{'ok' if c.ok else 'FAIL'}] {c.name}: {c.detail}")
    return 0 if checks and all(c.ok for c in checks) else 1


def cmd_renew(args: argparse.Namespace) -> int:
    root = Path(args.root) if args.root else _default_root()
    if root is None:
        raise ProvisionError("--root is required outside the snap")
    issued = flows.renew_device_cert(root)
    print(f"renewed: serial {issued.serial}, valid until {issued.not_after.isoformat()}")
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    provisioner = stepca.load_provisioner_key(Path(args.provisioner_key), name=args.provisioner_name)
    fingerprint = stepca.root_fingerprint(Path(args.root_ca).read_bytes()) if args.root_ca else None
    if args.revoke:
        token = stepca.mint_ott(
            provisioner,
            ca_url=args.ca_url,
            subject=args.subject,
            sans=[],
            root_sha256=fingerprint,
            ttl_s=args.ttl,
            audience_path="/1.0/revoke",
        )
    else:
        sans = args.san or stepca.DeviceIdentity(args.subject, args.domain).sans
        token = stepca.mint_ott(
            provisioner, ca_url=args.ca_url, subject=args.subject, sans=sans, root_sha256=fingerprint, ttl_s=args.ttl
        )
    print(token)
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    provisioner = stepca.load_provisioner_key(Path(args.provisioner_key), name=args.provisioner_name)
    if args.kiosk_id:
        # Device token first: it is checked on every API call, so it stops a stolen kiosk immediately; the
        # certificate revocation then reaches the edge through the CRL (regenerated on revoke).
        dc.validate_kiosk_id(args.kiosk_id)
        if not args.api:
            raise ProvisionError("--api is required with --kiosk-id")
        admin_token = _read_secret(args.admin_token_file, "SHRIII_ADMIN_TOKEN")
        api_origin = dc.validate_origin(args.api, "--api", allow_http=args.allow_http)
        with ApiClient(api_origin, admin_token=admin_token) as api:
            out = api.revoke_kiosk(args.kiosk_id)
        print(f"revoked kiosk {args.kiosk_id} in the API (status {out.get('status')})")
    token = stepca.mint_ott(
        provisioner, ca_url=args.ca_url, subject=args.serial, sans=[], ttl_s=300, audience_path="/1.0/revoke"
    )
    stepca.revoke(args.ca_url, serial=args.serial, ott=token, reason=args.reason, root_pem_path=Path(args.root_ca))
    print(f"revoked certificate {args.serial}")
    if not args.kiosk_id:
        print("note: the kiosk's API device token is still valid; pass --kiosk-id to revoke it as well")
    return 0


def _parse_vars(items: Sequence[str], vars_file: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if vars_file:
        loaded = json.loads(Path(vars_file).read_text(encoding="utf-8"))
        out.update({str(k): str(v) for k, v in loaded.items()})
    for item in items:
        key, sep, value = item.partition("=")
        if not sep:
            raise ProvisionError(f"--var expects NAME=VALUE, got {item!r}")
        out[key] = value
    for key, value in os.environ.items():
        if key.startswith("MODEL_VAR_"):
            out.setdefault(key.removeprefix("MODEL_VAR_"), value)
    return out


def cmd_model_render(args: argparse.Namespace) -> int:
    template = json.loads(Path(args.template).read_text(encoding="utf-8"))
    rendered = asr.render(template, _parse_vars(args.var, args.vars_file))
    text = json.dumps(rendered, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    left = asr.placeholders(rendered)
    if left and not args.allow_placeholders:
        raise ProvisionError(f"unresolved placeholders: {', '.join(sorted(left))}")
    return 0


def cmd_model_validate(args: argparse.Namespace) -> int:
    failed = False
    for path in args.paths:
        model = json.loads(Path(path).read_text(encoding="utf-8"))
        problems = asr.validate_model(
            model, allow_placeholders=args.allow_placeholders, require_production=args.production
        )
        if problems:
            failed = True
            for p in problems:
                print(f"{path}: {p}")
        else:
            print(f"{path}: ok (model {model['model']}, grade {model['grade']}, {len(model['snaps'])} snaps)")
    return 1 if failed else 0


def cmd_wave_freeze(args: argparse.Namespace) -> int:
    snaps: list[dict[str, str]] = []
    for item in args.snap:
        # name=id@revision
        name, _, rest = item.partition("=")
        snap_id, _, revision = rest.partition("@")
        snaps.append({"name": name, "id": snap_id, "revision": revision})
    assertion = asr.wave_freeze_assertion(account_id=args.account_id, sequence=args.sequence, snaps=snaps)
    text = json.dumps(assertion, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


# ------------------------------------------------------------------------------------------- parser


def _add_provisioner(p: argparse.ArgumentParser) -> None:
    p.add_argument("--ca-url", required=True, help="step-ca URL, e.g. https://ca.shriii.internal:9000")
    p.add_argument("--provisioner-key", required=True, help="decrypted JWK (JSON) or PEM of the provisioner key")
    p.add_argument("--provisioner-name", default=stepca.DEFAULT_PROVISIONER)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shriii-provision", description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("register", help="register a kiosk and write its enrolment bundle")
    p.add_argument("--api", required=True, help="API origin, e.g. https://api.shriii.example")
    p.add_argument("--allow-http", action="store_true", help="allow an http:// API (local development only)")
    p.add_argument("--admin-token-file", help="file with an admin bearer token (or env SHRIII_ADMIN_TOKEN)")
    p.add_argument("--kiosk-id", required=True)
    p.add_argument("--site", required=True, help="site id")
    p.add_argument("--site-mode", required=True, choices=SITE_MODES)
    p.add_argument("--policy-version", required=True)
    p.add_argument("--app-version", required=True)
    p.add_argument("--study", help="study id (open_public kiosks join the VAL-18 unattended-mode substudy)")
    p.add_argument("--ring", default="pilot")
    p.add_argument("--label")
    p.add_argument("--hardware-sku", default="ref-sku-1")
    _add_provisioner(p)
    p.add_argument("--root-ca", required=True, help="root CA certificate (PEM)")
    p.add_argument("--domain", default=stepca.DEFAULT_DOMAIN)
    p.add_argument("--token-ttl", type=int, default=900, help="enrolment token lifetime in seconds (max 3600)")
    p.add_argument("--rotate-existing", action="store_true", help="re-enrol an existing kiosk (rotates its token)")
    p.add_argument(
        "--printer", default="device:/dev/usb/lp0", help="none | virtual | device:/dev/... | tcp://host:port"
    )
    p.add_argument("--update-feed")
    p.add_argument("--update-ring", choices=dc.RINGS)
    p.add_argument("--update-pubkey")
    p.add_argument("--frozen-version")
    p.add_argument("--out", required=True, help="bundle path (written 0600)")
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("push", help="deliver a bundle to a kiosk over SSH (bench network) and start enrolment")
    p.add_argument("--bundle", required=True)
    p.add_argument("--host", required=True)
    p.add_argument("--user")
    p.add_argument("--identity", help="SSH private key")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_push)

    p = sub.add_parser("enrol", help="device: key, certificate and config from a bundle")
    p.add_argument("--bundle", required=True)
    p.add_argument("--root", help="device root (default $SNAP_COMMON)")
    p.add_argument("--pinned-root-fingerprint", help="root fingerprint baked into the image")
    p.add_argument("--delete-bundle", action="store_true")
    p.set_defaults(func=cmd_enrol)

    p = sub.add_parser("verify", help="device: health checks after enrolment")
    p.add_argument("--root")
    p.add_argument("--no-mtls", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("renew", help="device: renew the certificate over mTLS")
    p.add_argument("--root")
    p.set_defaults(func=cmd_renew)

    p = sub.add_parser("token", help="mint a one-time step-ca token")
    _add_provisioner(p)
    p.add_argument("--subject", required=True, help="kiosk id (or certificate serial with --revoke)")
    p.add_argument("--san", action="append", help="override SANs (default: the kiosk DNS name and URI)")
    p.add_argument("--domain", default=stepca.DEFAULT_DOMAIN)
    p.add_argument("--root-ca", help="root CA (adds its fingerprint as the 'sha' claim)")
    p.add_argument("--ttl", type=int, default=300)
    p.add_argument("--revoke", action="store_true", help="revoke audience instead of sign")
    p.set_defaults(func=cmd_token)

    p = sub.add_parser("revoke", help="revoke a device certificate by serial")
    _add_provisioner(p)
    p.add_argument("--root-ca", required=True)
    p.add_argument("--serial", required=True)
    p.add_argument("--reason", default="kiosk decommissioned or compromised")
    p.add_argument("--kiosk-id", help="also revoke this kiosk in the API (its device token stops working)")
    p.add_argument("--api", help="API origin (with --kiosk-id)")
    p.add_argument("--allow-http", action="store_true", help="allow an http:// API (local development only)")
    p.add_argument("--admin-token-file", help="file with an admin bearer token (or env SHRIII_ADMIN_TOKEN)")
    p.set_defaults(func=cmd_revoke)

    model = sub.add_parser("model", help="Ubuntu Core model assertion").add_subparsers(dest="model_cmd", required=True)
    p = model.add_parser("render")
    p.add_argument("--template", required=True)
    p.add_argument("--var", action="append", default=[], help="NAME=VALUE (also env MODEL_VAR_NAME)")
    p.add_argument("--vars-file")
    p.add_argument("--allow-placeholders", action="store_true")
    p.add_argument("--out")
    p.set_defaults(func=cmd_model_render)
    p = model.add_parser("validate")
    p.add_argument("paths", nargs="+")
    p.add_argument("--allow-placeholders", action="store_true")
    p.add_argument("--production", action="store_true", help="reject grade dangerous")
    p.set_defaults(func=cmd_model_validate)

    p = sub.add_parser("wave-freeze", help="validation-set assertion pinning a wave's snap revisions")
    p.add_argument("--account-id", required=True)
    p.add_argument("--sequence", type=int, required=True)
    p.add_argument("--snap", action="append", required=True, help="name=snap-id@revision")
    p.add_argument("--out")
    p.set_defaults(func=cmd_wave_freeze)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except ProvisionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
