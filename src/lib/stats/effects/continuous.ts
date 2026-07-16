// Per-study effect estimates for continuous outcomes: MD and SMD (Hedges g).
//
// Pinned policy (mirrored by the Python reference in scripts/generate-stats-fixtures.py):
// - All six summary statistics must be finite; group sizes must be integers >= 2
//   (SMD needs df > 0; we require >= 2 for both measures); SDs must be >= 0.
// - MD with zero SE (both SDs zero) is excluded ("zero variance").
// - SMD uses the pooled SD; a zero pooled SD is excluded. Hedges' small-sample
//   correction J = 1 - 3 / (4(n1+n2-2) - 1) is always applied.
// Never throws: bad data comes back as { excludedReason }.

import type { ContinuousStats, EffectEstimate } from "../types";

export type ContinuousEffectResult = { estimate: EffectEstimate } | { excludedReason: string };

export function continuousEffect(
  measure: "MD" | "SMD",
  stats: ContinuousStats,
): ContinuousEffectResult {
  const { m1, sd1, n1, m2, sd2, n2 } = stats;

  if (
    !Number.isFinite(m1) ||
    !Number.isFinite(sd1) ||
    !Number.isFinite(n1) ||
    !Number.isFinite(m2) ||
    !Number.isFinite(sd2) ||
    !Number.isFinite(n2)
  ) {
    return { excludedReason: "invalid summary statistics: all values must be finite numbers" };
  }
  if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 2 || n2 < 2) {
    return {
      excludedReason: "invalid summary statistics: group sizes must be integers ≥ 2",
    };
  }
  if (sd1 < 0 || sd2 < 0) {
    return { excludedReason: "invalid summary statistics: standard deviations must be ≥ 0" };
  }

  if (measure === "MD") {
    const se = Math.sqrt((sd1 * sd1) / n1 + (sd2 * sd2) / n2);
    if (se === 0) {
      return { excludedReason: "zero variance (both SDs are 0) — cannot estimate MD SE" };
    }
    return { estimate: { y: m1 - m2, se } };
  }

  // SMD — Hedges g with small-sample correction J.
  const sp = Math.sqrt(((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / (n1 + n2 - 2));
  if (sp === 0) {
    return { excludedReason: "zero pooled standard deviation — cannot compute SMD" };
  }
  const d = (m1 - m2) / sp;
  const j = 1 - 3 / (4 * (n1 + n2 - 2) - 1);
  const g = j * d;
  const v = 1 / n1 + 1 / n2 + (g * g) / (2 * (n1 + n2));
  return { estimate: { y: g, se: Math.sqrt(v) } };
}
