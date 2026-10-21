#!/usr/bin/env sh
# Regenerates r/psychometrics/renv.lock inside the pinned base image (same digest as the Dockerfile).
# Usage: r/psychometrics/tools/update-lock.sh   (optionally SHRIII_PPM_SNAPSHOT=YYYY-MM-DD)
# The package library is cached in the docker volume `shriii-rlib-lock` between runs.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
base="${SHRIII_R_BASE:-rocker/r-ver:4.6.1@sha256:bafb3b9a72791eeeb810f0bc0472e74c7f4939b20b46c96cb7ebc6838b6a25ef}"
MSYS_NO_PATHCONV=1 docker run --rm \
  -e SHRIII_PPM_SNAPSHOT="${SHRIII_PPM_SNAPSHOT:-2026-10-15}" \
  -v shriii-rlib-lock:/tmp/shriii-lib \
  -v "$here:/proj" -w /proj "$base" sh -c '
    apt-get update -qq &&
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $(cat /proj/tools/system-deps.txt) >/dev/null &&
    Rscript /proj/tools/update-lock.R'
