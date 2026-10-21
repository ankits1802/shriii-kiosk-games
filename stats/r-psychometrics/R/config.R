# Threshold configuration: package defaults (inst/config/thresholds.yaml) overridden key by key by the
# `thresholds` object of a request (the Python bridge sends stats/measurement-model/gates.yaml + validation_params.yaml).

.deep_merge <- function(base, override) {
  if (is.null(override)) return(base)
  for (k in names(override)) {
    if (is.list(base[[k]]) && is.list(override[[k]]) && !is.null(names(override[[k]]))) {
      base[[k]] <- .deep_merge(base[[k]], override[[k]])
    } else {
      base[[k]] <- override[[k]]
    }
  }
  base
}

#' Default thresholds shipped with the package.
#' @export
default_thresholds <- function() {
  path <- system.file("config", "thresholds.yaml", package = "shriiipsy")
  if (!nzchar(path)) stop("shriiipsy thresholds.yaml is missing from the installed package")
  doc <- yaml::read_yaml(path)
  if (!identical(doc$schema, "shriiipsy-thresholds")) stop("thresholds.yaml has the wrong schema")
  doc
}

#' Resolve thresholds: defaults merged with request overrides.
#' @export
resolve_thresholds <- function(overrides = NULL) {
  .deep_merge(default_thresholds(), overrides)
}

# Fetch a numeric threshold, failing loudly when it is missing (no silent hard-coded fallbacks).
.th <- function(th, section, key) {
  v <- th[[section]][[key]]
  if (is.null(v)) stop(sprintf("threshold %s.%s is missing", section, key))
  v
}
