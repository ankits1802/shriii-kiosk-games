test_that("GRM wrapper reproduces mirt on the Science reference data", {
  sci <- mirt::Science
  r <- irt_grm(sci, seed = 1)
  expect_equal(r$status, "ok")
  ref <- mirt::mirt(sci, 1, itemtype = "graded", verbose = FALSE)
  ref_pars <- mirt::coef(ref, IRTpars = TRUE, simplify = TRUE)$items
  got_a <- vapply(r$details$items, function(i) i$parameters$a, numeric(1))
  expect_equal(unname(got_a), unname(ref_pars[, "a"]), tolerance = 1e-3)
  expect_equal(r$estimate, as.numeric(mirt::marginal_rxx(ref)), tolerance = 1e-3)
  # Published reference (mirt / ltm GRM on Science): the Future item discriminates most (a ~ 2.3).
  expect_equal(which.max(got_a), 3L)
  expect_true(r$details$converged)
})

test_that("GRM recovers simulated discriminations and collapses rare categories", {
  set.seed(42)
  a <- matrix(c(0.8, 1.2, 1.6, 2.0, 1.0, 1.4))
  d <- cbind(rep(1, 6), rep(0, 6), rep(-1, 6))
  x <- as.data.frame(mirt::simdata(a, d, 3000, itemtype = "graded"))
  x$Item_1[1:2] <- 7 # two stray responses in an unused category
  r <- irt_grm(x, seed = 2)
  got <- vapply(r$details$items, function(i) i$parameters$a, numeric(1))
  expect_gt(stats::cor(got, a[, 1]), 0.95)
  expect_true(any(grepl("rare categories", r$warnings)))
})

test_that("GRM refuses tiny inputs", {
  r <- irt_grm(data.frame(a = 1:10, b = 1:10, c = 1:10))
  expect_equal(r$status, "insufficient")
})

test_that("IRT LR DIF with automatic anchor selection finds the planted DIF items", {
  d <- sim_grm_dif()
  r <- irt_dif(d, group = "grp", seed = 3)
  expect_equal(r$status, "ok")
  flagged <- unlist(r$details$flagged)
  expect_setequal(flagged, c("i02", "i07"))
  expect_false(any(c("i02", "i07") %in% unlist(r$details$anchors)))
  expect_equal(r$details$anchor_selection$method, "rank_all_other_woods2009")
  expect_equal(length(r$details$anchors), 4)
  expect_equal(r$estimate, 2 / 6)
})

test_that("IRT LR DIF honours user anchors and stays quiet on DIF-free data", {
  d <- sim_grm_dif(dif_items = integer(), seed = 21)
  r <- irt_dif(d, group = "grp", anchors = c("i01", "i03", "i05", "i09"), seed = 4)
  expect_equal(r$details$anchor_selection$method, "user_supplied")
  expect_lte(length(r$details$flagged), 1)
})

test_that("lordif ordinal logistic DIF flags the planted items", {
  skip_slow()
  d <- sim_grm_dif(n_per_group = 600, n_items = 8, dif_items = c(4), shift = 1.2, seed = 8)
  r <- ordinal_logistic_dif(d, group = "grp", seed = 5)
  expect_equal(r$status, "ok")
  expect_true("i04" %in% unlist(r$details$flagged))
  expect_lte(length(r$details$flagged), 2)
  expect_equal(r$method, "lordif_Chisqr")
})
