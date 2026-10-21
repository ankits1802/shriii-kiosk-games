# syntax=docker/dockerfile:1
# SHRIII R psychometrics backend (plan VAL-01): R 4.6.1 (latest release) on a digest-pinned rocker image,
# packages restored with renv from a dated Posit Package Manager snapshot (Ubuntu 24.04 binaries).
#
# Build (the context is the R package directory, so the image never sees the rest of the monorepo):
#   docker build -f infra/docker/r-psychometrics.Dockerfile -t shriii/r-psychometrics:0.1.0 r/psychometrics
# Run the test suite inside the image:
#   docker run --rm --entrypoint shriiipsy-test shriii/r-psychometrics:0.1.0
# Run an analysis (JSON in / JSON out; the bridge mounts a work directory at /work):
#   docker run --rm -v "$PWD/work:/work" shriii/r-psychometrics:0.1.0 run --request /work/req.json --response /work/resp.json

FROM rocker/r-ver:4.6.1@sha256:bafb3b9a72791eeeb810f0bc0472e74c7f4939b20b46c96cb7ebc6838b6a25ef

ARG PPM_SNAPSHOT=2026-10-15
ARG PPM_CODENAME=noble

LABEL org.opencontainers.image.title="shriii-r-psychometrics" \
      org.opencontainers.image.description="SHRIII shriiipsy R backend: lavaan/semTools invariance, mirt IRT/DIF, lordif, lme4/glmmTMB, cNORM/GAMLSS, irr, blavaan" \
      org.opencontainers.image.version="0.1.0" \
      io.shriii.ppm-snapshot="${PPM_SNAPSHOT}"

# Deterministic numerics (plan VAL-01 AC: fixed seeds, BLAS and threads) and the pinned package snapshot.
ENV OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    TZ=UTC \
    LANG=en_US.UTF-8 \
    RENV_CONFIG_REPOS_OVERRIDE=https://packagemanager.posit.co/cran/__linux__/${PPM_CODENAME}/${PPM_SNAPSHOT} \
    RENV_CONFIG_PAK_ENABLED=FALSE \
    RENV_CONFIG_CACHE_ENABLED=FALSE \
    RENV_CONFIG_AUTOLOADER_ENABLED=FALSE

COPY tools/system-deps.txt /tmp/system-deps.txt
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $(cat /tmp/system-deps.txt) \
 && rm -rf /var/lib/apt/lists/* /tmp/system-deps.txt \
 && echo "options(repos = c(CRAN = '${RENV_CONFIG_REPOS_OVERRIDE}'))" >> "$(R RHOME)/etc/Rprofile.site"

# Restore the locked library into the site library (layer cached until renv.lock changes).
WORKDIR /opt/shriiipsy
COPY renv.lock /opt/shriiipsy/renv.lock
RUN Rscript -e "install.packages('renv')" \
 && Rscript -e "renv::restore(lockfile = '/opt/shriiipsy/renv.lock', library = .libPaths()[1], prompt = FALSE, clean = FALSE)" \
 && Rscript -e "pk <- jsonlite::read_json('/opt/shriiipsy/renv.lock')\$Packages; \
      bad <- Filter(function(p) utils::packageVersion(p\$Package) != package_version(p\$Version), pk); \
      if (length(bad)) stop('renv restore mismatch: ', paste(names(bad), collapse = ', ')); \
      invisible(lapply(names(pk), requireNamespace)); cat('renv library verified:', length(pk), 'packages\n')" \
 && rm -rf /tmp/Rtmp* /root/.cache

# Install the package itself and the CLI entry points (strip CR in case of a Windows checkout).
COPY . /opt/shriiipsy/src
RUN find /opt/shriiipsy/src -type f \( -name '*.R' -o -name 'shriiipsy' -o -name 'DESCRIPTION' -o -name 'NAMESPACE' -o -name '*.yaml' \) -exec sed -i 's/\r$//' {} + \
 && R CMD INSTALL --no-docs --no-multiarch /opt/shriiipsy/src \
 && install -m 0755 /opt/shriiipsy/src/inst/bin/shriiipsy /usr/local/bin/shriiipsy \
 && printf '#!/bin/sh\nset -e\ncd /opt/shriiipsy/src/tests\nexec Rscript -e "res <- testthat::test_dir(\\"testthat\\", package = \\"shriiipsy\\", load_package = \\"installed\\", reporter = \\"summary\\", stop_on_failure = TRUE)"\n' > /usr/local/bin/shriiipsy-test \
 && chmod 0755 /usr/local/bin/shriiipsy-test \
 && useradd --create-home --uid 10001 shriii \
 && mkdir -p /work && chown shriii:shriii /work

USER shriii
WORKDIR /work
ENTRYPOINT ["shriiipsy"]
CMD ["version"]
