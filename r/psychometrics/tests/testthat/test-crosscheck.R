# Shrout & Fleiss (1979), Table 2: 6 targets x 4 judges. Published ICC(2,1) = .29, ICC(3,1) = .71.
sf <- data.frame(
  j1 = c(9, 6, 8, 7, 10, 6), j2 = c(2, 1, 4, 1, 5, 2), j3 = c(5, 3, 6, 2, 6, 4), j4 = c(8, 2, 8, 6, 9, 7)
)

test_that("ICC(A,1) and ICC(C,1) reproduce Shrout & Fleiss (1979)", {
  a1 <- reliability_cross_check(sf, "icc_a1", columns = names(sf))
  c1 <- reliability_cross_check(sf, "icc_c1", columns = names(sf))
  expect_equal(round(a1$estimate, 2), 0.29)
  expect_equal(round(c1$estimate, 2), 0.71)
  expect_equal(a1$analysis, "ICC_A1")
  expect_lt(a1$ci_low, a1$estimate)
  expect_gt(a1$ci_high, a1$estimate)
  # Exact McGraw & Wong ICC(A,1) from the two-way ANOVA mean squares.
  m <- as.matrix(sf)
  n <- nrow(m); k <- ncol(m); gm <- mean(m)
  msr <- k * sum((rowMeans(m) - gm)^2) / (n - 1)
  msc <- n * sum((colMeans(m) - gm)^2) / (k - 1)
  sse <- sum((m - outer(rowMeans(m), rep(1, k)) - outer(rep(1, n), colMeans(m)) + gm)^2)
  mse <- sse / ((n - 1) * (k - 1))
  expect_equal(a1$estimate, (msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n), tolerance = 1e-12)
})

test_that("alpha (Feldt CI) and Pearson r cross-checks", {
  set.seed(1)
  f <- stats::rnorm(200)
  x <- sapply(1:5, function(i) f + stats::rnorm(200))
  df <- as.data.frame(x)
  r <- reliability_cross_check(df, "alpha", columns = names(df))
  k <- 5
  manual <- k / (k - 1) * (1 - sum(apply(x, 2, stats::var)) / stats::var(rowSums(x)))
  expect_equal(r$estimate, manual, tolerance = 1e-12)
  expect_lt(r$ci_low, r$estimate)
  p <- reliability_cross_check(df, "pearson", x = "V1", y = "V2")
  expect_equal(p$estimate, stats::cor(x[, 1], x[, 2]), tolerance = 1e-12)
  expect_equal(p$analysis, "pearson_r")
})
