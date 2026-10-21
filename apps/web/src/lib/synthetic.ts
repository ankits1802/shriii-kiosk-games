/**
 * Deterministic synthetic data for the component gallery and tests. Never shown as study data:
 * every figure that uses it carries the "Synthetic data" badge.
 */

/** mulberry32 PRNG: small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box–Muller). */
export function normalSampler(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Pairs (x, y) with population correlation `rho`. */
export function correlatedPairs(n: number, rho: number, seed: number): { x: number; y: number }[] {
  const z = normalSampler(seededRandom(seed));
  return Array.from({ length: n }, () => {
    const a = z();
    const b = z();
    return { x: a, y: rho * a + Math.sqrt(1 - rho * rho) * b };
  });
}
