# Reference: lavaan tutorial "Measurement invariance" (HolzingerSwineford1939, group = school, ML):
#   configural chisq 115.851 (df 48), metric 124.044 (df 54), scalar 164.103 (df 60);
#   score tests point to the x3 and x7 intercepts; partial scalar with both freed fits.

steps_by_name <- function(r) stats::setNames(r$details$steps, vapply(r$details$steps, `[[`, "", "step"))

test_that("HolzingerSwineford1939 invariance reproduces the published chi-square values", {
  th <- resolve_thresholds(list(invariance = list(max_freed_parameter_share = 0.25)))
  r <- measurement_invariance(hs_data(), hs_model, "school", estimator = "ML",
                              levels = c("configural", "metric", "scalar"), thresholds = th)
  expect_equal(r$status, "ok")
  s <- steps_by_name(r)
  expect_equal(s$configural$chisq, 115.851, tolerance = 1e-3)
  expect_equal(s$configural$df, 48)
  expect_equal(s$metric$chisq, 124.044, tolerance = 1e-3)
  expect_equal(s$metric$df, 54)
  expect_true(s$metric$passed)
  expect_equal(s$scalar$full_model$chisq, 164.103, tolerance = 1e-3)
  expect_equal(s$scalar$full_model$df, 60)
  expect_lt(s$scalar$full_model$delta_cfi, -0.01)
  expect_setequal(unlist(s$scalar$freed), c("x3~1", "x7~1"))
  expect_true(s$scalar$passed)
  expect_equal(r$details$decision, "partial_scalar")
  expect_equal(r$estimate, 3)
  expect_true(r$details$passes_required_level)
  expect_equal(r$n, 301L)
  expect_true(any(grepl("n = 145", r$warnings)))
})

test_that("the pre-registered 20% cap on freed parameters is enforced", {
  r <- measurement_invariance(hs_data(), hs_model, "school", estimator = "ML")
  s <- steps_by_name(r)
  expect_equal(s$scalar$max_freed, 1)
  expect_length(s$scalar$freed, 1)
  expect_false(s$scalar$passed)
  expect_equal(r$details$decision, "metric")
  expect_false(r$details$passes_required_level)
  expect_true(any(grepl("scalar invariance not reached", r$warnings)))
})

test_that("partial search can be disabled and user-freed parameters are honoured", {
  r <- measurement_invariance(hs_data(), hs_model, "school", estimator = "ML", partial = list(search = FALSE))
  expect_equal(r$details$decision, "metric")
  r2 <- measurement_invariance(hs_data(), hs_model, "school", estimator = "ML",
                               partial = list(search = FALSE, free = c("x3~1", "x7~1")))
  s <- steps_by_name(r2)
  expect_true(s$scalar$passed)
  expect_equal(s$scalar$df, 58)
})

test_that("MLR uses robust fit indices and strict invariance is evaluated", {
  th <- resolve_thresholds(list(invariance = list(max_freed_parameter_share = 0.25)))
  r <- measurement_invariance(hs_data(), hs_model, "school", levels = c("configural", "metric", "scalar", "strict"),
                              thresholds = th)
  expect_equal(r$details$estimator, "MLR")
  expect_equal(r$details$fit_index_type, "robust")
  s <- steps_by_name(r)
  expect_true(all(c("configural", "metric", "scalar", "strict") %in% names(s)))
  expect_true(is.finite(s$strict$lrt_p))
})

sim_ordinal_invariant <- function(n = 500, seed = 17) {
  pop <- "f =~ 0.8*y1 + 0.7*y2 + 0.75*y3 + 0.6*y4 + 0.7*y5 + 0.65*y6"
  a <- lavaan::simulateData(pop, sample.nobs = n, seed = seed, standardized = TRUE)
  b <- lavaan::simulateData(pop, sample.nobs = n, seed = seed + 1, standardized = TRUE)
  b <- b + 0.3 # latent mean difference only: thresholds and loadings invariant
  d <- rbind(a, b)
  for (v in names(d)) d[[v]] <- as.integer(cut(d[[v]], c(-Inf, -0.8, 0, 0.8, Inf)))
  d$grp <- rep(c("g1", "g2"), each = n)
  d
}

test_that("ordinal WLSMV invariance inserts the thresholds step and matches lavaan's configural fit", {
  d <- sim_ordinal_invariant()
  model <- "f =~ y1 + y2 + y3 + y4 + y5 + y6"
  r <- measurement_invariance(d, model, "grp", ordered = TRUE)
  expect_equal(r$status, "ok")
  expect_equal(r$details$estimator, "WLSMV")
  expect_equal(r$details$identification, "Wu.Estabrook.2016 + std.lv")
  s <- steps_by_name(r)
  expect_equal(names(s)[1:2], c("configural", "thresholds"))
  ref <- lavaan::cfa(model, data = d, group = "grp", ordered = paste0("y", 1:6), estimator = "WLSMV")
  expect_equal(s$configural$chisq, unname(lavaan::fitMeasures(ref, "chisq.scaled")), tolerance = 1e-4)
  expect_equal(s$configural$df, unname(lavaan::fitMeasures(ref, "df.scaled")))
  expect_equal(r$details$decision, "scalar")
  expect_true(r$details$passes_required_level)
})

test_that("an unacceptable configural model stops testing (ordinal HolzingerSwineford1939)", {
  d <- hs_data()
  for (it in paste0("x", 1:9)) d[[it]] <- as.integer(cut(d[[it]], stats::quantile(d[[it]], c(0, .25, .5, .75, 1)), include.lowest = TRUE))
  r <- measurement_invariance(d, hs_model, "school", ordered = TRUE)
  expect_equal(r$details$decision, "none")
  expect_equal(r$estimate, 0)
  expect_length(r$details$steps, 1)
  expect_true(any(grepl("configural model fit is not acceptable", r$warnings)))
})

test_that("decision rules follow the YAML thresholds", {
  prev <- list(cfi = 0.95, rmsea = 0.05, srmr = 0.04)
  th <- resolve_thresholds()
  ok <- shriiipsy:::.judge(prev, list(cfi = 0.945, rmsea = 0.055, srmr = 0.05), "metric", th)
  expect_true(ok$passed)
  bad <- shriiipsy:::.judge(prev, list(cfi = 0.935, rmsea = 0.055, srmr = 0.05), "metric", th)
  expect_false(bad$passed)
  srmr_bad <- shriiipsy:::.judge(prev, list(cfi = 0.95, rmsea = 0.05, srmr = 0.055), "scalar", th)
  expect_false(srmr_bad$passed)
  chen <- resolve_thresholds(list(invariance = list(decision_rule = "chen2007")))
  expect_true(shriiipsy:::.judge(prev, list(cfi = 0.95, rmsea = 0.05, srmr = 0.055), "scalar", chen)$passed)
})

test_that("a single group is reported as insufficient, not as evidence", {
  d <- hs_data()
  d$one <- "a"
  r <- measurement_invariance(d, hs_model, "one")
  expect_equal(r$status, "insufficient")
  expect_null(r$estimate)
})
