// Per-study effect estimates for single-arm proportions (measure PROPORTION), on the
// LOGIT or FREEMAN_TUKEY (PFT, double-arcsine) transformed scale, plus the display
// back-transforms.
//
// Pinned policy (mirrored by the Python reference in scripts/generate-stats-fixtures.py):
// - Counts must be integers with 0 <= e <= n and n >= 1, else the study is excluded.
// - LOGIT: continuity correction ONLY when e = 0 or e = n: e' = e + 0.5, n' = n + 1
//   (otherwise e' = e, n' = n). y = ln(e'/(n'−e')), v = 1/e' + 1/(n'−e').
//   Display back-transform: p = 1/(1 + exp(−y)).
// - FREEMAN_TUKEY (no continuity needed):
//   y = 0.5·(asin(√(e/(n+1))) + asin(√((e+1)/(n+1)))), v = 1/(4n + 2).
//   Display back-transform is Miller (1978):
//     p = 0.5·(1 − sgn(cos(2y))·√(1 − (sin(2y) + (sin(2y) − 1/sin(2y))/n)²))
//   using that study's own n per study; the POOLED estimate back-transforms with the
//   HARMONIC MEAN of the included studies' n. y outside [0, π/2] clamps to the boundary
//   first (then to the achievable range — see ftInverse); the √ argument clamps to
//   [0, 1] and p clamps to [0, 1].
// Never throws: bad data comes back as { excludedReason }.

import type { EffectEstimate, ProportionCounts, ProportionTransformId } from "../types";

export type ProportionEffectResult = { estimate: EffectEstimate } | { excludedReason: string };

function isCount(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function proportionEffect(
  transform: ProportionTransformId,
  counts: ProportionCounts,
): ProportionEffectResult {
  const { e, n } = counts;

  if (!isCount(e) || !isCount(n)) {
    return { excludedReason: "invalid counts: events and total must be integers" };
  }
  if (n < 1 || e < 0 || e > n) {
    return { excludedReason: "invalid counts: requires 0 ≤ events ≤ total and total ≥ 1" };
  }

  if (transform === "LOGIT") {
    const boundary = e === 0 || e === n;
    const eAdj = boundary ? e + 0.5 : e;
    const nAdj = boundary ? n + 1 : n;
    const y = Math.log(eAdj / (nAdj - eAdj));
    const v = 1 / eAdj + 1 / (nAdj - eAdj);
    return { estimate: { y, se: Math.sqrt(v) } };
  }

  // FREEMAN_TUKEY
  const y = 0.5 * (Math.asin(Math.sqrt(e / (n + 1))) + Math.asin(Math.sqrt((e + 1) / (n + 1))));
  const v = 1 / (4 * n + 2);
  return { estimate: { y, se: Math.sqrt(v) } };
}

/** Inverse logit: transformed value -> proportion. */
export function invLogit(y: number): number {
  return 1 / (1 + Math.exp(-y));
}

/**
 * Miller (1978) inverse of the Freeman–Tukey double-arcsine transform. `n` is the
 * study's own sample size for per-study values, or the harmonic mean of the included
 * sample sizes for pooled values.
 *
 * Boundary policy (identical in the Python reference; same conditions as metafor's
 * transf.ipft): y first clamps to [0, π/2]; values below the transform of p = 0 at
 * this n map to 0 and values above the transform of p = 1 map to 1 — Miller's
 * formula is only defined on the achievable range [pft(0, n), pft(1, n)]. Inside it,
 * the √ argument clamps to [0, 1] and p clamps to [0, 1].
 */
export function ftInverse(y: number, n: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(n) || n <= 0) return NaN;
  const yc = clamp(y, 0, Math.PI / 2);
  const lower = 0.5 * Math.asin(Math.sqrt(1 / (n + 1))); // FT transform of e = 0
  const upper = 0.5 * (Math.asin(Math.sqrt(n / (n + 1))) + Math.PI / 2); // of e = n
  if (yc < lower) return 0;
  if (yc > upper) return 1;
  const s = Math.sin(2 * yc);
  if (s === 0) return yc < Math.PI / 4 ? 0 : 1; // defensive: unreachable inside [lower, upper]
  const inner = s + (s - 1 / s) / n;
  const arg = clamp(1 - inner * inner, 0, 1);
  const p = 0.5 * (1 - Math.sign(Math.cos(2 * yc)) * Math.sqrt(arg));
  return clamp(p, 0, 1);
}

/** Harmonic mean of sample sizes (FT pooled back-transform parameter). Null when empty. */
export function harmonicMean(ns: number[]): number | null {
  if (ns.length === 0) return null;
  let sumInv = 0;
  for (const n of ns) {
    if (!Number.isFinite(n) || n <= 0) return null;
    sumInv += 1 / n;
  }
  return ns.length / sumInv;
}
