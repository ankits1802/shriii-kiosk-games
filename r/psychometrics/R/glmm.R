# Trial-level mixed models: explanatory IRT / GLMM DIF (plan VAL-08, VAL-09) and person random slopes
# with model-based reliability (plan SCR-09 composure slopes, VAL-04 "model parameters").

.glmm_families <- c("binomial", "gaussian", "poisson", "nbinom2", "Gamma", "beta", "lognormal")

.fit_mixed <- function(formula, data, family, engine = NULL) {
  engine <- engine %||% (if (family %in% c("binomial", "gaussian")) "lme4" else "glmmTMB")
  if (engine == "lme4") {
    if (family == "binomial") {
      return(lme4::glmer(formula, data = data, family = stats::binomial(),
                         control = lme4::glmerControl(optimizer = "bobyqa", optCtrl = list(maxfun = 2e5))))
    }
    if (family == "gaussian") {
      return(lme4::lmer(formula, data = data, REML = FALSE,
                        control = lme4::lmerControl(optimizer = "bobyqa", optCtrl = list(maxfun = 2e5))))
    }
    stop(sprintf("lme4 engine supports binomial and gaussian only, not %s", family))
  }
  if (engine != "glmmTMB") stop(sprintf("unknown engine %s", engine))
  fam <- switch(family,
    binomial = stats::binomial(), gaussian = stats::gaussian(), poisson = stats::poisson(),
    nbinom2 = glmmTMB::nbinom2(), Gamma = stats::Gamma(link = "log"), beta = glmmTMB::beta_family(),
    lognormal = glmmTMB::lognormal(),
    stop(sprintf("unsupported family %s", family))
  )
  glmmTMB::glmmTMB(formula, data = data, family = fam)
}

.fixef_table <- function(fit) {
  if (inherits(fit, "glmmTMB")) {
    cf <- summary(fit)$coefficients$cond
  } else {
    cf <- stats::coef(summary(fit))
  }
  data.frame(term = rownames(cf), estimate = cf[, 1], se = cf[, 2], stringsAsFactors = FALSE)
}

.resid_sd <- function(fit) {
  s <- tryCatch(stats::sigma(fit), error = function(e) NA_real_)
  if (is.finite(s)) s else NA_real_
}

.prep_trials <- function(data, cols, response, transform, warns) {
  .require_columns(data, cols)
  df <- data[, unique(cols), drop = FALSE]
  n0 <- nrow(df)
  df <- df[stats::complete.cases(df), , drop = FALSE]
  if (nrow(df) < n0) warns <- c(warns, sprintf("%d trials with missing values dropped", n0 - nrow(df)))
  if (!is.null(transform)) {
    if (transform == "log") {
      bad <- df[[response]] <= 0
      if (any(bad)) {
        warns <- c(warns, sprintf("%d non-positive responses dropped before log transform", sum(bad)))
        df <- df[!bad, , drop = FALSE]
      }
      df[[response]] <- log(df[[response]])
    } else {
      stop(sprintf("unsupported transform %s", transform))
    }
  }
  list(df = df, warnings = warns)
}

#' Explanatory IRT / GLMM DIF for trial-level data with iterative anchor purification and BH-FDR.
#'
#' Model (De Boeck et al. 2011): response ~ 0 + item + group + covariates + (1 | person) + DIF terms.
#' Each item's DIF term is item-specific x group (G - 1 df) tested by likelihood ratio, with the terms of
#' currently flagged items freed (purified anchors = unflagged items); iterated until the flagged set is
#' stable. An omnibus random item x group variance test is reported too.
#' @export
glmm_dif <- function(data, person, item, group, response, family = "binomial", covariates = character(),
                     transform = NULL, reference = NULL, omnibus = TRUE, engine = NULL,
                     thresholds = resolve_thresholds(), inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "glmm_dif"
  stopifnot(family %in% .glmm_families)
  method <- sprintf("explanatory_irt_glmm_%s", family)
  covariates <- .as_char_vec(covariates)
  prep <- .prep_trials(data, c(person, item, group, response, covariates), response, transform, character())
  df <- prep$df
  warns <- prep$warnings
  df[[person]] <- factor(df[[person]])
  items <- sort(unique(as.character(df[[item]])))
  df[[".item"]] <- factor(as.character(df[[item]]), levels = items)
  glev <- sort(unique(as.character(df[[group]])))
  if (!is.null(reference)) glev <- c(reference, setdiff(glev, reference))
  df[[".group"]] <- factor(as.character(df[[group]]), levels = glev)
  if (length(glev) < 2 || length(items) < 2) {
    return(psy_unavailable(analysis, method, "needs at least two groups and two items",
                           n = nlevels(df[[person]]), provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  focal <- glev[-1]
  dif_cols <- list()
  for (ii in seq_along(items)) {
    cols <- character()
    for (gi in seq_along(focal)) {
      nm <- sprintf(".dif_%d_%d", ii, gi)
      df[[nm]] <- as.numeric(df$.item == items[ii] & df$.group == focal[gi])
      cols <- c(cols, nm)
    }
    dif_cols[[items[ii]]] <- cols
  }
  cov_terms <- if (length(covariates)) paste("+", paste(sprintf("`%s`", covariates), collapse = " + ")) else ""
  base_rhs <- sprintf("0 + .item + .group %s + (1 | `%s`)", cov_terms, person)
  resp_term <- sprintf("`%s`", response)
  fit_with <- function(freed) {
    terms <- unlist(dif_cols[freed])
    rhs <- if (length(terms)) paste(base_rhs, "+", paste(terms, collapse = " + ")) else base_rhs
    r <- .collect_warnings(.fit_mixed(stats::as.formula(paste(resp_term, "~", rhs)), df, family, engine))
    warns <<- c(warns, r$warnings)
    r$value
  }
  ll <- function(fit) as.numeric(stats::logLik(fit))
  alpha <- .th(thresholds, "dif", "fdr_alpha")
  max_iter <- .th(thresholds, "dif", "purification_max_iter")
  if (!is.null(seed)) set.seed(seed)
  flagged <- character()
  history <- list()
  table_out <- NULL
  for (iter in seq_len(max_iter)) {
    shared <- fit_with(flagged)
    rows <- lapply(items, function(it) {
      if (it %in% flagged) {
        full <- shared
        base <- fit_with(setdiff(flagged, it))
      } else {
        base <- shared
        full <- fit_with(c(flagged, it))
      }
      lr <- max(0, 2 * (ll(full) - ll(base)))
      dfree <- length(dif_cols[[it]])
      ft <- .fixef_table(full)
      eff <- ft[ft$term %in% dif_cols[[it]], , drop = FALSE]
      k <- if (nrow(eff)) which.max(abs(eff$estimate)) else NA
      data.frame(
        item = it, lr_chisq = lr, df = dfree, p = stats::pchisq(lr, dfree, lower.tail = FALSE),
        effect = if (is.na(k)) NA_real_ else eff$estimate[k],
        se = if (is.na(k)) NA_real_ else eff$se[k],
        focal_group = if (is.na(k)) NA_character_ else focal[match(eff$term[k], dif_cols[[it]])],
        resid_sd = .resid_sd(full),
        stringsAsFactors = FALSE
      )
    })
    tab <- do.call(rbind, rows)
    tab$q <- .bh(tab$p)
    new_flagged <- tab$item[is.finite(tab$q) & tab$q < alpha]
    if (length(new_flagged) >= length(items)) {
      keep <- tab$item[which.min(tab$lr_chisq)]
      new_flagged <- setdiff(new_flagged, keep)
      warns <- c(warns, sprintf("every item flagged; item %s kept as the single anchor for identification", keep))
    }
    history[[iter]] <- list(iteration = iter, flagged = as.list(new_flagged))
    table_out <- tab
    if (setequal(new_flagged, flagged)) break
    if (iter == max_iter) warns <- c(warns, "anchor purification did not stabilise within purification_max_iter")
    flagged <- new_flagged
  }
  flagged <- table_out$item[is.finite(table_out$q) & table_out$q < alpha]
  eff_level <- .th(thresholds, "dif", "effect_ci_level")
  z <- stats::qnorm(1 - (1 - eff_level) / 2)
  table_out$ci_low <- table_out$effect - z * table_out$se
  table_out$ci_high <- table_out$effect + z * table_out$se
  if (family == "binomial") {
    table_out$ets_delta <- 2.35 * abs(table_out$effect)
    mag <- table_out$ets_delta
    lo <- .th(thresholds, "dif", "ets_delta_moderate")
    hi <- .th(thresholds, "dif", "ets_delta_large")
  } else {
    table_out$std_effect <- abs(table_out$effect) / table_out$resid_sd
    mag <- table_out$std_effect
    lo <- .th(thresholds, "dif", "gaussian_d_moderate")
    hi <- .th(thresholds, "dif", "gaussian_d_large")
  }
  sig <- is.finite(table_out$q) & table_out$q < alpha
  table_out$flagged <- sig
  table_out$class <- ifelse(!sig | !is.finite(mag) | mag < lo, "A", ifelse(mag < hi, "B", "C"))
  omni <- NULL
  if (isTRUE(omnibus) && family %in% c("binomial", "gaussian")) {
    omni <- tryCatch({
      f0 <- stats::as.formula(sprintf("%s ~ .group %s + (1 | `%s`) + (1 | .item)", resp_term, cov_terms, person))
      f1 <- stats::as.formula(sprintf("%s ~ .group %s + (1 | `%s`) + (1 | .item) + (1 | .item:.group)",
                                      resp_term, cov_terms, person))
      m0 <- suppressWarnings(suppressMessages(.fit_mixed(f0, df, family, "lme4")))
      m1 <- suppressWarnings(suppressMessages(.fit_mixed(f1, df, family, "lme4")))
      lr <- max(0, 2 * (ll(m1) - ll(m0)))
      vc <- as.data.frame(lme4::VarCorr(m1))
      list(lr_chisq = lr, p = 0.5 * stats::pchisq(lr, 1, lower.tail = FALSE),
           item_by_group_sd = .safe_num(vc$sdcor[vc$grp == ".item:.group"][1]),
           note = "boundary-corrected (50:50 chi-square mixture) LR test of random item x group variance")
    }, error = function(e) list(error = conditionMessage(e)))
  }
  impact <- tryCatch({
    ft <- .fixef_table(fit_with(flagged))
    imp <- ft[startsWith(ft$term, ".group"), , drop = FALSE]
    imp$term <- sub("^\\.group", "", imp$term)
    .records(imp)
  }, error = function(e) NULL)
  details <- list(
    items = .records(table_out),
    flagged = as.list(flagged),
    anchors = as.list(setdiff(items, flagged)),
    purification = history,
    omnibus_random_dif = omni,
    impact = impact,
    reference_group = glev[1],
    effect_ci_level = eff_level,
    effect_scale = if (family == "binomial") "log-odds (focal minus reference, item-specific)" else
      sprintf("%s response units%s", family, if (!is.null(transform)) paste0(" after ", transform) else ""),
    n_trials = nrow(df), n_items = length(items),
    groups = as.list(table(df$.group[!duplicated(df[[person]])]))
  )
  psy_result(
    analysis = analysis, estimate = mean(table_out$flagged), n = nlevels(df[[person]]), method = method,
    assumptions = list(assumption("anchors_remaining", length(items) - length(flagged) >= 1,
                                  length(items) - length(flagged), "at least one unflagged anchor item")),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed,
                                 list(person = person, item = item, group = group, response = response,
                                      family = family, covariates = as.list(covariates), transform = transform))
  )
}

.slope_reliability <- function(fit, person, cond_term) {
  vc <- as.data.frame(lme4::VarCorr(fit))
  tau2 <- vc$vcov[vc$grp == person & vc$var1 == cond_term & is.na(vc$var2)]
  tau2 <- if (length(tau2)) tau2[1] else NA_real_
  re <- as.data.frame(lme4::ranef(fit, condVar = TRUE))
  re <- re[re$grpvar == person & re$term == cond_term, , drop = FALSE]
  pev <- mean(re$condsd^2)
  rel <- if (is.finite(tau2) && tau2 > 1e-10) max(0, min(1, 1 - pev / tau2)) else 0
  list(reliability = rel, tau2 = tau2, mean_pev = pev, ranef = re)
}

#' Person random slopes (e.g. composure: accuracy under pressure vs no pressure) with model-based
#' reliability.
#'
#' Fits response ~ condition + covariates + (1 + condition | person) [+ (1 | item)] as a logistic mixed
#' model (binomial) or linear mixed model (gaussian, e.g. log RT). The logistic link avoids the ceiling
#' compression of raw accuracy differences. Reliability of the person slopes is the empirical-Bayes ratio
#' 1 - mean(PEV) / tau^2 with a parametric bootstrap CI.
#' @export
person_random_slopes <- function(data, person, condition, response, family = "binomial", focal = NULL,
                                 item = NULL, covariates = character(), transform = NULL, bootstrap_n = NULL,
                                 ci_level = NULL, thresholds = resolve_thresholds(),
                                 inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "person_random_slopes"
  if (!family %in% c("binomial", "gaussian")) stop("person_random_slopes supports binomial and gaussian families")
  method <- if (family == "binomial") "glmer_logistic_random_slope_eb_reliability" else "lmer_random_slope_eb_reliability"
  covariates <- .as_char_vec(covariates)
  cols <- c(person, condition, response, covariates, item)
  prep <- .prep_trials(data, cols, response, transform, character())
  df <- prep$df
  warns <- prep$warnings
  cv <- df[[condition]]
  if (is.numeric(cv) && length(unique(cv)) > 2) {
    df$.cond <- as.numeric(cv)
    cond_desc <- "numeric (slope per unit)"
  } else {
    lv <- sort(unique(as.character(cv)))
    if (length(lv) != 2) {
      return(psy_unavailable(analysis, method, "condition needs exactly two levels (or a numeric covariate)",
                             n = length(unique(df[[person]])), provenance = make_provenance(analysis, inputs_sha256, seed)))
    }
    foc <- if (!is.null(focal)) as.character(focal) else lv[2]
    if (!foc %in% lv) stop(sprintf("focal level %s not present in %s", foc, condition))
    df$.cond <- as.numeric(as.character(cv) == foc)
    cond_desc <- sprintf("%s = 1 vs %s = 0", foc, setdiff(lv, foc))
  }
  df[[person]] <- factor(df[[person]])
  cov_terms <- if (length(covariates)) paste("+", paste(sprintf("`%s`", covariates), collapse = " + ")) else ""
  item_term <- if (!is.null(item)) sprintf("+ (1 | `%s`)", item) else ""
  fml <- stats::as.formula(sprintf("`%s` ~ .cond %s + (1 + .cond | `%s`) %s", response, cov_terms, person, item_term))
  if (!is.null(seed)) set.seed(seed)
  fitted <- .collect_warnings(.fit_mixed(fml, df, family, "lme4"))
  fit <- fitted$value
  warns <- c(warns, fitted$warnings)
  singular <- lme4::isSingular(fit)
  if (singular) warns <- c(warns, "singular fit: person slope variance at or near zero; difference-based construct may stay research_only")
  rel <- .slope_reliability(fit, person, ".cond")
  ft <- .fixef_table(fit)
  fx <- ft[ft$term == ".cond", ]
  vc <- as.data.frame(lme4::VarCorr(fit))
  sd_int <- vc$sdcor[vc$grp == person & vc$var1 == "(Intercept)" & is.na(vc$var2)][1]
  sd_slope <- vc$sdcor[vc$grp == person & vc$var1 == ".cond" & is.na(vc$var2)][1]
  corr <- vc$sdcor[vc$grp == person & !is.na(vc$var2)][1]
  slopes <- data.frame(person = as.character(rel$ranef$grp), slope = fx$estimate + rel$ranef$condval,
                       slope_se = rel$ranef$condsd, stringsAsFactors = FALSE)
  B <- bootstrap_n %||% .th(thresholds, "slopes", "bootstrap_n")
  level <- ci_level %||% .th(thresholds, "slopes", "ci_level")
  z <- stats::qnorm(1 - (1 - level) / 2)
  ci <- c(NA_real_, NA_real_)
  boot_ok <- NA
  if (B > 0) {
    bt <- .collect_warnings(tryCatch(
      lme4::bootMer(fit, FUN = function(m) .slope_reliability(m, person, ".cond")$reliability, nsim = B,
                    type = "parametric", use.u = FALSE, seed = seed),
      error = function(e) e
    ))
    if (inherits(bt$value, "error")) {
      warns <- c(warns, paste("bootstrap failed:", conditionMessage(bt$value)))
    } else {
      vals <- bt$value$t[, 1]
      vals <- vals[is.finite(vals)]
      boot_ok <- length(vals)
      if (length(vals) >= 10) ci <- stats::quantile(vals, c((1 - level) / 2, 1 - (1 - level) / 2), names = FALSE)
      if (length(bt$warnings)) warns <- c(warns, sprintf("%d warning(s) during bootstrap refits", length(bt$warnings)))
    }
  } else {
    warns <- c(warns, "bootstrap_n = 0: reliability reported without a CI")
  }
  ceiling <- NULL
  if (family == "binomial") {
    acc <- stats::aggregate(df[[response]], by = list(person = df[[person]], cond = df$.cond), FUN = mean)
    thr <- .th(thresholds, "slopes", "ceiling_accuracy")
    by_cond <- lapply(split(acc$x, acc$cond), function(v) mean(v >= thr))
    ceiling <- list(threshold = thr, share_at_ceiling = by_cond)
    flag <- .th(thresholds, "slopes", "ceiling_share_flag")
    if (any(unlist(by_cond) > flag)) {
      warns <- c(warns, sprintf("more than %.0f%% of persons at ceiling accuracy in a condition; raw difference scores are compressed, use the model-based slope", 100 * flag))
    }
    wide <- stats::reshape(acc, idvar = "person", timevar = "cond", direction = "wide")
    if (all(c("x.0", "x.1") %in% names(wide))) {
      raw <- wide$x.1 - wide$x.0
      m <- match(slopes$person, as.character(wide$person))
      ceiling$raw_difference_mean <- mean(raw, na.rm = TRUE)
      ceiling$raw_difference_sd <- stats::sd(raw, na.rm = TRUE)
      ceiling$slope_vs_raw_difference_r <- .safe_num(suppressWarnings(stats::cor(slopes$slope, raw[m], use = "complete.obs")))
    }
  }
  min_rel <- .th(thresholds, "slopes", "reliability_min")
  details <- list(
    fixed_slope = list(estimate = fx$estimate, se = fx$se, ci_low = fx$estimate - z * fx$se,
                       ci_high = fx$estimate + z * fx$se, ci_level = level, z = fx$estimate / fx$se,
                       p = 2 * stats::pnorm(-abs(fx$estimate / fx$se)),
                       scale = if (family == "binomial") "log-odds" else "response units"),
    random_effects = list(sd_intercept = .safe_num(sd_int), sd_slope = .safe_num(sd_slope),
                          corr_intercept_slope = .safe_num(corr), slope_variance = .safe_num(rel$tau2),
                          mean_prediction_error_variance = .safe_num(rel$mean_pev)),
    reliability_formula = "1 - mean(PEV_slope) / var(slope)  (empirical Bayes)",
    singular = singular,
    condition_coding = cond_desc,
    bootstrap = list(requested = B, successful = boot_ok, ci_level = level),
    ceiling = ceiling,
    person_slopes = .records(slopes),
    n_trials = nrow(df)
  )
  psy_result(
    analysis = analysis, estimate = rel$reliability, ci_low = ci[1], ci_high = ci[2],
    ci_level = if (all(is.finite(ci))) level else NULL, n = nlevels(df[[person]]), method = method,
    assumptions = list(
      assumption("non_singular", !singular, rel$tau2, "person slope variance estimated away from zero"),
      assumption("reliability_min", rel$reliability >= min_rel, rel$reliability, sprintf(">= %s (informational)", min_rel))
    ),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed,
                                 list(person = person, condition = condition, response = response,
                                      family = family, focal = focal, item = item,
                                      covariates = as.list(covariates), bootstrap_n = B))
  )
}
