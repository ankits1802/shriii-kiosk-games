test_that("blavaan approximate invariance runs, converges and reports group differences", {
  skip_slow()
  r <- bayesian_approximate_invariance(hs_data(), hs_model, "school", chains = 2, burnin = 400, sample = 400, seed = 7)
  expect_equal(r$status, "ok")
  expect_true(r$estimate >= 0 && r$estimate <= 1)
  expect_lt(r$details$max_rhat, 1.1)
  params <- vapply(r$details$parameter_differences, `[[`, "", "parameter")
  expect_true(all(c("visual=~x2", "x3~1", "x7~1") %in% params))
  diffs <- stats::setNames(vapply(r$details$parameter_differences, `[[`, 0, "max_abs_difference"), params)
  # The x3 intercept differs most between schools in the ML analysis; the wiggle prior lets it move.
  expect_gt(abs(diffs[["x3~1"]]), abs(diffs[["x1~1"]]))
})
