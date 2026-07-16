// Per-study effects for GENERIC_IV: a pre-computed estimate already on the pooling
// scale (users log-transform ratio measures before entry), with its standard error
// either given directly or derived from a 95% confidence interval.
//
// Pinned policy (mirrored by the Python reference in scripts/generate-stats-fixtures.py):
// - The estimate y must be finite.
// - A present se wins: it must be finite and > 0.
// - Otherwise BOTH ci bounds are required: finite, ciUp > ciLow, ciLow <= y <= ciUp;
//   then se = (ciUp − ciLow) / (2 · 1.959963984540054).
// - Pools as entered (identity/linear scale, display = analysis values, null value 0).
// Never throws: bad data comes back as { excludedReason }.

import type { EffectEstimate, GenericStats } from "../types";

export type GenericEffectResult = { estimate: EffectEstimate } | { excludedReason: string };

// qnorm(0.975) pinned to full double precision (same constant as the CI math in pool.ts).
const Z975 = 1.959963984540054;

export function genericEffect(stats: GenericStats): GenericEffectResult {
  const { y, se, ciLow, ciUp } = stats;

  if (!Number.isFinite(y)) {
    return { excludedReason: "invalid effect estimate: must be a finite number" };
  }

  if (se !== null) {
    if (!Number.isFinite(se) || se <= 0) {
      return { excludedReason: "invalid standard error: must be a finite number > 0" };
    }
    return { estimate: { y, se } };
  }

  if (ciLow === null || ciUp === null) {
    return { excludedReason: "no usable SE source: needs a standard error or both 95% CI bounds" };
  }
  if (!Number.isFinite(ciLow) || !Number.isFinite(ciUp)) {
    return { excludedReason: "invalid confidence interval: bounds must be finite numbers" };
  }
  if (!(ciUp > ciLow)) {
    return { excludedReason: "invalid confidence interval: upper bound must exceed lower bound" };
  }
  if (y < ciLow || y > ciUp) {
    return { excludedReason: "estimate lies outside its confidence interval" };
  }
  const derived = (ciUp - ciLow) / (2 * Z975);
  if (!Number.isFinite(derived) || derived <= 0) {
    return { excludedReason: "confidence interval too extreme to derive a standard error" };
  }
  return { estimate: { y, se: derived } };
}
