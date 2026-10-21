test_that("thresholds load from YAML and overrides merge key by key", {
  th <- default_thresholds()
  expect_equal(th$schema, "shriiipsy-thresholds")
  expect_equal(th$invariance$delta_cfi_max_drop, 0.01)
  m <- resolve_thresholds(list(invariance = list(delta_cfi_max_drop = 0.02)))
  expect_equal(m$invariance$delta_cfi_max_drop, 0.02)
  expect_equal(m$invariance$delta_rmsea_max_increase, 0.015)
})

test_that("run_request handles inline columns and returns an EvidenceResult-shaped object", {
  sf <- list(j1 = c(9, 6, 8, 7, 10, 6), j2 = c(2, 1, 4, 1, 5, 2), j3 = c(5, 3, 6, 2, 6, 4), j4 = c(8, 2, 8, 6, 9, 7))
  req <- list(schema = "shriiipsy-request/1", analysis = "reliability_cross_check", run_id = "run-1",
              data = list(columns = sf), params = list(kind = "icc_a1", columns = names(sf)), seed = 1)
  r <- run_request(req)
  expect_equal(r$status, "ok")
  expect_equal(r$run_id, "run-1")
  js <- jsonlite::fromJSON(as.character(result_to_json(r)), simplifyVector = FALSE)
  expect_setequal(
    setdiff(names(js), c("schema", "run_id")),
    c("analysis", "estimate", "ci_low", "ci_high", "ci_level", "n", "method", "status", "assumptions",
      "warnings", "details", "provenance")
  )
  expect_equal(js$schema, "shriiipsy-result/1")
  expect_setequal(names(js$provenance), c("analysis", "algorithm_version", "computed_at", "inputs_sha256", "seed",
                                          "params", "library_versions"))
  expect_equal(nchar(js$provenance$inputs_sha256), 64)
  expect_true(is.list(js$warnings))
  expect_false(is.null(js$provenance$library_versions$lavaan))
})

test_that("run_request reads CSV and Parquet files and hashes the file bytes", {
  d <- hs_data()[, c("school", paste0("x", 1:9))]
  dir <- withr::local_tempdir()
  csv <- file.path(dir, "hs.csv")
  pq <- file.path(dir, "hs.parquet")
  utils::write.csv(d, csv, row.names = FALSE)
  nanoparquet::write_parquet(d, pq)
  for (spec in list(list(path = csv), list(path = "hs.parquet", format = "parquet"))) {
    req <- list(analysis = "measurement_invariance", data = spec,
                params = list(model = hs_model, group = "school", estimator = "ML", levels = list("configural", "metric")))
    r <- run_request(req, base_dir = dir)
    expect_equal(r$status, "ok")
    expect_equal(r$details$decision, "metric")
    expect_equal(r$provenance$inputs_sha256, digest::digest(file = if (is.null(spec$format)) csv else pq, algo = "sha256"))
  }
})

test_that("malformed requests fail closed with a message", {
  r <- run_request(list(analysis = "nope", data = list(columns = list(a = 1))))
  expect_equal(r$status, "failed")
  expect_match(r$warnings, "unknown analysis")
  r2 <- run_request(list(analysis = "irt_grm", data = list(columns = list(a = 1)), params = list(bogus = 1)))
  expect_match(r2$warnings, "unknown parameter")
  r3 <- run_request(list(analysis = "irt_grm", data = list(path = "/does/not/exist.parquet")))
  expect_equal(r3$status, "failed")
  expect_match(r3$warnings, "not found")
  r4 <- run_request(list(schema = "other/9", analysis = "irt_grm"))
  expect_match(r4$warnings, "unsupported request schema")
})

test_that("cli_main reads a request file and writes the response file", {
  dir <- withr::local_tempdir()
  req <- file.path(dir, "req.json")
  resp <- file.path(dir, "resp.json")
  writeLines(jsonlite::toJSON(list(
    analysis = "reliability_cross_check", data = list(columns = list(x = c(1, 2, 3, 4, 5), y = c(2, 1, 4, 3, 5))),
    params = list(kind = "pearson", x = "x", y = "y")
  ), auto_unbox = TRUE), req)
  status <- cli_main(c("run", "--request", req, "--response", resp))
  expect_equal(status, 0L)
  out <- jsonlite::fromJSON(resp)
  expect_equal(out$estimate, 0.8, tolerance = 1e-12)
  writeLines("{not json", req)
  expect_equal(cli_main(c("run", "--request", req, "--response", resp)), 2L)
  expect_equal(jsonlite::fromJSON(resp)$status, "failed")
})

test_that("non-finite numbers serialise as null", {
  r <- psy_result("x", 1, details = list(a = NaN, b = Inf, c = c(1, NA)))
  js <- jsonlite::fromJSON(as.character(result_to_json(r)), simplifyVector = FALSE)
  expect_null(js$details$a)
  expect_null(js$details$b)
  r2 <- psy_result("x", NaN)
  expect_equal(r2$status, "failed")
})

test_that("re-running a seeded request reproduces every number (VAL-01 AC: within 1e-8)", {
  set.seed(99)
  n <- 60
  d <- data.frame(person = rep(seq_len(n), each = 40), cond = rep(rep(c("calm", "pressure"), each = 20), n))
  u <- stats::rnorm(n, 0, 0.8)
  s <- stats::rnorm(n, 0, 0.6)
  eta <- 1.5 + u[d$person] + (d$cond == "pressure") * (-0.7 + s[d$person])
  d$correct <- stats::rbinom(nrow(d), 1, stats::plogis(eta))
  req <- list(schema = "shriiipsy-request/1", analysis = "person_random_slopes", seed = 7,
              data = list(columns = as.list(d)),
              params = list(person = "person", condition = "cond", response = "correct", focal = "pressure",
                            bootstrap_n = 20))
  strip <- function(r) {
    js <- jsonlite::fromJSON(as.character(result_to_json(r)), simplifyVector = FALSE)
    js$provenance$computed_at <- NULL
    js
  }
  a <- strip(run_request(req))
  b <- strip(run_request(req))
  expect_equal(a$status, "ok")
  expect_true(is.finite(a$ci_low))
  expect_equal(a, b, tolerance = 1e-8)
})
