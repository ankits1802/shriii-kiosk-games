# Item response theory: graded response models for criterion scales and likelihood-ratio IRT DIF with
# anchor selection (plan VAL-07, VAL-08a, VAL-09), via mirt.

# Recode an ordinal item to 0..K-1, merging categories with fewer than `min_n` responses into their
# smaller adjacent neighbour. Returns list(x, mapping, collapsed).
.collapse_rare <- function(x, min_n) {
  vals <- sort(unique(x[!is.na(x)]))
  groups <- as.list(vals)
  counts <- vapply(groups, function(v) sum(x %in% v), numeric(1))
  collapsed <- FALSE
  while (length(groups) > 2 && any(counts < min_n)) {
    i <- which.min(counts)
    j <- if (i == 1) 2 else if (i == length(groups)) i - 1 else if (counts[i - 1] <= counts[i + 1]) i - 1 else i + 1
    groups[[min(i, j)]] <- c(groups[[i]], groups[[j]])
    groups[[max(i, j)]] <- NULL
    counts <- vapply(groups, function(v) sum(x %in% v), numeric(1))
    collapsed <- TRUE
  }
  out <- rep(NA_integer_, length(x))
  for (k in seq_along(groups)) out[x %in% groups[[k]]] <- k - 1L
  mapping <- lapply(seq_along(groups), function(k) list(category = k - 1L, original = as.list(groups[[k]])))
  list(x = out, mapping = mapping, collapsed = collapsed, n_categories = length(groups))
}

.prepare_items <- function(data, items, min_n, warns) {
  resp <- data[, items, drop = FALSE]
  mappings <- list()
  keep <- character()
  for (it in items) {
    v <- suppressWarnings(as.numeric(resp[[it]]))
    if (all(is.na(v))) {
      warns <- c(warns, sprintf("item %s has no numeric responses and was dropped", it))
      next
    }
    cr <- .collapse_rare(v, min_n)
    if (cr$n_categories < 2) {
      warns <- c(warns, sprintf("item %s has fewer than two response categories and was dropped", it))
      next
    }
    if (cr$collapsed) warns <- c(warns, sprintf("item %s: rare categories (< %d responses) collapsed", it, min_n))
    resp[[it]] <- cr$x
    mappings[[it]] <- cr$mapping
    keep <- c(keep, it)
  }
  list(resp = resp[, keep, drop = FALSE], mappings = mappings, warnings = warns)
}

.default_items <- function(data, exclude) {
  cand <- setdiff(names(data), exclude)
  cand[vapply(cand, function(c) is.numeric(data[[c]]), logical(1))]
}

# Parameter names of item `it` in a mirt model (slopes and intercepts only).
.item_par_names <- function(mod, it) {
  cf <- mirt::coef(mod, simplify = FALSE)
  if (!is.null(cf[[1]])) cf <- cf[[1]]
  p <- colnames(cf[[it]])
  p[grepl("^(a[0-9]+|d[0-9]*|g|u)$", p) & !p %in% c("g", "u")]
}

#' Graded response model (mirt) for a criterion scale.
#' @export
irt_grm <- function(data, items = NULL, itemtype = "graded", id = NULL, return_scores = FALSE,
                    thresholds = resolve_thresholds(), inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "irt_grm"
  warns <- character()
  items <- .as_char_vec(items)
  if (!length(items)) items <- .default_items(data, c(id))
  .require_columns(data, items, "item")
  prep <- .prepare_items(data, items, .th(thresholds, "irt", "min_category_n"), warns)
  warns <- prep$warnings
  resp <- prep$resp
  resp <- resp[rowSums(!is.na(resp)) > 0, , drop = FALSE]
  if (ncol(resp) < 3 || nrow(resp) < 50) {
    return(psy_unavailable(analysis, paste0("mirt_", itemtype), "needs at least 3 items and 50 respondents",
                           n = nrow(resp), provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  if (!is.null(seed)) set.seed(seed)
  fitted <- .collect_warnings(mirt::mirt(resp, 1, itemtype = itemtype, SE = TRUE, verbose = FALSE,
                                         technical = list(NCYCLES = 2000)))
  mod <- fitted$value
  warns <- c(warns, fitted$warnings)
  converged <- isTRUE(mirt::extract.mirt(mod, "converged"))
  irt <- mirt::coef(mod, IRTpars = TRUE, printSE = TRUE)
  item_rows <- lapply(colnames(resp), function(it) {
    m <- irt[[it]]
    list(item = it, n_categories = length(unique(stats::na.omit(resp[[it]]))),
         parameters = as.list(m["par", ]), se = if ("SE" %in% rownames(m)) as.list(m["SE", ]) else NULL)
  })
  rxx <- tryCatch(as.numeric(mirt::marginal_rxx(mod)), error = function(e) NA_real_)
  fs <- tryCatch(mirt::fscores(mod, method = "EAP", full.scores.SE = TRUE), error = function(e) NULL)
  emp <- if (is.null(fs)) NA_real_ else tryCatch(as.numeric(mirt::empirical_rxx(fs)), error = function(e) NA_real_)
  m2 <- tryCatch(suppressWarnings(mirt::M2(mod, type = "C2")), error = function(e) NULL)
  m2_out <- if (is.null(m2)) NULL else lapply(as.list(m2[1, , drop = TRUE]), .safe_num)
  ifit <- tryCatch(suppressWarnings(mirt::itemfit(mod, "S_X2")), error = function(e) NULL)
  details <- list(
    items = item_rows,
    marginal_reliability = .safe_num(rxx),
    empirical_reliability = .safe_num(emp),
    m2 = m2_out,
    itemfit = if (is.null(ifit)) NULL else .records(ifit),
    converged = converged,
    loglik = .safe_num(mirt::extract.mirt(mod, "logLik")),
    category_mappings = prep$mappings,
    parameterization = "IRT (a, b) parameters"
  )
  if (isTRUE(return_scores) && !is.null(fs)) {
    ids <- if (!is.null(id) && id %in% names(data)) data[[id]][as.integer(rownames(resp))] else as.integer(rownames(resp))
    details$scores <- .records(data.frame(id = ids, theta = fs[, 1], se = fs[, 2]))
  }
  if (!converged) warns <- c(warns, "mirt EM did not converge")
  min_rel <- .th(thresholds, "irt", "marginal_reliability_min")
  m2_p <- .th(thresholds, "irt", "m2_p_min")
  m2_rmsea <- .th(thresholds, "irt", "m2_rmsea_max")
  psy_result(
    analysis = analysis, estimate = rxx, n = nrow(resp), method = paste0("mirt_", itemtype, "_marginal_rxx"),
    status = if (converged) "ok" else "failed",
    assumptions = list(
      assumption("converged", converged, detail = "mirt EM convergence"),
      assumption("marginal_reliability_min", is.finite(rxx) && rxx >= min_rel, rxx, sprintf(">= %s", min_rel)),
      assumption("m2_fit", !is.null(m2_out) && (isTRUE(m2_out$p >= m2_p) || isTRUE(m2_out$RMSEA <= m2_rmsea)),
                 m2_out$RMSEA %||% NA, sprintf("M2/C2 limited-information fit: p >= %s or RMSEA <= %s", m2_p, m2_rmsea))
    ),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed, list(items = as.list(items), itemtype = itemtype))
  )
}

.dif_row <- function(d) {
  if (is.null(d) || !nrow(d)) return(list(X2 = NA_real_, df = NA_real_, p = NA_real_))
  list(X2 = .safe_num(d$X2[1]), df = .safe_num(d$df[1]), p = .safe_num(d$p[1]))
}

#' Likelihood-ratio IRT DIF (mirt multipleGroup) with anchor selection and BH-FDR.
#'
#' Anchors: when none are supplied, every item is tested against the fully constrained model (all-other
#' anchors, scheme "drop") and the `max(min_anchors, ceiling(anchor_share * k))` items with the smallest
#' X2/df are used as anchors (Woods 2009 rank-based selection). Non-anchor items are then tested by
#' freeing each one in the anchored model (scheme "add"); group means and variances are free throughout.
#' @export
irt_dif <- function(data, group, items = NULL, anchors = character(), itemtype = "graded", id = NULL,
                    thresholds = resolve_thresholds(), inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "irt_dif"
  method <- "mirt_multipleGroup_LR"
  warns <- character()
  .require_columns(data, group, "group column")
  items <- .as_char_vec(items)
  if (!length(items)) items <- .default_items(data, c(group, id))
  .require_columns(data, items, "item")
  data <- data[!is.na(data[[group]]), , drop = FALSE]
  prep <- .prepare_items(data, items, .th(thresholds, "irt", "min_category_n"), warns)
  warns <- prep$warnings
  resp <- prep$resp
  items <- colnames(resp)
  g <- as.character(data[[group]])
  groups <- sort(unique(g))
  if (length(groups) < 2 || length(items) < 3) {
    return(psy_unavailable(analysis, method, "needs at least two groups and three items", n = nrow(resp),
                           provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  alpha <- .th(thresholds, "dif", "fdr_alpha")
  if (!is.null(seed)) set.seed(seed)
  fit_mg <- function(inv) {
    r <- .collect_warnings(mirt::multipleGroup(resp, 1, group = g, itemtype = itemtype, invariance = inv,
                                               verbose = FALSE, technical = list(NCYCLES = 2000)))
    warns <<- c(warns, r$warnings)
    r$value
  }
  anchors <- intersect(.as_char_vec(anchors), items)
  selection <- list(method = if (length(anchors)) "user_supplied" else "rank_all_other_woods2009")
  if (!length(anchors)) {
    constrained <- fit_mg(c(items, "free_means", "free_var"))
    screen <- lapply(items, function(it) {
      d <- .quietly(mirt::DIF(constrained, which.par = .item_par_names(constrained, it), scheme = "drop",
                              items2test = it, verbose = FALSE))
      c(list(item = it), .dif_row(d))
    })
    sc <- do.call(rbind, lapply(screen, as.data.frame))
    sc$ratio <- sc$X2 / pmax(sc$df, 1)
    k <- max(.th(thresholds, "dif", "min_anchors"), ceiling(.th(thresholds, "dif", "anchor_share") * length(items)))
    k <- min(k, length(items) - 1)
    ord <- order(sc$ratio)
    anchors <- sc$item[ord][seq_len(k)]
    selection$screen <- .records(sc)
    selection$k <- k
    bad <- sc$item[sc$item %in% anchors & is.finite(sc$p) & sc$p < alpha]
    if (length(bad)) warns <- c(warns, sprintf("selected anchor(s) %s show DIF in the all-other screen; DIF-free anchors may not exist", paste(bad, collapse = ", ")))
  }
  anchored <- fit_mg(c(anchors, "free_means", "free_var"))
  to_test <- setdiff(items, anchors)
  tested <- lapply(to_test, function(it) {
    d <- .quietly(mirt::DIF(anchored, which.par = .item_par_names(anchored, it), scheme = "add",
                            items2test = it, verbose = FALSE))
    c(list(item = it), .dif_row(d))
  })
  tab <- do.call(rbind, lapply(tested, as.data.frame))
  tab$q <- .bh(tab$p)
  tab$flagged <- is.finite(tab$q) & tab$q < alpha
  flagged <- tab$item[tab$flagged]
  es <- NULL
  if (length(flagged)) {
    final <- fit_mg(c(setdiff(items, flagged), "free_means", "free_var"))
    es <- tryCatch(.quietly(suppressWarnings(mirt::empirical_ES(final, DIF = TRUE, plot = FALSE))), error = function(e) NULL)
  } else {
    final <- anchored
  }
  gp <- tryCatch({
    cf <- mirt::coef(final, simplify = TRUE)
    lapply(cf, function(x) list(mean = .safe_num(x$means[1]), var = .safe_num(x$cov[1])))
  }, error = function(e) NULL)
  details <- list(
    items = .records(tab),
    anchors = as.list(anchors),
    anchor_selection = selection,
    flagged = as.list(flagged),
    effect_sizes = if (is.null(es)) NULL else .records(cbind(item = rownames(es), as.data.frame(es))),
    group_latent = gp,
    groups = as.list(table(g)),
    reference_group = groups[1],
    itemtype = itemtype,
    fdr_alpha = alpha
  )
  share <- if (nrow(tab)) mean(tab$flagged) else 0
  psy_result(
    analysis = analysis, estimate = share, n = nrow(resp), method = method,
    assumptions = list(
      assumption("anchors_available", length(anchors) >= 1, length(anchors), "at least one anchor item"),
      assumption("anchor_count_min", length(anchors) >= min(.th(thresholds, "dif", "min_anchors"), length(items) - 1),
                 length(anchors), "Woods (2009) minimum anchor count")
    ),
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed,
                                 list(items = as.list(items), group = group, itemtype = itemtype,
                                      anchors = as.list(anchors)))
  )
}

#' lordif ordinal logistic regression DIF with IRT-purified matching (Choi, Gibbons & Crane 2011).
#' @export
ordinal_logistic_dif <- function(data, group, items = NULL, id = NULL, thresholds = resolve_thresholds(),
                                 inputs_sha256 = NA_character_, seed = NULL) {
  analysis <- "ordinal_logistic_dif"
  warns <- character()
  .require_columns(data, group, "group column")
  items <- .as_char_vec(items)
  if (!length(items)) items <- .default_items(data, c(group, id))
  .require_columns(data, items, "item")
  data <- data[!is.na(data[[group]]), , drop = FALSE]
  resp <- as.data.frame(lapply(data[, items, drop = FALSE], function(v) suppressWarnings(as.numeric(v))))
  g <- as.character(data[[group]])
  crit <- .th(thresholds, "dif", "lordif_criterion")
  method <- sprintf("lordif_%s", crit)
  if (length(unique(g)) < 2 || length(items) < 3) {
    return(psy_unavailable(analysis, method, "needs at least two groups and three items", n = nrow(resp),
                           provenance = make_provenance(analysis, inputs_sha256, seed)))
  }
  if (!is.null(seed)) set.seed(seed)
  res <- .collect_warnings(.quietly(lordif::lordif(
    resp.data = resp, group = g, criterion = crit,
    pseudo.R2 = .th(thresholds, "dif", "lordif_pseudo_r2"),
    alpha = .th(thresholds, "dif", "lordif_alpha"),
    beta.change = .th(thresholds, "dif", "lordif_beta_change"),
    R2.change = .th(thresholds, "dif", "lordif_r2_change"),
    minCell = .th(thresholds, "dif", "lordif_min_cell"),
    maxIter = .th(thresholds, "dif", "purification_max_iter")
  )))
  fit <- res$value
  warns <- c(warns, res$warnings)
  st <- as.data.frame(fit$stats)
  st$item <- items[as.integer(st$item)] %||% st$item
  st$flagged <- as.logical(fit$flag)
  flagged <- st$item[st$flagged]
  details <- list(
    items = .records(st),
    flagged = as.list(flagged),
    iterations = as.integer(fit$iteration %||% NA),
    criterion = crit,
    settings = thresholds$dif[grepl("^lordif_", names(thresholds$dif))],
    groups = as.list(table(g))
  )
  psy_result(
    analysis = analysis, estimate = mean(st$flagged), n = nrow(resp), method = method,
    warnings = warns, details = details,
    provenance = make_provenance(analysis, inputs_sha256, seed, list(items = as.list(items), group = group))
  )
}
