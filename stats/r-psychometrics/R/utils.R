# Small shared helpers.

`%||%` <- function(a, b) if (is.null(a)) b else a

# Run `expr`, collecting warnings (muffled) and messages so they surface in the result instead of stderr.
.collect_warnings <- function(expr) {
  warns <- character()
  value <- withCallingHandlers(
    expr,
    warning = function(w) {
      warns <<- c(warns, conditionMessage(w))
      invokeRestart("muffleWarning")
    }
  )
  list(value = value, warnings = unique(warns))
}

# Evaluate quietly (some packages print progress to stdout, which would corrupt JSON-on-stdout).
.quietly <- function(expr) {
  out <- NULL
  utils::capture.output(out <- expr, type = "output")
  out
}

# Benjamini-Hochberg adjusted p values (NA preserved).
.bh <- function(p) {
  q <- rep(NA_real_, length(p))
  ok <- is.finite(p)
  if (any(ok)) q[ok] <- stats::p.adjust(p[ok], method = "BH")
  q
}

# A data.frame -> list of row records with NA -> NULL (for JSON).
.records <- function(df) {
  if (is.null(df) || nrow(df) == 0) return(list())
  lapply(seq_len(nrow(df)), function(i) {
    row <- as.list(df[i, , drop = FALSE])
    lapply(row, function(v) {
      if (is.factor(v)) v <- as.character(v)
      if (length(v) == 1 && is.na(v)) NULL else unname(v)
    })
  })
}

.safe_num <- function(x) {
  x <- suppressWarnings(as.numeric(x))
  ifelse(is.finite(x), x, NA_real_)
}

# Kish effective sample size of a weight vector.
kish_effective_n <- function(w) {
  w <- w[is.finite(w) & w > 0]
  if (!length(w)) return(0)
  sum(w)^2 / sum(w^2)
}

# Trim weights at ratio x median, renormalise to mean 1.
.trim_weights <- function(w, ratio) {
  med <- stats::median(w[w > 0])
  w <- pmin(w, ratio * med)
  w / mean(w)
}

.as_char_vec <- function(x) if (is.null(x)) character() else as.character(unlist(x))
