// Egger's regression test for funnel-plot asymmetry (Egger et al. 1997, classic form).
//
// OLS of the standardized effect z_i = y_i / se_i on precision_i = 1 / se_i; the test
// statistic is the INTERCEPT of that regression: t = intercept / SE(intercept) with a
// two-sided Student-t p-value at df = k − 2. Requires k >= 3 included studies (df > 0),
// otherwise null. Degenerate inputs (identical precisions, zero residual variance,
// non-finite terms) also return null — this module never returns NaN.
//
// Pinned against an independent Python reference (scipy.stats.linregress of z on
// precision) in scripts/generate-stats-fixtures.py → __fixtures__/pins-egger.json and
// inside every meta fixture's `expected.egger`.

import { studentTwoSidedP } from "./studentt";
import type { EffectEstimate, EggerResult } from "./types";

export function eggerTest(estimates: EffectEstimate[]): EggerResult | null {
  const k = estimates.length;
  if (k < 3) return null;

  // z on precision; any non-finite term (se <= 0, overflow) disqualifies the test.
  const xs: number[] = [];
  const zs: number[] = [];
  for (const { y, se } of estimates) {
    const x = 1 / se;
    const z = y / se;
    if (!Number.isFinite(x) || !Number.isFinite(z) || se <= 0) return null;
    xs.push(x);
    zs.push(z);
  }

  let xBar = 0;
  let zBar = 0;
  for (let i = 0; i < k; i++) {
    xBar += xs[i]!;
    zBar += zs[i]!;
  }
  xBar /= k;
  zBar /= k;

  let sxx = 0;
  let sxz = 0;
  for (let i = 0; i < k; i++) {
    const dx = xs[i]! - xBar;
    sxx += dx * dx;
    sxz += dx * (zs[i]! - zBar);
  }
  if (!(sxx > 0) || !Number.isFinite(sxx) || !Number.isFinite(sxz)) return null; // identical precisions: intercept is unidentifiable

  const slope = sxz / sxx;
  const intercept = zBar - slope * xBar;

  let rss = 0;
  for (let i = 0; i < k; i++) {
    const resid = zs[i]! - intercept - slope * xs[i]!;
    rss += resid * resid;
  }
  const s2 = rss / (k - 2);
  const interceptSe = Math.sqrt(s2 * (1 / k + (xBar * xBar) / sxx));
  if (!Number.isFinite(interceptSe) || interceptSe <= 0) return null; // perfect fit: t undefined

  const t = intercept / interceptSe;
  const p = studentTwoSidedP(t, k - 2);
  if (!Number.isFinite(intercept) || !Number.isFinite(t) || !Number.isFinite(p)) return null;

  return { intercept, interceptSe, t, p, k };
}
