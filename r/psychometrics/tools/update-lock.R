# Regenerate renv.lock for shriiipsy from the pinned Posit Package Manager snapshot.
# Run inside the pinned base image (tools/update-lock.sh); never against a developer's own R library.
snapshot <- Sys.getenv("SHRIII_PPM_SNAPSHOT", "2026-10-15")
codename <- Sys.getenv("SHRIII_PPM_CODENAME", "noble")
binary <- sprintf("https://packagemanager.posit.co/cran/__linux__/%s/%s", codename, snapshot)
source_repo <- sprintf("https://packagemanager.posit.co/cran/%s", snapshot)
options(repos = c(CRAN = binary), Ncpus = max(1L, parallel::detectCores() - 1L))
proj <- "/proj"
lib <- "/tmp/shriii-lib"
dir.create(lib, showWarnings = FALSE, recursive = TRUE)
.libPaths(c(lib, .libPaths()))
if (!requireNamespace("renv", quietly = TRUE)) install.packages("renv", lib = lib)
desc <- read.dcf(file.path(proj, "DESCRIPTION"))
field <- function(f) if (f %in% colnames(desc)) desc[, f] else ""
deps <- unlist(strsplit(paste(field("Imports"), field("Suggests"), sep = ","), ","))
deps <- trimws(sub("\\(.*\\)", "", deps))
base_pkgs <- c("stats", "utils", "methods", "parallel", "tools", "grDevices", "graphics", "grid", "splines")
deps <- setdiff(deps[nzchar(deps)], base_pkgs)
need <- deps[!deps %in% rownames(utils::installed.packages(lib.loc = lib))]
if (length(need)) install.packages(need, lib = lib)
missing <- deps[!vapply(deps, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) stop("failed to install: ", paste(missing, collapse = ", "))
renv::snapshot(
  project = proj, library = .libPaths(), lockfile = file.path(proj, "renv.lock"),
  packages = c("renv", deps), repos = c(CRAN = source_repo), prompt = FALSE, force = TRUE
)
cat("renv.lock written for PPM snapshot", snapshot, "\n")
