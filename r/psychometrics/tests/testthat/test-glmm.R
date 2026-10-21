test_that("GLMM DIF detects planted trial-level DIF while separating impact", {
  d <- sim_trials_dif()
  r <- glmm_dif(d, person = "person", item = "item", group = "group", response = "correct", seed = 1)
  expect_equal(r$status, "ok")
  expect_equal(unlist(r$details$flagged), "s03")
  items <- r$details$items
  s03 <- items[[which(vapply(items, `[[`, "", "item") == "s03")]]
  expect_gt(s03$effect, 0.6)
  expect_lt(s03$effect, 1.8)
  expect_true(s03$class %in% c("B", "C"))
  imp <- r$details$impact[[1]]
  expect_lt(imp$estimate, -0.2) # group B has the lower latent mean
  expect_true(is.finite(r$details$omnibus_random_dif$p))
  expect_equal(r$n, 300L)
})

test_that("GLMM DIF on log RT (gaussian) reports standardised effects", {
  set.seed(7)
  d <- sim_trials_dif(n_person = 200, n_items = 8, dif_items = 5, dif = 0, seed = 7)
  sp <- stats::rnorm(200, 0, 0.2)
  d$rt <- exp(6 + sp[as.integer(sub("p", "", d$person))] + 0.05 * as.integer(sub("s", "", d$item)) +
                0.3 * (d$item == "s05" & d$group == "B") + stats::rnorm(nrow(d), 0, 0.25))
  r <- glmm_dif(d, person = "person", item = "item", group = "group", response = "rt", family = "gaussian",
                transform = "log", seed = 2)
  expect_equal(unlist(r$details$flagged), "s05")
  s05 <- r$details$items[[5]]
  expect_equal(s05$effect, 0.3, tolerance = 0.1)
  expect_true(s05$std_effect > 0.5)
})

test_that("person random slopes recover ceiling-affected composure slopes and their reliability", {
  sim <- sim_slopes()
  r <- person_random_slopes(sim$data, person = "person", condition = "condition", response = "correct",
                            focal = "pressure", bootstrap_n = 20, seed = 4)
  expect_equal(r$status, "ok")
  fx <- r$details$fixed_slope
  expect_equal(fx$estimate, -0.8, tolerance = 0.2)
  expect_equal(r$details$random_effects$sd_slope, 0.7, tolerance = 0.25)
  slopes <- r$details$person_slopes
  est <- vapply(slopes, `[[`, 0, "slope")
  names(est) <- vapply(slopes, `[[`, "", "person")
  truth <- sim$true_slopes[names(est)]
  emp_rel <- stats::cor(est, truth)^2
  # Empirical-Bayes reliability approximates the squared correlation between estimated and true slopes.
  expect_equal(r$estimate, emp_rel, tolerance = 0.12)
  expect_true(is.finite(r$ci_low) && is.finite(r$ci_high))
  expect_lte(r$ci_low, r$estimate + 0.05)
  expect_true(r$details$ceiling$share_at_ceiling[["0"]] > 0.15)
  expect_true(any(grepl("ceiling", r$warnings)))
})

test_that("slopes without person variance are flagged singular with zero reliability", {
  set.seed(12)
  n <- 150
  rows <- expand.grid(trial = 1:40, person = seq_len(n))
  cond <- as.integer(rows$trial > 20)
  d <- data.frame(person = rows$person, condition = cond,
                  correct = stats::rbinom(nrow(rows), 1, stats::plogis(1 - 0.5 * cond)))
  r <- person_random_slopes(d, person = "person", condition = "condition", response = "correct", bootstrap_n = 0)
  expect_lt(r$estimate, 0.2)
  expect_true(any(grepl("bootstrap_n = 0", r$warnings)))
})
