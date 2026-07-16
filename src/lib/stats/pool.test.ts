// Unit tests for inverse-variance pooling (fixed effect + DerSimonian-Laird).
// The 3-study reference values were computed independently with Python/scipy.

import { describe, expect, it } from "vitest";

import { dersimonianLaird, fixedEffect } from "./pool";
import type { EffectEstimate } from "./types";

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

// ys = [0.2, -0.1, 0.4], ses = [0.1, 0.2, 0.15] — scipy-verified expectations below.
const THREE: EffectEstimate[] = [
  { y: 0.2, se: 0.1 },
  { y: -0.1, se: 0.2 },
  { y: 0.4, se: 0.15 },
];

describe("fixedEffect", () => {
  it("matches the Python reference on a 3-study set", () => {
    const fixed = fixedEffect(THREE)!;
    close(fixed.y, 0.20819672131147543);
    close(fixed.se, 0.07682212795973759);
    close(fixed.z, 2.710113958579632);
    close(fixed.p, 0.006726009445976185, 1e-10);
    close(fixed.ciLow, fixed.y - 1.959963984540054 * fixed.se);
    close(fixed.ciHigh, fixed.y + 1.959963984540054 * fixed.se);
  });

  it("returns null for an empty set", () => {
    expect(fixedEffect([])).toBeNull();
    expect(dersimonianLaird([])).toBeNull();
  });

  it("weights sum to 100", () => {
    const fixed = fixedEffect(THREE)!;
    close(
      fixed.weightsPct.reduce((a, b) => a + b, 0),
      100,
      1e-6,
    );
  });
});

describe("dersimonianLaird", () => {
  it("matches the Python reference on a 3-study set", () => {
    const dl = dersimonianLaird(THREE)!;
    const het = dl.heterogeneity!;
    close(het.q, 4.0163934426229515);
    expect(het.df).toBe(2);
    close(het.tau2, 0.021206896551724145);
    close(het.i2, 50.20408163265307, 1e-10);
    close(het.p, 0.13423051157447385, 1e-10);
    close(dl.pooled.y, 0.19543274155428197);
    close(dl.pooled.se, 0.11845987398192259);
    close(
      dl.pooled.weightsPct.reduce((a, b) => a + b, 0),
      100,
      1e-6,
    );
  });

  it("homogeneous data floors tau2 at 0 and random equals fixed", () => {
    const homog: EffectEstimate[] = [
      { y: 0.3, se: 0.1 },
      { y: 0.31, se: 0.12 },
      { y: 0.295, se: 0.11 },
    ];
    const dl = dersimonianLaird(homog)!;
    const fixed = fixedEffect(homog)!;
    expect(dl.heterogeneity!.tau2).toBe(0);
    expect(dl.heterogeneity!.i2).toBe(0);
    expect(dl.heterogeneity!.q).toBeLessThan(dl.heterogeneity!.df);
    close(dl.pooled.y, fixed.y, 1e-14);
    close(dl.pooled.se, fixed.se, 1e-14);
  });

  it("k = 1 returns the single study's y/se with null heterogeneity", () => {
    const single: EffectEstimate[] = [{ y: 0.5, se: 0.2 }];
    const fixed = fixedEffect(single)!;
    const dl = dersimonianLaird(single)!;
    expect(fixed.y).toBe(0.5);
    expect(fixed.se).toBe(0.2);
    expect(dl.pooled.y).toBe(0.5);
    expect(dl.pooled.se).toBe(0.2);
    expect(dl.heterogeneity).toBeNull();
    close(fixed.weightsPct[0]!, 100, 1e-12);
    close(dl.pooled.weightsPct[0]!, 100, 1e-12);
  });

  it("random-effects weights are more even than fixed weights under heterogeneity", () => {
    const dl = dersimonianLaird(THREE)!;
    const fixed = fixedEffect(THREE)!;
    const spread = (ws: number[]) => Math.max(...ws) - Math.min(...ws);
    expect(spread(dl.pooled.weightsPct)).toBeLessThan(spread(fixed.weightsPct));
  });
});

describe("prediction interval (Higgins/Thompson/Spiegelhalter)", () => {
  it("is null below k = 3", () => {
    expect(dersimonianLaird([{ y: 0.5, se: 0.2 }])!.predictionInterval).toBeNull();
    expect(
      dersimonianLaird([
        { y: 0.5, se: 0.2 },
        { y: 0.3, se: 0.25 },
      ])!.predictionInterval,
    ).toBeNull();
  });

  it("equals ŷ_RE ± t(0.975, k−2)·√(τ² + SE²) at k = 3 (qt(0.975, 1) = 12.7062...)", () => {
    const dl = dersimonianLaird(THREE)!;
    const pi = dl.predictionInterval!;
    expect(pi).not.toBeNull();
    // scipy: t.ppf(0.975, 1) = 12.706204736174694
    const half = 12.706204736174694 * Math.sqrt(dl.heterogeneity!.tau2 + dl.pooled.se ** 2);
    close(pi.low, dl.pooled.y - half, 1e-8);
    close(pi.high, dl.pooled.y + half, 1e-8);
    // Always wider than the pooled CI.
    expect(pi.low).toBeLessThan(dl.pooled.ciLow);
    expect(pi.high).toBeGreaterThan(dl.pooled.ciHigh);
  });

  it("stays estimable when τ² floors at 0", () => {
    const homog: EffectEstimate[] = [
      { y: 0.3, se: 0.1 },
      { y: 0.31, se: 0.12 },
      { y: 0.295, se: 0.11 },
    ];
    const dl = dersimonianLaird(homog)!;
    expect(dl.heterogeneity!.tau2).toBe(0);
    const pi = dl.predictionInterval!;
    expect(pi).not.toBeNull();
    close(pi.high - pi.low, 2 * 12.706204736174694 * dl.pooled.se, 1e-10);
  });
});
