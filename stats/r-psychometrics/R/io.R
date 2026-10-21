# Input handling: Parquet / CSV files or inline column-oriented JSON.

#' Read a data specification into a data.frame and return it with the SHA-256 of its content.
#'
#' `spec` is one of
#'   list(path = "x.parquet", format = "parquet")      (format inferred from the extension when absent)
#'   list(path = "x.csv", format = "csv")
#'   list(columns = list(a = c(...), b = c(...)))       (inline, column oriented)
#' @export
read_input <- function(spec, base_dir = NULL) {
  if (is.null(spec)) stop("request has no `data`")
  if (!is.null(spec$columns)) {
    cols <- lapply(spec$columns, function(col) {
      if (is.list(col)) col <- unlist(lapply(col, function(v) if (is.null(v)) NA else v))
      col
    })
    lens <- vapply(cols, length, integer(1))
    if (length(unique(lens)) > 1) stop("inline columns have different lengths")
    df <- as.data.frame(cols, stringsAsFactors = FALSE, check.names = FALSE)
    sha <- digest::digest(jsonlite::toJSON(cols, digits = NA, na = "null"), algo = "sha256", serialize = FALSE)
    return(list(data = df, sha256 = sha))
  }
  path <- spec$path
  if (is.null(path)) stop("data spec needs `path` or `columns`")
  if (!file.exists(path) && !is.null(base_dir)) path <- file.path(base_dir, path)
  if (!file.exists(path)) stop(sprintf("data file not found: %s", spec$path))
  fmt <- tolower(if (!is.null(spec$format)) spec$format else tools::file_ext(path))
  df <- switch(fmt,
    parquet = as.data.frame(nanoparquet::read_parquet(path), stringsAsFactors = FALSE),
    csv = utils::read.csv(path, stringsAsFactors = FALSE, check.names = FALSE, na.strings = c("", "NA")),
    stop(sprintf("unsupported data format: %s", fmt))
  )
  sha <- digest::digest(file = path, algo = "sha256")
  list(data = df, sha256 = sha)
}

# Columns that must exist in `df`.
.require_columns <- function(df, cols, what = "column") {
  cols <- unique(unlist(cols))
  miss <- setdiff(cols, names(df))
  if (length(miss)) stop(sprintf("missing %s(s): %s", what, paste(miss, collapse = ", ")))
  invisible(TRUE)
}
