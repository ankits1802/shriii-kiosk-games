# Dependency and supply-chain policy

Applies to every package in the monorepo (`frontend/apps/*`, `frontend/packages/*`, `contracts`, `backend/api`, `stats/*`, `tools/*`, `cicd/*`), the kiosk image,
container images and CI. Supports PRV-09 ("dependency, SAST and container scans"), PLT-04 (CI/CD), PLT-08
(version verification), KSK-11 (signed OTA) and PRV-11 (deployed-artefact hashes in the IRB pack). SLSA
provenance is listed as deferred (P2) in the plan; this policy sets the baseline now and the provenance
target for later.

## 1. Principles

1. **Few, well-maintained dependencies.** Every new direct dependency needs a reason. Prefer the standard
   library and existing dependencies.
2. **Everything pinned and locked.** Builds are reproducible from lockfiles; nothing floats at build time.
3. **Verify before trust.** New versions wait before adoption, are scanned, and are reviewed by a human.
4. **Least privilege in CI.** Build jobs cannot publish; publish jobs build nothing new.
5. **Traceability.** Every deployed artefact (kiosk snap, API image, content pack) maps to a commit, a
   lockfile and an SBOM, and its hash goes into the IRB evidence pack (PRV-11).

## 2. Adding or upgrading a dependency

Checklist for the pull request (reviewer confirms each item):

| Check | Rule |
|---|---|
| Need | Explain why the standard library or an existing dependency is not enough. |
| Health | Active maintenance (release in the last 12 months or stable by design), more than one maintainer or an organisation, a security policy, no unresolved critical advisories. |
| Licence | Allowed: MIT, BSD-2/3, Apache-2.0, ISC, MPL-2.0 (file-level), PSF, Zlib, CC0, Unicode, OFL (fonts). Needs approval: LGPL (dynamic linking only), EPL. Not allowed in shipped artefacts: GPL/AGPL, SSPL, BUSL, "non-commercial", unknown. R packages for the later `RBackend` run server-side only and are reviewed separately (many are GPL; they must not be linked into distributed binaries). |
| Footprint | Check transitive additions (`uv tree`, `pnpm why`); avoid packages with install scripts. |
| Age | The selected version has been public for **at least 7 days** (pnpm `minimumReleaseAge`, uv `exclude-newer` in CI for audits), unless it fixes a vulnerability we are exposed to. |
| Scan | `pip-audit` / `pnpm audit` / OSV clean for the new tree, or findings triaged in the PR. |
| Kiosk impact | Anything in the kiosk bundle also needs a bundle-size check and must not add network calls or telemetry (CSP `connect-src` is fixed). |

Upgrades: automated PRs (Renovate) grouped weekly for patch/minor, monthly for major; security fixes
immediately. During a **wave freeze** (KSK-11), kiosk dependencies change only through a PLT-09 emergency
record.

## 3. Lockfiles and installation

| Ecosystem | Rule |
|---|---|
| Python (uv workspace) | `uv.lock` committed. CI runs `uv sync --locked` (fails on drift). Production images install from the lock with hashes (`uv export --format requirements-txt` keeps hashes by default; install with `pip install --require-hashes` or `uv pip sync`). Python version pinned in `requires-python` and the image tag pinned by digest. |
| JavaScript (pnpm 12 workspace) | `pnpm-lock.yaml` committed. CI runs `pnpm install --frozen-lockfile`. Set in `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` (7 days) and an explicit `onlyBuiltDependencies` allow-list so dependency install scripts do not run unless approved (pnpm blocks lifecycle scripts by default). |
| Containers | Base images pinned by digest (`python:3.14-slim@sha256:...`, `postgres:18@sha256:...`); rebuilt weekly for OS patches. |
| GitHub Actions | Third-party actions pinned by full commit SHA with a version comment; Renovate updates them. |
| Kiosk OS | Snap revisions pinned per ring and per wave with validation sets ([kiosk-hardening-ubuntu-core.md](kiosk-hardening-ubuntu-core.md) §8). |

## 4. Automated checks in CI

| Check | Tool | When | Policy |
|---|---|---|---|
| Python vulnerabilities | `pip-audit` on `uv export --frozen` output (or `uv audit` when stable) | every PR + nightly | Fail on any known vulnerability with a fix available; otherwise triage within 7 days |
| JS vulnerabilities | `pnpm audit --audit-level=moderate` | every PR + nightly | Same |
| Cross-ecosystem | `osv-scanner --lockfile=uv.lock --lockfile=pnpm-lock.yaml` | nightly | Same |
| SAST | `semgrep` with `p/default p/owasp-top-ten p/python p/typescript p/jwt p/sql-injection p/secrets` plus repo rules (§7) | every PR | Fail on new ERROR findings; triage file `docs/security/scans/semgrep-triage.md` for accepted ones |
| Python lint security | `ruff` with the `S` (bandit) rule set enabled for `backend/api`, `contracts/python` and `stats/*` | every PR | Fail on new findings |
| Secrets | `gitleaks` (pre-commit + CI) and GitHub secret scanning with push protection | every push | Block |
| Containers | `trivy image` (or `grype`) on API/worker images | build + nightly | Fail on fixable HIGH/CRITICAL |
| IaC | `checkov` / `tfsec` on OpenTofu (PLT-05) | every PR | Fail on HIGH |
| Licences | `pip-licenses` and `pnpm licenses list` compared with §2 allow-list | every PR | Fail on disallowed licence |
| SBOM | `cyclonedx-py` (Python env) and `cyclonedx-npm`/`syft` (JS bundle, images) | release | Attach SBOM to the release and the IRB pack |
| Electron | `@electron/fuses` read-back and `electronegativity` | kiosk build | Fail on missing fuses or high findings |
| Load/correctness | `shriii-loadtest suite` against staging | before ring promotion | ING-02 targets in `tools/loadtest/targets.yaml` |

## 5. Build, signing and provenance

- CI builds from a clean checkout of a protected branch or a signed tag; no developer-machine artefacts are
  ever deployed.
- **Container images:** sign with Sigstore `cosign` (keyless OIDC from CI) and attach SBOM and SLSA
  provenance attestations (`actions/attest-build-provenance`). Deployment verifies the signature and the
  builder identity (`cosign verify --certificate-identity ... --certificate-oidc-issuer ...`).
- **Kiosk snap:** built in CI, uploaded to the brand store from a dedicated publish job with a store
  credential scoped to that snap and channel; the store signs the revision; validation sets pin it.
- **Content, dictionary, policy and release packs:** signed with Ed25519 keys held in KMS (release packs use
  the existing `release_pack_signing_key` path); the kiosk verifies signatures and refuses downgrades (KSK-11).
- **Provenance target (SLSA L3, P2):** hardened, isolated builders; non-falsifiable provenance; two-person
  review on every change to build definitions.
- Record the hash of each deployed artefact in the PRV-11 evidence pack.

## 6. Repository and access controls

- Branch protection on `main`: required reviews (2 for paths in §7 "sensitive paths", 1 otherwise), required
  status checks, no force pushes, linear history, signed commits for release tags.
- `CODEOWNERS` for sensitive paths: `backend/api/src/shriii_api/{auth,security.py,settings.py,services/ingestion.py,services/erasure.py,services/consent.py,audit.py,migrations*}`,
  `contracts/schemas`, `stats/measurement-model/*.yaml`, `frontend/packages/kiosk-game/src/logging`, `frontend/apps/kiosk/electron`,
  CI workflows, Dockerfiles, `docs/security`.
- CI tokens: `permissions: contents: read` by default; publish jobs get only what they need; no long-lived
  cloud keys (OIDC federation to AWS).
- No `pull_request_target` workflows that check out PR code; forked PRs run without secrets.
- MFA required for every GitHub, store and cloud account; quarterly access review.

## 7. Repository-specific rules (semgrep / review)

Write these as custom semgrep rules under `tools/semgrep/` (future work) and check them in review now:

1. No `text(f"...")` / f-string SQL with values derived from request data. Existing f-string SQL uses only
   module constants and server-derived dates (triaged in [scan-findings.md](scan-findings.md)).
2. No `print`/`log` of `envelope`, `payload`, contact fields, tokens or keys.
3. No new `VITE_*` variable may carry a secret (all `VITE_*` values are public in the bundle).
4. No camera APIs (`getUserMedia({video`), `ImageCapture`, face/emotion libraries) anywhere (KSK-01 AC).
5. No new unaudited GET prefixes in `audit._UNAUDITED_GET_PREFIXES` without security review.
6. Every new endpoint declares `require(Perm.X)`; the permission-matrix test must cover it.

## 8. Vulnerability handling

| Severity (CVSS / exposure) | Fix or mitigate within |
|---|---|
| Critical, exploitable in our deployment | 48 hours (kiosk: next attract window via an emergency ring) |
| High | 7 days |
| Medium | 30 days |
| Low / not reachable | Next scheduled upgrade; document reachability |

Track each advisory as an issue with the reachability analysis. Kiosk fixes during a wave freeze need a
PLT-09 emergency override record.

## 9. Current state (2026-10-21)

From the scan recorded in [scan-findings.md](scan-findings.md):
- `pip-audit`: 100 locked Python packages of the wave-1 workspace, **no known vulnerabilities**.
- `pnpm audit`: 256 JS dependencies, **0 advisories**.
- `semgrep` (543 rules): 20 findings, **all triaged as false positives or informational**.
- Gaps against this policy: there is no CI workflow directory (`.github/`) yet, so none of these checks run
  automatically; `pnpm-workspace.yaml` relies on pnpm's default `minimumReleaseAge` (with a
  `minimumReleaseAgeExclude` list for turbo and vite) instead of the 7-day value above, and has no explicit
  build-script allow-list; container images and the kiosk snap do not exist yet; no SBOM, signing or
  provenance; no CODEOWNERS.
