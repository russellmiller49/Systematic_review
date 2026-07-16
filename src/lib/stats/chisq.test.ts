// Unit tests for the chi-square upper tail and incomplete-gamma helpers
// against scipy-generated reference values (scipy.stats.chi2.sf, scipy 1.17).

import { describe, expect, it } from "vitest";

import { chiSquareUpperTail, gammp, gammq } from "./chisq";

const close = (actual: number, expected: number, tol: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe("chiSquareUpperTail", () => {
  it("matches scipy chi2.sf", () => {
    close(chiSquareUpperTail(10, 5), 0.07523524614651216, 1e-12);
    close(chiSquareUpperTail(3.841458820694124, 1), 0.04999999999999994, 1e-12);
    close(chiSquareUpperTail(0.5, 3), 0.9188914116546758, 1e-12);
    close(chiSquareUpperTail(25, 10), 0.005345505487134069, 1e-12);
    close(chiSquareUpperTail(1e-3, 2), 0.9995001249791693, 1e-12);
  });

  it("is accurate for extreme statistics (relative)", () => {
    const p = chiSquareUpperTail(200, 5);
    expect(Math.abs(p - 2.840622898641513e-41) / 2.840622898641513e-41).toBeLessThanOrEqual(
      1e-10,
    );
  });

  it("handles edges", () => {
    expect(chiSquareUpperTail(0, 4)).toBe(1);
    expect(chiSquareUpperTail(-2, 4)).toBe(1);
    expect(chiSquareUpperTail(5, 0)).toBeNaN();
    expect(chiSquareUpperTail(NaN, 3)).toBeNaN();
  });

  it("is monotonically decreasing in x", () => {
    let prev = 1;
    for (const x of [0.5, 1, 2, 5, 10, 20, 50]) {
      const p = chiSquareUpperTail(x, 4);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });
});

describe("regularized incomplete gamma", () => {
  it("gammp + gammq = 1", () => {
    for (const [a, x] of [
      [0.5, 0.3],
      [2.5, 5],
      [10, 3],
      [1, 1],
    ] as const) {
      close(gammp(a, x) + gammq(a, x), 1, 1e-12);
    }
  });

  it("handles boundaries", () => {
    expect(gammp(0.5, 0)).toBe(0);
    expect(gammq(0.5, 0)).toBe(1);
    expect(gammq(-1, 2)).toBeNaN();
    expect(gammq(0.5, -1)).toBeNaN();
  });
});
