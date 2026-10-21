# Typed result objects. The field names and types mirror the Python
# shriii_validation.results.EvidenceResult / Provenance / AssumptionCheck dataclasses exactly, so the
# bridge can construct them without renaming.

#' Algorithm version of the R backend (bumped whenever any estimator or decision rule changes).
#' @export
SHRIIIPSY_ALGORITHM_VERSION <- "shriiipsy-0.1.0"

.result_statuses <- c("ok", "insufficient", "not_available", "failed")

.tracked_packages <- c(
  "shriiipsy", "lavaan", "semTools", "mirt", "lordif", "lme4", "glmmTMB", "cNORM", "gamlss",
  "gamlss.dist", "irr", "psych", "blavaan", "nanoparquet", "jsonlite"
)

#' Versions of R and the tracked packages (NULL for packages that are not installed).
#' @export
library_versions <- function() {
  out <- list(R = paste(R.version$major, R.version$minor, sep = "."))
  for (p in .tracked_packages) {
    out[[p]] <- tryCatch(as.character(utils::packageVersion(p)), error = function(e) NULL)
  }
  out
}

#' An assumption check: what was tested, whether it held, the statistic and a detail string.
#' @export
assumption <- function(name, passed, statistic = NULL, detail = "") {
  stat <- if (is.null(statistic) || !is.finite(statistic)) NULL else as.numeric(statistic)
  list(name = as.character(name), passed = isTRUE(passed), statistic = stat, detail = as.character(detail))
}

#' Build a provenance record.
#' @export
make_provenance <- function(analysis, inputs_sha256, seed = NULL, params = list()) {
  list(
    analysis = analysis,
    algorithm_version = SHRIIIPSY_ALGORITHM_VERSION,
    computed_at = format(as.POSIXct(Sys.time(), tz = "UTC"), "%Y-%m-%dT%H:%M:%OS6+00:00", tz = "UTC"),
    inputs_sha256 = inputs_sha256,
    seed = if (is.null(seed)) NULL else as.integer(seed),
    params = params,
    library_versions = library_versions()
  )
}

.num_or_null <- function(x) {
  if (is.null(x) || length(x) == 0) return(NULL)
  x <- suppressWarnings(as.numeric(x[[1]]))
  if (!is.finite(x)) NULL else x
}

#' Construct a typed evidence result.
#' @export
psy_result <- function(analysis, estimate, ci_low = NULL, ci_high = NULL, ci_level = NULL, n = 0L,
                       method = "", status = "ok", assumptions = list(), warnings = character(),
                       details = list(), provenance = NULL) {
  stopifnot(status %in% .result_statuses)
  est <- .num_or_null(estimate)
  if (status == "ok" && is.null(est)) {
    status <- "failed"
    warnings <- c(warnings, "analysis produced no finite estimate")
  }
  structure(
    list(
      analysis = analysis,
      estimate = est,
      ci_low = .num_or_null(ci_low),
      ci_high = .num_or_null(ci_high),
      ci_level = .num_or_null(ci_level),
      n = as.integer(n),
      method = method,
      status = status,
      assumptions = unname(assumptions),
      warnings = unique(as.character(warnings)),
      details = details,
      provenance = provenance
    ),
    class = "psy_result"
  )
}

#' A result that carries no estimate, only the reason (status insufficient, not_available or failed).
#' @export
psy_unavailable <- function(analysis, method, message, n = 0L, status = "insufficient", details = list(),
                            provenance = NULL) {
  psy_result(
    analysis = analysis, estimate = NULL, n = n, method = method, status = status,
    warnings = message, details = details, provenance = provenance
  )
}

#' @export
print.psy_result <- function(x, ...) {
  cat(sprintf(
    "<psy_result %s [%s] estimate=%s n=%d method=%s>\n", x$analysis, x$status,
    format(x$estimate), x$n, x$method
  ))
  if (length(x$warnings)) cat("  warnings:", paste(x$warnings, collapse = " | "), "\n")
  invisible(x)
}
