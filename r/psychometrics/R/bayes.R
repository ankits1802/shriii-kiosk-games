# Bayesian approximate measurement invariance (plan VAL-08a: groups with n < 200) via blavaan, with
# small-variance priors on group differences of equality-constrained parameters (Muthen & Asparouhov 2013).

.wiggle_ops <- c(loadings = "=~", intercepts = "~1", thresholds = "|")

#' Bayesian approximate invariance (blavaan bcfa with `wiggle`).
#' @export
bayesian_approximate_invariance <- function(data, model, group, wiggle = c("loadings", "intercepts"),
                                            ordered = character(), chains = NULL, burnin = NULL, sample = NULL,
                                            wiggle_sd = NULL, thresholds = resolve_thresholds(),
                                            inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "bayesian_approximate_invariance"
  method <- "blavaan_bcfa_approximate_invariance"
  warns <- character()
  .require_columns(data, group, "group column")
  ov <- lavaan::lavaanNames(lavaan::lavaanify(model), "ov")
  .require_columns(data, ov, "indicator")
  data <- data[!is.na(data[[group]]), , drop = FALSE]
  data[[group]] <- as.character(data[[group]])
  wiggle <- intersect(.as_char_vec(wiggle), names(.wiggle_ops))
  ordered <- .as_char_vec(ordered)
  if (length(unique(data[[group]])) < 2) {
    return(psy_unavailable(analysis, method, "at least two groups are needed", n = nrow(data),
                           provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  bi <- thresholds$bayesian_invariance
  chains <- chains %||% bi$chains
  burnin <- burnin %||% bi$burnin
  sample <- sample %||% bi$sample
  wsd <- wiggle_sd %||% bi$wiggle_sd
  group_equal <- unique(c("loadings", "intercepts", if (length(ordered)) "thresholds"))
  args <- list(model = model, data = data, group = group, group.equal = group_equal, wiggle = wiggle,
               wiggle.sd = wsd, n.chains = chains, burnin = burnin, sample = sample, target = "stan",
               bcontrol = list(cores = 1, refresh = 0))
  if (length(ordered)) args$ordered <- ordered
  if (!is.null(seed)) args$seed <- seed
  res <- .collect_warnings(.quietly(suppressMessages(do.call("bcfa", args, envir = asNamespace("blavaan")))))
  fit <- res$value
  warns <- c(warns, res$warnings)
  # blavaan stores the posterior predictive p in the "ppp" entry of the lavaan test slot.
  ppp <- .safe_num(tryCatch({
    tests <- methods::slot(fit, "test")
    hit <- Filter(function(t) identical(t$test, "ppp"), tests)
    if (length(hit)) hit[[1]]$stat else NA
  }, error = function(e) NA))
  rhat <- tryCatch(blavaan::blavInspect(fit, "psrf"), error = function(e) NA)
  neff <- tryCatch(blavaan::blavInspect(fit, "neff"), error = function(e) NA)
  max_rhat <- suppressWarnings(max(rhat, na.rm = TRUE))
  min_neff <- suppressWarnings(min(neff, na.rm = TRUE))
  pt <- lavaan::parTable(fit)
  glabels <- lavaan::lavInspect(fit, "group.label")
  diffs <- list()
  for (w in wiggle) {
    op <- .wiggle_ops[[w]]
    rows <- pt[pt$op == op & pt$group > 0, , drop = FALSE]
    if (op == "~1") rows <- rows[rows$lhs %in% ov, , drop = FALSE]
    for (pid in unique(paste(rows$lhs, rows$op, rows$rhs))) {
      r <- rows[paste(rows$lhs, rows$op, rows$rhs) == pid, , drop = FALSE]
      if (!any(r$free > 0)) next # marker loadings and other fixed parameters
      est <- stats::setNames(r$est, glabels[r$group])
      diffs[[length(diffs) + 1]] <- list(
        parameter = if (op == "~1") paste0(r$lhs[1], "~1") else paste0(r$lhs[1], op, r$rhs[1]),
        type = w, by_group = as.list(est), max_abs_difference = max(est) - min(est),
        posterior_sd = as.list(stats::setNames(r$se, glabels[r$group]))
      )
    }
  }
  converged <- is.finite(max_rhat) && max_rhat <= bi$rhat_max
  if (!converged) warns <- c(warns, sprintf("max R-hat %.3f above %.2f: run longer chains", max_rhat, bi$rhat_max))
  supported <- converged && is.finite(ppp) && ppp >= bi$ppp_min
  details <- list(
    approximate_invariance_supported = supported,
    ppp = ppp, max_rhat = max_rhat, min_neff = min_neff,
    wiggle = as.list(wiggle), wiggle_sd = wsd,
    parameter_differences = diffs,
    chains = chains, burnin = burnin, sample = sample,
    groups = as.list(table(data[[group]])),
    thresholds = bi
  )
  psy_result(
    analysis = analysis, estimate = ppp, n = nrow(data), method = method,
    status = if (is.finite(ppp)) "ok" else "failed",
    assumptions = list(
      assumption("rhat_max", converged, max_rhat, sprintf("max R-hat <= %s", bi$rhat_max)),
      assumption("ppp_min", is.finite(ppp) && ppp >= bi$ppp_min, ppp, sprintf("PPP >= %s", bi$ppp_min))
    ),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed,
                                 list(model = model, group = group, wiggle = as.list(wiggle), wiggle_sd = wsd,
                                      chains = chains, burnin = burnin, sample = sample))
  )
}
