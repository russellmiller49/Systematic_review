// Unit tests for the single-arm proportion effects (logit + Freeman–Tukey) and their
// back-transforms. Numeric agreement with the Python reference is covered by
// fixtures.test.ts; these tests pin the policy edges.

import { describe, expect, it } from "vitest";

import { ftInverse, harmonicMean, invLogit, proportionEffect } from "./proportion";

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected), `expected ${actual} ≈ ${expected}`).toBeLessThanOrEqual(tol);

function estimateOf(result: ReturnType<typeof proportionEffect>) {
  if ("excludedReason" in result) throw new Error(`unexpected exclusion: ${result.excludedReason}`);
  return result.estimate;
}

describe("proportionEffect (LOGIT)", () => {
  it("computes y = ln(e/(n-e)) and v = 1/e + 1/(n-e) without continuity mid-range", () => {
    const { y, se } = estimateOf(proportionEffect("LOGIT", { e: 12, n: 80 }));
    close(y, Math.log(12 / 68));
    close(se, Math.sqrt(1 / 12 + 1 / 68));
    // Display back-transform recovers e/n exactly.
    close(invLogit(y), 12 / 80);
  });

  it("applies the 0.5 / n+1 continuity correction only at e = 0 or e = n", () => {
    const zero = estimateOf(proportionEffect("LOGIT", { e: 0, n: 45 }));
    close(zero.y, Math.log(0.5 / 45.5));
    close(zero.se, Math.sqrt(1 / 0.5 + 1 / 45.5));
    const full = estimateOf(proportionEffect("LOGIT", { e: 25, n: 25 }));
    close(full.y, Math.log(25.5 / 0.5));
    close(full.se, Math.sqrt(1 / 25.5 + 1 / 0.5));
    // e = 1 must NOT be corrected.
    const one = estimateOf(proportionEffect("LOGIT", { e: 1, n: 30 }));
    close(one.y, Math.log(1 / 29));
  });
});

describe("proportionEffect (FREEMAN_TUKEY)", () => {
  it("computes the double-arcsine and v = 1/(4n+2)", () => {
    const { y, se } = estimateOf(proportionEffect("FREEMAN_TUKEY", { e: 12, n: 80 }));
    close(y, 0.5 * (Math.asin(Math.sqrt(12 / 81)) + Math.asin(Math.sqrt(13 / 81))));
    close(se, Math.sqrt(1 / 322));
  });

  it("needs no continuity correction at the boundaries", () => {
    const zero = estimateOf(proportionEffect("FREEMAN_TUKEY", { e: 0, n: 45 }));
    close(zero.y, 0.5 * Math.asin(Math.sqrt(1 / 46)));
    expect(Number.isFinite(zero.se)).toBe(true);
  });
});

describe("validation (both transforms)", () => {
  it("excludes non-integer, negative, and out-of-range counts", () => {
    for (const transform of ["LOGIT", "FREEMAN_TUKEY"] as const) {
      for (const counts of [
        { e: 7.5, n: 30 },
        { e: 5, n: 4 },
        { e: -1, n: 10 },
        { e: 0, n: 0 },
        { e: NaN, n: 10 },
      ]) {
        const result = proportionEffect(transform, counts);
        expect("excludedReason" in result, JSON.stringify(counts)).toBe(true);
      }
    }
  });
});

describe("ftInverse (Miller 1978)", () => {
  it("approximately inverts the forward transform at the observed proportion", () => {
    for (const [e, n] of [
      [12, 80],
      [30, 60],
      [5, 120],
      [1, 9],
    ] as const) {
      const { y } = estimateOf(proportionEffect("FREEMAN_TUKEY", { e, n }));
      // Miller's inverse recovers e/n closely (not exactly — it inverts the smoothed transform).
      close(ftInverse(y, n), e / n, 5e-3);
    }
  });

  it("clamps y to [0, π/2] and p to [0, 1]", () => {
    expect(ftInverse(-0.4, 50)).toBe(0);
    expect(ftInverse(Math.PI / 2 + 0.3, 50)).toBe(1);
    expect(ftInverse(0, 50)).toBe(0);
    expect(ftInverse(Math.PI / 2, 50)).toBe(1);
    const mid = ftInverse(0.7, 40);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("is monotone in y for a fixed n", () => {
    let prev = -1;
    for (let y = 0.05; y < Math.PI / 2; y += 0.05) {
      const p = ftInverse(y, 33);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("returns NaN for invalid n", () => {
    expect(ftInverse(0.5, 0)).toBeNaN();
    expect(ftInverse(0.5, NaN)).toBeNaN();
  });
});

describe("harmonicMean", () => {
  it("computes k / Σ(1/n)", () => {
    close(harmonicMean([80, 45, 60])!, 3 / (1 / 80 + 1 / 45 + 1 / 60));
    close(harmonicMean([50])!, 50);
  });

  it("rejects empty and non-positive inputs", () => {
    expect(harmonicMean([])).toBeNull();
    expect(harmonicMean([10, 0])).toBeNull();
    expect(harmonicMean([10, -5])).toBeNull();
  });
});
