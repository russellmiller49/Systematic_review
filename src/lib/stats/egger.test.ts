// Unit tests for Egger's regression test. The asymmetric-set reference values were
// computed independently with scipy.stats.linregress (z on precision) + t.sf; the
// same pins are asserted from __fixtures__/pins-egger.json by fixtures.test.ts.

import { describe, expect, it } from "vitest";

import { eggerTest } from "./egger";
import type { EffectEstimate } from "./types";

const close = (actual: number, expected: number, tol = 1e-10) =>
  expect(Math.abs(actual - expected), `expected ${actual} ≈ ${expected}`).toBeLessThanOrEqual(tol);

// Classic small-study asymmetry: bigger effects go with bigger standard errors.
const ASYMMETRIC: EffectEstimate[] = [
  { y: 0.1, se: 0.08 },
  { y: 0.15, se: 0.1 },
  { y: 0.22, se: 0.14 },
  { y: 0.35, se: 0.2 },
  { y: 0.48, se: 0.28 },
  { y: 0.6, se: 0.35 },
  { y: 0.55, se: 0.4 },
  { y: 0.75, se: 0.45 },
];

describe("eggerTest", () => {
  it("matches the scipy reference on the asymmetric set", () => {
    const result = eggerTest(ASYMMETRIC)!;
    expect(result).not.toBeNull();
    expect(result.k).toBe(8);
    close(result.intercept, 1.7373431403071242, 1e-8);
    close(result.interceptSe, 0.1015416738096286, 1e-8);
    close(result.t, 17.109656312779652, 1e-6);
    close(result.p, 2.551059128144487e-6, 1e-10);
  });

  it("returns null for k < 3", () => {
    expect(eggerTest([])).toBeNull();
    expect(eggerTest(ASYMMETRIC.slice(0, 2))).toBeNull();
    expect(eggerTest(ASYMMETRIC.slice(0, 3))).not.toBeNull();
  });

  it("returns null when all precisions are identical (intercept unidentifiable)", () => {
    expect(
      eggerTest([
        { y: 0.1, se: 0.2 },
        { y: 0.3, se: 0.2 },
        { y: -0.2, se: 0.2 },
      ]),
    ).toBeNull();
  });

  it("returns null instead of NaN/Infinity on degenerate input", () => {
    // Perfect fit: z = y/se = 3 + 2·precision exactly -> zero residual variance.
    const perfect: EffectEstimate[] = [1, 2, 4].map((x) => ({ y: (3 + 2 * x) / x, se: 1 / x }));
    expect(eggerTest(perfect)).toBeNull();
    // Non-positive se.
    expect(
      eggerTest([
        { y: 0.1, se: 0 },
        { y: 0.2, se: 0.1 },
        { y: 0.3, se: 0.2 },
      ]),
    ).toBeNull();
  });

  it("a symmetric funnel keeps the intercept near zero with a large p", () => {
    const symmetric: EffectEstimate[] = [
      { y: 0.21, se: 0.08 },
      { y: 0.18, se: 0.12 },
      { y: 0.24, se: 0.18 },
      { y: 0.15, se: 0.25 },
      { y: 0.26, se: 0.33 },
    ];
    const result = eggerTest(symmetric)!;
    expect(Math.abs(result.intercept)).toBeLessThan(0.6);
    expect(result.p).toBeGreaterThan(0.2);
  });
});
