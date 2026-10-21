# Shared reference and simulated datasets for the shriiipsy tests.

hs_data <- function() lavaan::HolzingerSwineford1939
hs_model <- "visual =~ x1 + x2 + x3\ntextual =~ x4 + x5 + x6\nspeed =~ x7 + x8 + x9"

skip_slow <- function() {
  if (identical(Sys.getenv("SHRIIIPSY_SKIP_SLOW"), "1")) testthat::skip("slow test skipped (SHRIIIPSY_SKIP_SLOW=1)")
}

# Two-group graded-response data with planted DIF in `dif_items` (intercept shift for the focal group)
# and impact (focal latent mean -0.5).
sim_grm_dif <- function(n_per_group = 800, n_items = 10, dif_items = c(2, 7), shift = 1.0, seed = 11) {
  set.seed(seed)
  a <- matrix(stats::runif(n_items, 1.0, 2.0))
  d1 <- stats::rnorm(n_items, 1.2, 0.3)
  d2 <- d1 - stats::runif(n_items, 1.2, 1.8)
  d3 <- d2 - stats::runif(n_items, 1.2, 1.8)
  d <- cbind(d1, d2, d3)
  d_focal <- d
  d_focal[dif_items, ] <- d_focal[dif_items, ] - shift
  ref <- mirt::simdata(a, d, n_per_group, itemtype = "graded", Theta = matrix(stats::rnorm(n_per_group)))
  foc <- mirt::simdata(a, d_focal, n_per_group, itemtype = "graded", Theta = matrix(stats::rnorm(n_per_group, -0.5)))
  df <- as.data.frame(rbind(ref, foc))
  names(df) <- sprintf("i%02d", seq_len(n_items))
  df$grp <- rep(c("ref", "focal"), each = n_per_group)
  df
}

# Trial-level binary data: persons x items, 2 groups with impact and planted DIF on `dif_items`.
sim_trials_dif <- function(n_person = 300, n_items = 12, dif_items = c(3), dif = 1.2, impact = 0.5, seed = 5) {
  set.seed(seed)
  b <- seq(-1.5, 1.5, length.out = n_items)
  grp <- rep(c("A", "B"), length.out = n_person)
  theta <- stats::rnorm(n_person) - impact * (grp == "B")
  rows <- expand.grid(person = seq_len(n_person), item = seq_len(n_items))
  eta <- theta[rows$person] - b[rows$item] + dif * (rows$item %in% dif_items & grp[rows$person] == "B")
  data.frame(person = sprintf("p%03d", rows$person), item = sprintf("s%02d", rows$item), group = grp[rows$person],
             correct = stats::rbinom(nrow(rows), 1, stats::plogis(eta)), stringsAsFactors = FALSE)
}

# Composure-style data: high baseline accuracy (ceiling) and person-specific pressure slopes.
sim_slopes <- function(n_person = 200, n_trials = 60, mu0 = 2.6, slope = -0.8, sd0 = 0.6, sd1 = 0.7, seed = 3) {
  set.seed(seed)
  b0 <- stats::rnorm(n_person, mu0, sd0)
  b1 <- stats::rnorm(n_person, slope, sd1)
  rows <- expand.grid(trial = seq_len(n_trials), person = seq_len(n_person))
  pressure <- as.integer(rows$trial > n_trials / 2)
  eta <- b0[rows$person] + b1[rows$person] * pressure
  list(
    data = data.frame(person = sprintf("p%03d", rows$person), condition = ifelse(pressure == 1, "pressure", "calm"),
                      correct = stats::rbinom(nrow(rows), 1, stats::plogis(eta)), stringsAsFactors = FALSE),
    true_slopes = stats::setNames(b1, sprintf("p%03d", seq_len(n_person)))
  )
}

sim_norms <- function(n = 1200, seed = 9) {
  set.seed(seed)
  age <- stats::runif(n, 18, 70)
  edu <- pmin(pmax(round(stats::rnorm(n, 10, 4)), 0), 20)
  mu <- 20 + 0.15 * age
  sd <- 3 + 0.02 * age
  data.frame(score = stats::rnorm(n, mu, sd), age = age, education = edu,
             gender = sample(c("f", "m"), n, TRUE, prob = c(0.35, 0.65)),
             urban = sample(c("urban", "rural"), n, TRUE, prob = c(0.6, 0.4)))
}
