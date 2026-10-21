true_quantile <- function(age, p) stats::qnorm(p, 20 + 0.15 * age, 3 + 0.02 * age)

table_at <- function(r) {
  t <- do.call(rbind, lapply(r$details$norm_table, as.data.frame))
  t
}

test_that("raking matches population margins and trims weights", {
  d <- sim_norms()
  margins <- list(gender = list(f = 0.5, m = 0.5), urban = list(urban = 0.3, rural = 0.7))
  w <- rake_weights(d, margins, trim_ratio = 5)
  expect_equal(mean(w), 1, tolerance = 1e-12)
  expect_equal(sum(w[d$gender == "f"]) / sum(w), 0.5, tolerance = 1e-3)
  expect_equal(sum(w[d$urban == "urban"]) / sum(w), 0.3, tolerance = 1e-3)
  expect_lte(max(w) / stats::median(w), 5 + 1e-9)
})

test_that("GAMLSS norms recover the generating centiles without crossing", {
  d <- sim_norms()
  r <- continuous_norms(d, score = "score", age = "age", method = "GAMLSS",
                        margins = list(gender = list(f = 0.5, m = 0.5)), norm_table_version = "test-1", seed = 1)
  expect_equal(r$status, "ok")
  expect_true(r$details$publishable)
  expect_false(r$details$percentile_crossing)
  expect_equal(r$details$norm_status, "provisional")
  expect_equal(r$details$norm_table_version, "test-1")
  t <- table_at(r)
  mid <- t[abs(t$age - stats::median(unique(t$age))) < 2, ]
  for (i in seq_len(nrow(mid))) {
    expect_equal(mid$raw[i], true_quantile(mid$age[i], mid$percentile[i] / 100), tolerance = 0.06)
  }
  expect_lt(r$details$effective_n, nrow(d))
})

test_that("GAMLSS accepts education as a second continuous predictor", {
  d <- sim_norms()
  r <- continuous_norms(d, score = "score", age = "age", education = "education", method = "GAMLSS", seed = 1)
  expect_equal(r$status, "ok")
  expect_equal(unlist(r$details$fit$predictors), c("age", "education"))
  expect_true(any(grepl("not post-stratified", r$warnings)))
})

test_that("cNORM norms are monotone in percentile and close to the generating model", {
  d <- sim_norms()
  r <- continuous_norms(d, score = "score", age = "age", method = "cNORM", seed = 1)
  expect_equal(r$status, "ok")
  expect_gt(r$estimate, 0.9)
  t <- table_at(r)
  expect_false(r$details$percentile_crossing)
  med <- t[t$percentile == 50, ]
  inner <- med[med$age > 25 & med$age < 62, ]
  expect_true(all(abs(inner$raw - true_quantile(inner$age, 0.5)) < 1.0))
})

test_that("percentile crossing blocks publication", {
  tab <- data.frame(age = c(20, 20, 20, 30, 30, 30), percentile = c(10, 50, 90, 10, 50, 90),
                    raw = c(1, 2, 3, 1, 3, 2))
  expect_equal(shriiipsy:::.percentile_crossings(tab), 30)
})
