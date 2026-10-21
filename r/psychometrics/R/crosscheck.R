# Independent R computations of key coefficients for the Python sidecar cross-check (plan VAL-01 AC:
# "R and Python agree within 1e-6 on alpha, ICC(A,1) and r").

#' ICC (irr), Cronbach's alpha (psych, Feldt CI) or Pearson r (stats::cor.test, Fisher CI).
#'
#' @param kind one of "icc_a1", "icc_c1", "alpha", "pearson".
#' @param columns rating / item columns (icc, alpha); `x`, `y` for pearson.
#' @export
reliability_cross_check <- function(data, kind, columns = NULL, x = NULL, y = NULL, ci_level = NULL,
                                    thresholds = resolve_thresholds(), inputs_sha256 = NA_character_, seed = NULL) {
  kind <- match.arg(kind, c("icc_a1", "icc_c1", "alpha", "pearson"))
  level <- ci_level %||% .th(thresholds, "icc", "ci_level")
  prov <- make_provenance(kind, inputs_sha256, seed, list(kind = kind, columns = as.list(.as_char_vec(columns)),
                                                          x = x, y = y, ci_level = level))
  if (kind == "pearson") {
    .require_columns(data, c(x, y))
    xv <- as.numeric(data[[x]])
    yv <- as.numeric(data[[y]])
    ok <- is.finite(xv) & is.finite(yv)
    if (sum(ok) < 4) return(psy_unavailable("pearson_r", "pearson_fisher_ci", "need >= 4 complete pairs", n = sum(ok), provenance = prov))
    ct <- stats::cor.test(xv[ok], yv[ok], conf.level = level)
    return(psy_result("pearson_r", unname(ct$estimate), ct$conf.int[1], ct$conf.int[2], level, sum(ok),
                      "stats_cor_test_fisher_ci", details = list(t = unname(ct$statistic), df = unname(ct$parameter),
                                                                 p = ct$p.value), provenance = prov))
  }
  columns <- .as_char_vec(columns)
  .require_columns(data, columns)
  m <- as.matrix(data.frame(lapply(data[, columns, drop = FALSE], as.numeric)))
  m <- m[stats::complete.cases(m), , drop = FALSE]
  n <- nrow(m)
  k <- ncol(m)
  if (kind == "alpha") {
    if (k < 2 || n < 3) return(psy_unavailable("cronbach_alpha", "psych_alpha", "need >= 2 items and >= 3 rows", n = n, provenance = prov))
    a <- psych::alpha(m, check.keys = FALSE, warnings = FALSE)$total$raw_alpha
    g <- 1 - level
    df1 <- n - 1
    df2 <- (n - 1) * (k - 1)
    lo <- 1 - (1 - a) * stats::qf(1 - g / 2, df1, df2)
    hi <- 1 - (1 - a) * stats::qf(g / 2, df1, df2)
    return(psy_result("cronbach_alpha", a, lo, hi, level, n, "psych_alpha_feldt_ci", details = list(k = k), provenance = prov))
  }
  if (n < 3 || k < 2) return(psy_unavailable(toupper(kind), "irr_icc", "need >= 3 targets and >= 2 ratings", n = n, provenance = prov))
  type <- if (kind == "icc_a1") "agreement" else "consistency"
  r <- irr::icc(m, model = "twoway", type = type, unit = "single", conf.level = level)
  psy_result(
    analysis = if (kind == "icc_a1") "ICC_A1" else "ICC_C1", estimate = r$value, ci_low = r$lbound,
    ci_high = r$ubound, ci_level = level, n = n, method = sprintf("irr_icc_twoway_%s_single", type),
    details = list(k = k, F = r$Fvalue, df1 = r$df1, df2 = r$df2, p = r$p.value), provenance = prov
  )
}
