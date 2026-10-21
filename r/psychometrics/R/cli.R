# JSON-in / JSON-out command line interface.
#
#   shriiipsy run --request req.json [--response resp.json]     ("-" = stdin / stdout)
#   shriiipsy analyses                                          list analyses and their parameters
#   shriiipsy version                                           R / package versions
#
# Request:  {"schema": "shriiipsy-request/1", "analysis": "<name>", "data": {"path": ..., "format": ...} |
#            {"columns": {...}}, "params": {...}, "thresholds": {...}, "seed": 1, "run_id": "..."}
# Response: the typed result (fields of shriii_validation.results.EvidenceResult) plus
#           "schema": "shriiipsy-result/1" and "run_id".

REQUEST_SCHEMA <- "shriiipsy-request/1"
RESULT_SCHEMA <- "shriiipsy-result/1"

#' Registry of analyses exposed by the CLI.
#' @export
analysis_registry <- function() {
  list(
    measurement_invariance = measurement_invariance,
    bayesian_approximate_invariance = bayesian_approximate_invariance,
    irt_grm = irt_grm,
    irt_dif = irt_dif,
    ordinal_logistic_dif = ordinal_logistic_dif,
    glmm_dif = glmm_dif,
    person_random_slopes = person_random_slopes,
    continuous_norms = continuous_norms,
    reliability_cross_check = reliability_cross_check
  )
}

.reserved_args <- c("data", "thresholds", "inputs_sha256", "seed")

.param_names <- function(fn) setdiff(names(formals(fn)), .reserved_args)

.failed <- function(analysis, message, run_id = NULL) {
  r <- psy_unavailable(analysis %||% "unknown", "shriiipsy_cli", message, status = "failed",
                       provenance = make_provenance(analysis %||% "unknown", NA_character_))
  r$run_id <- run_id
  r
}

#' Execute one parsed request (a list) and return a psy_result.
#' @export
run_request <- function(req, base_dir = NULL) {
  run_id <- req$run_id
  analysis <- req$analysis
  if (!is.null(req$schema) && !identical(req$schema, REQUEST_SCHEMA)) {
    return(.failed(analysis, sprintf("unsupported request schema %s (expected %s)", req$schema, REQUEST_SCHEMA), run_id))
  }
  reg <- analysis_registry()
  if (is.null(analysis) || !analysis %in% names(reg)) {
    return(.failed(analysis, sprintf("unknown analysis '%s'; available: %s", analysis %||% "",
                                     paste(names(reg), collapse = ", ")), run_id))
  }
  fn <- reg[[analysis]]
  params <- req$params %||% list()
  unknown <- setdiff(names(params), .param_names(fn))
  if (length(unknown)) {
    return(.failed(analysis, sprintf("unknown parameter(s) for %s: %s", analysis, paste(unknown, collapse = ", ")), run_id))
  }
  seed <- req$seed
  out <- tryCatch({
    th <- resolve_thresholds(req$thresholds)
    input <- read_input(req$data, base_dir)
    RNGkind("Mersenne-Twister", "Inversion", "Rejection")
    if (!is.null(seed)) set.seed(as.integer(seed))
    args <- c(list(data = input$data, thresholds = th, inputs_sha256 = input$sha256, seed = seed), params)
    res <- .collect_warnings(do.call(fn, args))
    r <- res$value
    if (length(res$warnings)) r$warnings <- unique(c(r$warnings, res$warnings))
    r
  }, error = function(e) .failed(analysis, conditionMessage(e), run_id))
  out$run_id <- run_id
  out
}

.prepare_json <- function(x) {
  if (is.list(x)) {
    if (length(x) == 0) return(if (is.null(names(x))) list() else structure(list(), names = character()))
    return(lapply(x, .prepare_json))
  }
  if (is.numeric(x)) x[!is.finite(x)] <- NA
  x
}

#' Serialise a result to JSON (full double precision, NA/NaN/Inf -> null).
#' @export
result_to_json <- function(result) {
  r <- unclass(result)
  r$schema <- RESULT_SCHEMA
  if (!length(r$details)) r$details <- structure(list(), names = character())
  r$assumptions <- r$assumptions %||% list()
  r$warnings <- I(as.character(r$warnings %||% character()))
  r <- .prepare_json(r)
  if (!length(r$warnings)) r$warnings <- I(character())
  if (!length(r$assumptions)) r$assumptions <- I(list())
  jsonlite::toJSON(r, auto_unbox = TRUE, null = "null", na = "null", digits = NA, pretty = FALSE)
}

.read_request <- function(path) {
  txt <- if (identical(path, "-")) paste(readLines(file("stdin"), warn = FALSE), collapse = "\n") else
    paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  jsonlite::fromJSON(txt, simplifyVector = TRUE, simplifyDataFrame = FALSE, simplifyMatrix = FALSE)
}

.arg <- function(args, flag, default = NULL) {
  i <- match(flag, args)
  if (is.na(i) || i == length(args)) default else args[[i + 1]]
}

#' Command line entry point. Returns the process exit status (0 ok, 2 malformed request).
#' @export
cli_main <- function(args = commandArgs(trailingOnly = TRUE)) {
  cmd <- if (length(args)) args[[1]] else "help"
  emit <- function(json, path = NULL) {
    if (is.null(path) || identical(path, "-")) {
      cat(json, "\n", sep = "")
    } else {
      writeLines(json, path, useBytes = TRUE)
    }
  }
  if (cmd == "version") {
    emit(jsonlite::toJSON(list(algorithm_version = SHRIIIPSY_ALGORITHM_VERSION, library_versions = library_versions()),
                          auto_unbox = TRUE, null = "null"))
    return(invisible(0L))
  }
  if (cmd == "analyses") {
    reg <- analysis_registry()
    emit(jsonlite::toJSON(lapply(reg, function(f) .param_names(f)), auto_unbox = FALSE))
    return(invisible(0L))
  }
  if (cmd != "run") {
    cat("usage: shriiipsy run --request <file|-> [--response <file|->] | shriiipsy analyses | shriiipsy version\n",
        file = stderr())
    return(invisible(2L))
  }
  req_path <- .arg(args, "--request", "-")
  resp_path <- .arg(args, "--response", NULL)
  req <- tryCatch(.read_request(req_path), error = function(e) e)
  if (inherits(req, "error")) {
    emit(result_to_json(.failed(NULL, paste("malformed request:", conditionMessage(req)))), resp_path)
    return(invisible(2L))
  }
  base_dir <- if (identical(req_path, "-")) getwd() else dirname(normalizePath(req_path))
  res <- run_request(req, base_dir)
  emit(result_to_json(res), resp_path)
  invisible(0L)
}
