"""Synthetic players with known latent trait parameters (QA-02).

* :func:`~shriii_simulator.session.simulate_study` - contract-valid raw event streams for every module and
  episode, with planted latents, retest occasions, gaming strategies, walkaways and timing glitches;
* :func:`~shriii_simulator.criterion.simulate_criterion` - criterion battery responses with known loadings;
* :func:`~shriii_simulator.recovery.run_recovery` - the parameter-recovery harness.

Simulator data is always marked ``context.synthetic = true`` and never enters real analyses.
"""

from shriii_simulator.population import CONSTRUCTS, Person, sample_population
from shriii_simulator.session import SimulatedSession, SimulatedStudy, simulate_session, simulate_study

__all__ = [
    "CONSTRUCTS",
    "Person",
    "SimulatedSession",
    "SimulatedStudy",
    "__version__",
    "sample_population",
    "simulate_session",
    "simulate_study",
]

__version__ = "0.1.0"
