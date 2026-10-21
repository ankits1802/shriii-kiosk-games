# Continuous norming on post-stratified / raked weights (plan VAL-11): cNORM (primary) or GAMLSS.

#' Raking (iterative proportional fitting) of weights to population margins, then trimming.
#'
#' @param data data.frame with the stratification columns.
#' @param margins named list: variable -> named list(level = population share).
#' @return numeric weights with mean 1, trimmed at `trim_ratio` x median.
#' @export
rake_weights <- function(data, margins, trim_ratio, max_iter = 100L, tol = 1e-8) {
  n <- nrow(data)
  w <- rep(1, n)
  vars <- names(margins)
  if (!length(vars)) stop("raking margins are empty")
  .require_columns(data, vars, "raking variable")
  cols <- lapply(vars, function(v) as.character(data[[v]]))
  names(cols) <- vars
  for (v in vars) {
    shares <- as.numeric(unlist(margins[[v]]))
    if (!length(shares) || any(!is.finite(shares)) || any(shares < 0) || abs(sum(shares) - 1) > 1e-6) {
      stop(sprintf("raking margins for %s must be non-negative population shares summing to 1", v))
    }
    unmatched <- setdiff(unique(cols[[v]]), names(margins[[v]]))
    if (length(unmatched)) {
      stop(sprintf("raking variable %s has level(s) without a population share: %s", v, paste(unmatched, collapse = ", ")))
    }
    empty <- names(margins[[v]])[shares > 0 & !names(margins[[v]]) %in% cols[[v]]]
    if (length(empty)) {
      stop(sprintf("raking variable %s has no respondents in level(s) with a positive share: %s", v, paste(empty, collapse = ", ")))
    }
  }
  for (it in seq_len(max_iter)) {
    change <- 0
    for (v in vars) {
      for (lev in names(margins[[v]])) {
        mask <- cols[[v]] == lev
        cur <- sum(w[mask]) / sum(w)
        if (cur > 0) {
          f <- as.numeric(margins[[v]][[lev]]) / cur
          w[mask] <- w[mask] * f
          change <- max(change, abs(f - 1))
        }
      }
    }
    if (change < tol) break
  }
  .trim_weights(w * (n / sum(w)), trim_ratio)
}

.percentile_crossings <- function(table) {
  # table: data.frame(age, percentile, raw); raw must strictly increase with percentile at each age.
  out <- list()
  for (a in unique(table$age)) {
    t <- table[table$age == a, , drop = FALSE]
    t <- t[order(t$percentile), ]
    d <- diff(t$raw)
    if (any(!is.finite(d)) || any(d <= 0)) out[[length(out) + 1]] <- a
  }
  unlist(out)
}

.gamlss_quantile <- function(family, p, pars) {
  qf <- get(paste0("q", family), envir = asNamespace("gamlss.dist"))
  args <- c(list(p), pars)
  names(args)[1] <- "p"
  do.call(qf, args)
}

#' Continuous norms (cNORM or GAMLSS) on weighted data with a percentile-crossing publication check.
#'
#' @param data data.frame with score, age and optional weight / education / raking columns.
#' @param score,age column names.
#' @param weights optional weight column (post-stratification weights).
#' @param margins optional raking margins (see rake_weights) used when `weights` is NULL.
#' @param education optional continuous education column (GAMLSS only).
#' @param method "cNORM" or "GAMLSS".
#' @export
continuous_norms <- function(data, score, age, weights = NULL, margins = NULL, education = NULL,
                             method = "cNORM", family = NULL, norm_table_version = NULL,
                             thresholds = resolve_thresholds(), inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "continuous_norms"
  method <- match.arg(method, c("cNORM", "GAMLSS"))
  warns <- character()
  cols <- c(score, age, weights, education, names(margins))
  .require_columns(data, cols)
  df <- data[, unique(cols), drop = FALSE]
  n0 <- nrow(df)
  df <- df[stats::complete.cases(df), , drop = FALSE]
  if (nrow(df) < n0) warns <- c(warns, sprintf("%d rows with missing values dropped", n0 - nrow(df)))
  trim <- .th(thresholds, "norming", "weight_trim_ratio")
  if (!is.null(weights)) {
    w <- as.numeric(df[[weights]])
    if (any(w < 0)) stop("weights must be non-negative")
    if (!any(w > 0)) stop("weights are all zero")
    w <- .trim_weights(w, trim)
    weight_source <- "supplied (trimmed)"
  } else if (!is.null(margins)) {
    w <- rake_weights(df, margins, trim)
    weight_source <- "raked to margins (trimmed)"
  } else {
    w <- rep(1, nrow(df))
    weight_source <- "unweighted"
    warns <- c(warns, "no weights or margins supplied: norms are not post-stratified")
  }
  n_eff <- kish_effective_n(w)
  prov_n <- .th(thresholds, "norming", "provisional_effective_n")
  final_n <- .th(thresholds, "norming", "final_min_effective_n")
  if (n_eff < prov_n) warns <- c(warns, sprintf("effective n %.0f below %d: norms are unstable", n_eff, prov_n))
  y <- as.numeric(df[[score]])
  a <- as.numeric(df[[age]])
  if (nrow(df) < 50) {
    return(psy_unavailable(analysis, method, "continuous norming needs at least 50 complete cases",
                           n = nrow(df), provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  pcts <- as.numeric(unlist(.th(thresholds, "norming", "percentiles")))
  grid_n <- .th(thresholds, "norming", "age_grid_points")
  ages <- seq(min(a), max(a), length.out = grid_n)
  if (!is.null(seed)) set.seed(seed)
  fit_info <- list()
  consistency <- NULL
  if (method == "cNORM") {
    if (!is.null(education)) warns <- c(warns, "cNORM models age only; education ignored (use method GAMLSS for age + education)")
    k <- .th(thresholds, "norming", "cnorm_k")
    t <- .th(thresholds, "norming", "cnorm_t")
    res <- .collect_warnings(.quietly(cNORM::cnorm(raw = y, age = a, weights = w, k = k, t = t, plot = FALSE)))
    model <- res$value
    warns <- c(warns, res$warnings)
    coefs <- model$model$coefficients
    r2 <- .safe_num(model$model$subsets$adjr2[[model$model$ideal.model %||% length(model$model$subsets$adjr2)]] %||% NA)
    if (!is.finite(r2)) r2 <- .safe_num(model$model$R2 %||% NA)
    tvals <- 50 + 10 * stats::qnorm(pcts / 100)
    table <- do.call(rbind, lapply(ages, function(ag) {
      raw <- vapply(tvals, function(tv) cNORM::predictRaw(tv, ag, coefs, minRaw = -Inf, maxRaw = Inf), numeric(1))
      data.frame(age = ag, percentile = pcts, raw = raw)
    }))
    consistency <- tryCatch(
      isTRUE(.quietly(suppressWarnings(cNORM::checkConsistency(
        model$model, minAge = min(a), maxAge = max(a), minNorm = min(tvals), maxNorm = max(tvals),
        minRaw = min(y), maxRaw = max(y), silent = TRUE
      )))),
      error = function(e) NA
    )
    fit_info <- list(k = k, t = t, terms = length(coefs) - 1, adj_r2 = r2,
                     cnorm_inconsistent = consistency, scale = "T")
    estimate <- r2
    est_method <- "cNORM_taylor_polynomial_adjR2"
  } else {
    fam <- family %||% (if (all(y > 0)) .th(thresholds, "norming", "gamlss_family") else "SHASHo")
    gd <- data.frame(.y = y, .age = a, .w = w)
    if (!is.null(education)) gd$.edu <- as.numeric(df[[education]])
    env <- new.env(parent = asNamespace("gamlss"))
    mu_f <- if (!is.null(education)) .y ~ pb(.age) + pb(.edu) else .y ~ pb(.age)
    sg_f <- if (!is.null(education)) ~ pb(.age) + pb(.edu) else ~ pb(.age)
    environment(mu_f) <- env
    environment(sg_f) <- env
    edu_ref <- if (!is.null(education)) stats::median(gd$.edu) else NULL
    nd <- data.frame(.age = ages)
    if (!is.null(education)) nd$.edu <- edu_ref
    # gamlss evaluates its call (data, weights) in the caller's frame, so fit and predict inside one
    # plain function whose frame holds `gd`.
    # predict.gamlss re-evaluates parts of the stored call, so embed evaluated objects (formulas, family,
    # control) and keep only `gd` / `.w` as symbols resolvable in this frame / the data.
    fam_obj <- get(fam, envir = asNamespace("gamlss.dist"))()
    ctrl <- gamlss::gamlss.control(trace = FALSE, n.cyc = 200)
    fit_predict <- function(gd, nd) {
      m <- do.call(gamlss::gamlss, list(
        formula = mu_f, sigma.formula = sg_f, nu.formula = ~1, tau.formula = ~1, family = fam_obj,
        data = quote(gd), weights = quote(.w), control = ctrl
      ))
      p <- gamlss::predictAll(m, newdata = nd, data = gd, type = "response")
      list(model = m, pred = p)
    }
    res <- .collect_warnings(.quietly(fit_predict(gd, nd)))
    model <- res$value$model
    pa <- res$value$pred
    warns <- c(warns, res$warnings)
    if (!isTRUE(model$converged)) warns <- c(warns, "GAMLSS did not converge")
    par_names <- intersect(c("mu", "sigma", "nu", "tau"), names(pa))
    table <- do.call(rbind, lapply(seq_along(ages), function(i) {
      pars <- lapply(par_names, function(p) pa[[p]][i])
      names(pars) <- par_names
      data.frame(age = ages[i], percentile = pcts, raw = .gamlss_quantile(fam, pcts / 100, pars))
    }))
    r2 <- tryCatch(.safe_num(gamlss::Rsq(model)), error = function(e) NA_real_)
    fit_info <- list(family = fam, converged = isTRUE(model$converged), global_deviance = .safe_num(model$G.deviance),
                     aic = .safe_num(stats::AIC(model)), cox_snell_r2 = r2,
                     education_reference = edu_ref, predictors = if (is.null(education)) list("age") else list("age", "education"))
    estimate <- r2
    est_method <- sprintf("GAMLSS_%s_pb_cox_snell_R2", fam)
  }
  crossing_ages <- .percentile_crossings(table)
  crossing <- length(crossing_ages) > 0 || isTRUE(consistency)
  if (crossing) warns <- c(warns, "publication blocked: percentile crossing")
  status_label <- if (n_eff >= final_n) "final_candidate" else "provisional"
  details <- list(
    norm_table = .records(table),
    percentiles = as.list(pcts),
    publishable = !crossing,
    percentile_crossing = crossing,
    crossing_ages = as.list(crossing_ages),
    norm_status = status_label,
    provisional = status_label == "provisional",
    norm_table_version = norm_table_version,
    effective_n = n_eff,
    weight_source = weight_source,
    weight_trim_ratio = trim,
    age_range = list(min(a), max(a)),
    fit = fit_info
  )
  psy_result(
    analysis = analysis, estimate = estimate, n = nrow(df), method = est_method,
    assumptions = list(
      assumption("no_percentile_crossing", !crossing, length(crossing_ages), "VAL-11 AC: a violation blocks publication"),
      assumption("effective_n_min", n_eff >= prov_n, n_eff, sprintf("Kish effective n >= %d", prov_n))
    ),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed,
                                 list(score = score, age = age, weights = weights, education = education,
                                      method = method, family = family, margins = margins,
                                      norm_table_version = norm_table_version))
  )
}
