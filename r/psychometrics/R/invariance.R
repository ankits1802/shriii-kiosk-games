# Multi-group CFA measurement invariance (plan VAL-07, VAL-08a).
#
# Nested steps are fitted with semTools::measEq.syntax (lavaan underneath):
#   continuous: configural -> metric (loadings) -> scalar (+ intercepts) -> strict (+ residuals)
#   ordinal:    configural -> thresholds -> metric (+ loadings) -> scalar (+ intercepts) -> strict (+ residuals)
#               (Wu & Estabrook 2016 identification, WLSMV, theta parameterization when strict is requested)
# Each step is judged against the previous retained step with change-in-fit rules (Chen 2007; Cheung &
# Rensvold 2002) whose thresholds come from YAML. When a step fails, a partial invariance search releases
# the equality constraint with the largest score-test statistic (lavTestScore) one at a time, up to the
# pre-registered maximum share of freed parameters.

.robust_estimators <- c("MLR", "MLM", "MLMV", "MLMVS", "WLSMV", "WLSM", "ULSMV", "ULSM")
.level_codes <- c(none = 0, configural = 1, thresholds = 1, metric = 2, scalar = 3, strict = 4)
.step_ops <- c(thresholds = "|", metric = "=~", scalar = "~1", strict = "~~")

.group_equal_for <- function(step, ordinal) {
  cont <- list(configural = "", metric = "loadings", scalar = c("loadings", "intercepts"),
               strict = c("loadings", "intercepts", "residuals"))
  ord <- list(configural = "", thresholds = "thresholds", metric = c("thresholds", "loadings"),
              scalar = c("thresholds", "loadings", "intercepts"),
              strict = c("thresholds", "loadings", "intercepts", "residuals"))
  (if (ordinal) ord else cont)[[step]]
}

.fit_invariance_step <- function(model, data, group, step, ordered, estimator, missing, parameterization,
                                 group_partial) {
  ordinal <- length(ordered) > 0
  args <- list(
    configural.model = model, data = data, group = group, ID.fac = "std.lv",
    group.equal = .group_equal_for(step, ordinal), return.fit = TRUE,
    estimator = estimator, missing = missing
  )
  if (length(group_partial)) args$group.partial <- group_partial
  if (ordinal) {
    args$ordered <- ordered
    args$ID.cat <- "Wu.Estabrook.2016"
    args$parameterization <- parameterization
  }
  do.call(semTools::measEq.syntax, args)
}

.fit_indices <- function(fit, robust) {
  fm <- tryCatch(lavaan::fitMeasures(fit), error = function(e) NULL)
  if (is.null(fm)) return(list(chisq = NA, df = NA, pvalue = NA, cfi = NA, rmsea = NA, srmr = NA, type = NA))
  pick <- function(base, suffixes) {
    for (s in suffixes) {
      nm <- paste0(base, s)
      if (nm %in% names(fm) && is.finite(fm[[nm]])) return(unname(fm[[nm]]))
    }
    NA_real_
  }
  sfx <- if (robust) c(".robust", ".scaled", "") else ""
  chi_sfx <- if (robust) c(".scaled", "") else ""
  type <- if (!robust) "standard" else if ("cfi.robust" %in% names(fm) && is.finite(fm[["cfi.robust"]])) "robust" else "scaled"
  list(
    chisq = pick("chisq", chi_sfx), df = pick("df", chi_sfx), pvalue = pick("pvalue", chi_sfx),
    cfi = pick("cfi", sfx), rmsea = pick("rmsea", sfx), srmr = pick("srmr", ""), type = type
  )
}

.lrt <- function(fit_prev, fit_cur) {
  out <- tryCatch(
    suppressWarnings(lavaan::lavTestLRT(fit_prev, fit_cur)),
    error = function(e) NULL
  )
  if (is.null(out) || nrow(out) < 2) return(list(chisq_diff = NA, df_diff = NA, p = NA))
  list(
    chisq_diff = .safe_num(out[2, "Chisq diff"]),
    df_diff = .safe_num(out[2, "Df diff"]),
    p = .safe_num(out[2, "Pr(>Chisq)"])
  )
}

.judge <- function(prev, cur, step, th) {
  d_cfi <- cur$cfi - prev$cfi
  d_rmsea <- cur$rmsea - prev$rmsea
  d_srmr <- cur$srmr - prev$srmr
  srmr_max <- if (step == "metric") .th(th, "invariance", "delta_srmr_metric_max") else .th(th, "invariance", "delta_srmr_scalar_max")
  eps <- 1e-12
  ok_cfi <- is.finite(d_cfi) && d_cfi >= -.th(th, "invariance", "delta_cfi_max_drop") - eps
  ok_rmsea <- if (is.finite(d_rmsea)) d_rmsea <= .th(th, "invariance", "delta_rmsea_max_increase") + eps else NA
  ok_srmr <- if (is.finite(d_srmr)) d_srmr <= srmr_max + eps else NA
  rule <- .th(th, "invariance", "decision_rule")
  supplementary <- c(ok_rmsea, ok_srmr)
  supplementary <- supplementary[!is.na(supplementary)]
  passed <- if (identical(rule, "chen2007")) {
    ok_cfi || (length(supplementary) > 0 && all(supplementary))
  } else if (identical(rule, "all")) {
    ok_cfi && all(supplementary)
  } else {
    stop(sprintf("unknown invariance decision_rule %s", rule))
  }
  list(passed = passed, delta_cfi = d_cfi, delta_rmsea = d_rmsea, delta_srmr = d_srmr,
       ok_cfi = ok_cfi, ok_rmsea = ok_rmsea, ok_srmr = ok_srmr)
}

.param_id <- function(row) {
  if (row$op == "~1") paste0(row$lhs, "~1") else paste0(row$lhs, row$op, row$rhs)
}

# Score tests for the equality constraints of `op` in `fit`: data.frame(param, X2, df, p).
.score_candidates <- function(fit, op) {
  st <- tryCatch(lavaan::lavTestScore(fit, epc = FALSE, warn = FALSE)$uni, error = function(e) NULL)
  if (is.null(st) || !nrow(st)) return(data.frame(param = character(), X2 = numeric(), df = numeric(), p = numeric()))
  pt <- lavaan::parTable(fit)
  resolve <- function(lab) {
    rows <- pt[pt$plabel == lab | (nzchar(pt$label) & pt$label == lab), , drop = FALSE]
    rows <- rows[rows$op == op, , drop = FALSE]
    if (op == "~~") rows <- rows[rows$lhs == rows$rhs, , drop = FALSE]
    if (!nrow(rows)) return(NA_character_)
    ids <- unique(vapply(seq_len(nrow(rows)), function(i) .param_id(rows[i, ]), character(1)))
    if (length(ids) != 1) NA_character_ else ids
  }
  ids <- vapply(seq_len(nrow(st)), function(i) {
    a <- resolve(st$lhs[i])
    if (is.na(a)) resolve(st$rhs[i]) else a
  }, character(1))
  keep <- !is.na(ids)
  if (!any(keep)) return(data.frame(param = character(), X2 = numeric(), df = numeric(), p = numeric()))
  df <- data.frame(param = ids[keep], X2 = st$X2[keep], df = st$df[keep], p = st$p.value[keep], stringsAsFactors = FALSE)
  agg <- do.call(rbind, lapply(split(df, df$param), function(d) d[which.max(d$X2), , drop = FALSE]))
  agg <- agg[order(-agg$X2), , drop = FALSE]
  rownames(agg) <- NULL
  agg
}

#' Multi-group CFA measurement invariance with decision rules and partial invariance search.
#'
#' @param data data.frame.
#' @param model lavaan model syntax (the configural model).
#' @param group grouping column.
#' @param estimator lavaan estimator; default WLSMV when `ordered` is non-empty, else MLR.
#' @param ordered ordinal indicator names (TRUE = all indicators).
#' @param levels steps to test (configural is always fitted).
#' @param partial list(search = TRUE, free = character(), max_freed_share = <YAML>).
#' @param missing lavaan missing-data handling (default "fiml" for ML-family, "pairwise" for WLSMV).
#' @param parameterization "delta" or "theta" (ordinal only; theta is forced for strict).
#' @param thresholds resolved thresholds list.
#' @export
measurement_invariance <- function(data, model, group, estimator = NULL, ordered = character(),
                                   levels = c("configural", "metric", "scalar"), partial = list(),
                                   missing = NULL, parameterization = NULL, thresholds = resolve_thresholds(),
                                   inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "measurement_invariance"
  th <- thresholds
  warns <- character()
  if (!is.character(model) || !nzchar(model)) stop("`model` (lavaan syntax) is required")
  .require_columns(data, group, "group column")
  ov <- lavaan::lavaanNames(lavaan::lavaanify(model), "ov")
  .require_columns(data, ov, "indicator")
  if (isTRUE(ordered)) ordered <- ov
  ordered <- .as_char_vec(ordered)
  ordinal <- length(ordered) > 0
  if (any(is.na(data[[group]]))) {
    warns <- c(warns, sprintf("%d rows with missing group dropped", sum(is.na(data[[group]]))))
    data <- data[!is.na(data[[group]]), , drop = FALSE]
  }
  data[[group]] <- as.character(data[[group]])
  group_n <- as.list(table(data[[group]]))
  if (length(group_n) < 2) {
    return(psy_unavailable(analysis, "lavaan_semTools", "at least two groups are needed", n = nrow(data),
                           provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  estimator <- estimator %||% (if (ordinal) "WLSMV" else "MLR")
  missing <- missing %||% (if (estimator %in% c("WLSMV", "WLSM", "ULSMV", "ULSM", "DWLS", "WLS")) "pairwise" else "fiml")
  levels <- unique(c("configural", intersect(.as_char_vec(levels), c("thresholds", "metric", "scalar", "strict"))))
  if (ordinal && "metric" %in% levels && !"thresholds" %in% levels) levels <- append(levels, "thresholds", after = 1)
  if (!ordinal) levels <- setdiff(levels, "thresholds")
  levels <- intersect(c("configural", "thresholds", "metric", "scalar", "strict"), levels)
  if (ordinal) {
    parameterization <- parameterization %||% (if ("strict" %in% levels) "theta" else "delta")
    if ("strict" %in% levels && parameterization != "theta") {
      warns <- c(warns, "strict invariance with ordinal items needs the theta parameterization; switched to theta")
      parameterization <- "theta"
    }
  }
  robust <- estimator %in% .robust_estimators
  small_n <- .th(th, "invariance", "small_group_n")
  for (g in names(group_n)) {
    if (group_n[[g]] < small_n) {
      warns <- c(warns, sprintf(
        "group '%s' has n = %d (< %d): consider Bayesian approximate invariance or moderated MIMIC (VAL-08a)",
        g, group_n[[g]], small_n
      ))
    }
  }
  do_search <- if (is.null(partial$search)) TRUE else isTRUE(partial$search)
  max_share <- partial$max_freed_share %||% .th(th, "invariance", "max_freed_parameter_share")
  alpha <- partial$alpha %||% .th(th, "invariance", "partial_search_alpha")
  freed <- .as_char_vec(partial$free)

  fit_step <- function(step, gp) {
    res <- .collect_warnings(tryCatch(
      .fit_invariance_step(model, data, group, step, ordered, estimator, missing, parameterization, gp),
      error = function(e) e
    ))
    res
  }
  describe <- function(step, fit, fit_warns) {
    conv <- isTRUE(tryCatch(lavaan::lavInspect(fit, "converged"), error = function(e) FALSE))
    post <- tryCatch(suppressWarnings(lavaan::lavInspect(fit, "post.check")), error = function(e) NA)
    idx <- .fit_indices(fit, robust)
    c(list(step = step, converged = conv, admissible = isTRUE(post)), idx, list(fit_warnings = fit_warns))
  }

  steps <- list()
  assumptions <- list()
  fits <- list()
  achieved <- "none"
  partial_used <- FALSE
  freed_by_step <- list()
  prev <- NULL
  n_total <- NA_integer_

  for (step in levels) {
    gp <- freed
    out <- fit_step(step, gp)
    if (inherits(out$value, "error")) {
      warns <- c(warns, sprintf("%s model failed: %s", step, conditionMessage(out$value)))
      steps[[length(steps) + 1]] <- list(step = step, converged = FALSE, passed = FALSE,
                                         error = conditionMessage(out$value))
      break
    }
    fit <- out$value
    info <- describe(step, fit, out$warnings)
    if (is.na(n_total)) n_total <- as.integer(lavaan::lavInspect(fit, "ntotal"))
    assumptions[[length(assumptions) + 1]] <- assumption(
      paste0(step, "_converged"), info$converged, detail = "lavaan optimizer convergence"
    )
    assumptions[[length(assumptions) + 1]] <- assumption(
      paste0(step, "_admissible"), info$admissible,
      detail = "lavaan post.check (no negative variances / Heywood cases)"
    )
    if (!info$converged) {
      info$passed <- FALSE
      steps[[length(steps) + 1]] <- info
      warns <- c(warns, sprintf("%s model did not converge; testing stopped", step))
      break
    }
    if (step == "configural") {
      ok <- is.finite(info$cfi) && info$cfi >= .th(th, "invariance", "configural_cfi_min") &&
        (!is.finite(info$rmsea) || info$rmsea <= .th(th, "invariance", "configural_rmsea_max")) &&
        (!is.finite(info$srmr) || info$srmr <= .th(th, "invariance", "configural_srmr_max"))
      info$passed <- ok
      assumptions[[length(assumptions) + 1]] <- assumption(
        "configural_fit_acceptable", ok, info$cfi,
        sprintf("CFI >= %s, RMSEA <= %s, SRMR <= %s", .th(th, "invariance", "configural_cfi_min"),
                .th(th, "invariance", "configural_rmsea_max"), .th(th, "invariance", "configural_srmr_max"))
      )
      steps[[length(steps) + 1]] <- info
      fits[[step]] <- fit
      if (!ok) {
        warns <- c(warns, "configural model fit is not acceptable; invariance testing stopped")
        break
      }
      achieved <- "configural"
      prev <- list(info = info, fit = fit)
      next
    }
    lrt <- .lrt(prev$fit, fit)
    j <- .judge(prev$info, info, step, th)
    info <- c(info, j, list(lrt_chisq_diff = lrt$chisq_diff, lrt_df_diff = lrt$df_diff, lrt_p = lrt$p,
                            compared_to = prev$info$step, freed = list()))
    if (is.finite(lrt$df_diff) && lrt$df_diff == 0) {
      info$passed <- TRUE
      info$note <- "no additional constraints at this step under the chosen identification (equivalent model)"
    }
    step_freed <- character()
    if (!info$passed && do_search && step %in% names(.step_ops)) {
      op <- .step_ops[[step]]
      cand0 <- .score_candidates(fit, op)
      n_constrained <- nrow(cand0)
      max_free <- floor(max_share * n_constrained + 1e-9)
      cur_fit <- fit
      cur_info <- info
      cand <- cand0
      while (!cur_info$passed && length(step_freed) < max_free && nrow(cand) > 0) {
        cand <- cand[!cand$param %in% c(freed, step_freed), , drop = FALSE]
        if (!nrow(cand) || !is.finite(cand$p[1]) || cand$p[1] >= alpha) break
        step_freed <- c(step_freed, cand$param[1])
        out2 <- fit_step(step, c(freed, step_freed))
        if (inherits(out2$value, "error")) {
          warns <- c(warns, sprintf("partial %s model failed: %s", step, conditionMessage(out2$value)))
          break
        }
        cur_fit <- out2$value
        i2 <- describe(step, cur_fit, out2$warnings)
        lrt2 <- .lrt(prev$fit, cur_fit)
        j2 <- .judge(prev$info, i2, step, th)
        cur_info <- c(i2, j2, list(lrt_chisq_diff = lrt2$chisq_diff, lrt_df_diff = lrt2$df_diff, lrt_p = lrt2$p,
                                   compared_to = prev$info$step))
        if (!i2$converged) {
          cur_info$passed <- FALSE
          break
        }
        cand <- .score_candidates(cur_fit, op)
      }
      cur_info$freed <- as.list(step_freed)
      cur_info$n_constrained_parameters <- n_constrained
      cur_info$max_freed <- max_free
      cur_info$freed_share <- if (n_constrained > 0) length(step_freed) / n_constrained else 0
      cur_info$full_model <- info[c("chisq", "df", "cfi", "rmsea", "srmr", "delta_cfi", "delta_rmsea", "delta_srmr")]
      if (length(step_freed) && cur_info$passed) {
        partial_used <- TRUE
        freed <- c(freed, step_freed)
        freed_by_step[[step]] <- step_freed
      } else if (length(step_freed) && !cur_info$passed) {
        warns <- c(warns, sprintf(
          "%s invariance not reached after freeing %s (limit %d of %d constrained parameters)",
          step, paste(step_freed, collapse = ", "), max_free, n_constrained
        ))
      }
      info <- cur_info
      fit <- cur_fit
    }
    info$partial <- length(step_freed) > 0 && isTRUE(info$passed)
    steps[[length(steps) + 1]] <- info
    if (!isTRUE(info$passed)) break
    fits[[step]] <- fit
    if (step != "thresholds") achieved <- step
    prev <- list(info = info, fit = fit)
  }

  required <- .th(th, "invariance", "required_level")
  level_code <- .level_codes[[achieved]]
  passes_required <- level_code >= .level_codes[[required]]
  decision <- if (achieved %in% c("none", "configural")) achieved else if (partial_used) paste0("partial_", achieved) else achieved
  step_records <- lapply(steps, function(s) {
    s$fit_warnings <- as.list(s$fit_warnings %||% character())
    s$freed <- as.list(.as_char_vec(s$freed))
    lapply(s, function(v) if (is.numeric(v) && length(v) == 1 && !is.finite(v)) NULL else v)
  })
  details <- list(
    decision = decision,
    level = achieved,
    level_code_legend = as.list(.level_codes[c("none", "configural", "metric", "scalar", "strict")]),
    partial = partial_used,
    freed_parameters = lapply(freed_by_step, as.list),
    user_freed_parameters = as.list(.as_char_vec(partial$free)),
    required_level = required,
    passes_required_level = passes_required,
    steps = step_records,
    groups = group_n,
    estimator = estimator,
    missing = missing,
    ordered = as.list(ordered),
    parameterization = parameterization,
    identification = if (ordinal) "Wu.Estabrook.2016 + std.lv" else "std.lv",
    fit_index_type = if (length(steps)) steps[[1]]$type else NA,
    decision_rule = .th(th, "invariance", "decision_rule"),
    thresholds = th$invariance
  )
  method <- sprintf("lavaan/semTools multi-group CFA (%s; %s)", estimator,
                    if (ordinal) "ordinal, Wu & Estabrook 2016" else "continuous")
  params <- list(model = model, group = group, estimator = estimator, ordered = as.list(ordered),
                 levels = as.list(levels), partial = partial, missing = missing)
  psy_result(
    analysis = analysis, estimate = level_code, n = if (is.na(n_total)) nrow(data) else n_total,
    method = method, status = if (length(steps) && isTRUE(steps[[1]]$converged)) "ok" else "failed",
    assumptions = assumptions, warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed, params)
  )
}
