// Inverse-variance pooling: fixed effect and DerSimonian-Laird random effects.
//
// Operates on the ANALYSIS scale (per-study { y, se } from the effects modules).
// Pinned formulas (mirrored by the Python reference):
// - weights w = 1/v; pooled y = Σwy/Σw, se = sqrt(1/Σw); CI = y ± qnorm(0.975)·se;
//   z = y/se; two-sided p = 2·pnorm(-|z|).
// - Q = Σw(y_i - y_fixed)², df = k-1, C = Σw - Σw²/Σw, tau² = max(0, (Q-df)/C),
//   I² = max(0, (Q-df)/Q)·100 (0 when Q = 0), het p = upper-tail chi-square.
// - Random-effects weights w* = 1/(v + tau²).
// - k = 1: both models return the single study's y/se; heterogeneity is null.
// Summation is in input order so results are bit-comparable with the reference.

import { chiSquareUpperTail } from "./chisq";
import { pnorm, qnorm } from "./normal";
import type { EffectEstimate, Heterogeneity } from "./types";

const Z975 = qnorm(0.975);

/** Pooled estimate on the analysis scale, plus per-input percentage weights (sum ≈ 100). */
export interface PooledStats {
  y: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  z: number;
  p: number;
  weightsPct: number[]; // aligned with the input estimates
}

export interface DersimonianLairdResult {
  pooled: PooledStats;
  heterogeneity: Heterogeneity | null; // null when k < 2
}

function summarize(y: number, se: number, weights: number[], sumW: number): PooledStats {
  const z = y / se;
  return {
    y,
    se,
    ciLow: y - Z975 * se,
    ciHigh: y + Z975 * se,
    z,
    p: 2 * pnorm(-Math.abs(z)),
    weightsPct: weights.map((w) => (w / sumW) * 100),
  };
}

// Shared inverse-variance core: weights, pooled mean, and Q against the fixed mean.
function inverseVariance(estimates: EffectEstimate[], tau2: number) {
  const weights: number[] = [];
  let sumW = 0;
  for (const est of estimates) {
    const w = 1 / (est.se * est.se + tau2);
    weights.push(w);
    sumW += w;
  }
  let sumWY = 0;
  for (let i = 0; i < estimates.length; i++) {
    sumWY += weights[i]! * estimates[i]!.y;
  }
  const y = sumWY / sumW;
  return { weights, sumW, y, se: Math.sqrt(1 / sumW) };
}

/** Fixed-effect (inverse-variance) pooled estimate. Returns null when no estimates. */
export function fixedEffect(estimates: EffectEstimate[]): PooledStats | null {
  if (estimates.length === 0) return null;
  const { weights, sumW, y, se } = inverseVariance(estimates, 0);
  return summarize(y, se, weights, sumW);
}

/** DerSimonian-Laird random-effects pooled estimate with heterogeneity statistics. */
export function dersimonianLaird(estimates: EffectEstimate[]): DersimonianLairdResult | null {
  const k = estimates.length;
  if (k === 0) return null;

  const fixed = inverseVariance(estimates, 0);
  if (k === 1) {
    // Single study: no between-study variance is estimable; both models coincide.
    return {
      pooled: summarize(fixed.y, fixed.se, fixed.weights, fixed.sumW),
      heterogeneity: null,
    };
  }

  let q = 0;
  for (let i = 0; i < estimates.length; i++) {
    const dev = estimates[i]!.y - fixed.y;
    q += fixed.weights[i]! * dev * dev;
  }
  const df = k - 1;
  let sumW2 = 0;
  for (const w of fixed.weights) sumW2 += w * w;
  const c = fixed.sumW - sumW2 / fixed.sumW;
  const tau2 = Math.max(0, (q - df) / c);
  const i2 = q > 0 ? Math.max(0, (q - df) / q) * 100 : 0;
  const heterogeneity: Heterogeneity = { q, df, p: chiSquareUpperTail(q, df), i2, tau2 };

  const random = inverseVariance(estimates, tau2);
  return {
    pooled: summarize(random.y, random.se, random.weights, random.sumW),
    heterogeneity,
  };
}
