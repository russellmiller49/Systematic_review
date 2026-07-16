// Unit tests for the Student-t module. The qt values here (and the full pin grid in
// __fixtures__/pins-qt.json, asserted by fixtures.test.ts) were generated with
// scipy.stats.t.ppf (scipy 1.17.1) — not recalled from memory.

import { describe, expect, it } from "vitest";

import { ibeta, pt, qt, studentTwoSidedP } from "./studentt";

const close = (actual: number, expected: number, tol = 1e-10) =>
  expect(Math.abs(actual - expected), `expected ${actual} ≈ ${expected}`).toBeLessThanOrEqual(tol);

describe("qt", () => {
  it("matches scipy.stats.t.ppf spot checks (1e-8)", () => {
    // python3 -c "from scipy.stats import t; print(t.ppf(p, df))"
    close(qt(0.975, 1), 12.706204736174694, 1e-8);
    close(qt(0.975, 2), 4.302652729749462, 1e-8);
    close(qt(0.975, 3), 3.1824463052837078, 1e-8);
    close(qt(0.995, 5), 4.032142983555227, 1e-8);
    close(qt(0.9, 10), 1.372183641110336, 1e-8);
    close(qt(0.6, 30), 0.2556053649519128, 1e-8);
    close(qt(0.975, 100), 1.983971518523552, 1e-8);
    close(qt(0.995, 1), 63.656741162871526, 1e-6); // steep Cauchy tail: absolute 1e-6 ≪ 1e-8 relative
  });

  it("is antisymmetric about p = 0.5", () => {
    for (const df of [1, 4, 17]) {
      expect(qt(0.5, df)).toBe(0);
      close(qt(0.2, df), -qt(0.8, df), 1e-12);
    }
  });

  it("handles edges and invalid input", () => {
    expect(qt(0, 5)).toBe(-Infinity);
    expect(qt(1, 5)).toBe(Infinity);
    expect(qt(-0.1, 5)).toBeNaN();
    expect(qt(1.1, 5)).toBeNaN();
    expect(qt(0.9, 0)).toBeNaN();
    expect(qt(NaN, 5)).toBeNaN();
  });

  it("round-trips through pt", () => {
    for (const df of [1, 2, 7, 40]) {
      for (const p of [0.05, 0.3, 0.62, 0.975, 0.999]) {
        close(pt(qt(p, df), df), p, 1e-12);
      }
    }
  });
});

describe("pt / studentTwoSidedP", () => {
  it("matches scipy.stats.t.cdf spot checks", () => {
    // python3: t.cdf(2.0, 10) = 0.9633059826146299; t.cdf(-1.5, 3) = 0.11529193262241147
    close(pt(2.0, 10), 0.9633059826146299, 1e-12);
    close(pt(-1.5, 3), 0.11529193262241147, 1e-12);
    expect(pt(0, 8)).toBeCloseTo(0.5, 14);
  });

  it("two-sided p complements the CDF tails", () => {
    for (const df of [2, 6, 25]) {
      for (const t of [0.4, 1.7, 3.2]) {
        close(studentTwoSidedP(t, df), 2 * (1 - pt(t, df)), 1e-12);
        close(studentTwoSidedP(-t, df), studentTwoSidedP(t, df), 1e-14);
      }
    }
    expect(studentTwoSidedP(0, 4)).toBeCloseTo(1, 14);
  });
});

describe("ibeta", () => {
  it("complements: I_x(a,b) + I_{1-x}(b,a) = 1", () => {
    for (const [a, b, x] of [
      [0.5, 0.5, 0.3],
      [2.5, 0.5, 0.7],
      [5, 0.5, 0.2],
    ] as const) {
      close(ibeta(a, b, x) + ibeta(b, a, 1 - x), 1, 1e-12);
    }
  });

  it("handles boundaries", () => {
    expect(ibeta(1, 0.5, 0)).toBe(0);
    expect(ibeta(1, 0.5, 1)).toBe(1);
    expect(ibeta(-1, 0.5, 0.5)).toBeNaN();
  });
});
