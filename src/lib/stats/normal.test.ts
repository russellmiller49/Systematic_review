// Unit tests for qnorm/pnorm against scipy-generated reference values.
// Reference values computed with scipy.stats.norm (ppf/cdf), scipy 1.17.

import { describe, expect, it } from "vitest";

import { erfc, pnorm, qnorm } from "./normal";

const close = (actual: number, expected: number, tol: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe("qnorm (AS 241)", () => {
  it("matches scipy norm.ppf at key quantiles", () => {
    close(qnorm(0.975), 1.959963984540054, 1e-12);
    close(qnorm(0.025), -1.9599639845400545, 1e-12);
    close(qnorm(0.1), -1.2815515655446004, 1e-12);
    close(qnorm(0.99), 2.3263478740408408, 1e-12);
    close(qnorm(1e-10), -6.361340902404056, 1e-11); // middle tail branch (r <= 5)
  });

  it("matches scipy norm.ppf in the deep tail (r > 5 branch, p < e^-25)", () => {
    close(qnorm(1e-12), -7.034483825301131, 1e-9);
    close(qnorm(1e-20), -9.262340089798409, 1e-9);
    // Round-trip through the deep tail: pnorm(-9) ~= 1.13e-19 sits in the r > 5 region.
    close(qnorm(pnorm(-9)), -9, 1e-6);
  });

  it("is exact and symmetric at the median", () => {
    expect(qnorm(0.5)).toBe(0);
    close(qnorm(0.3) + qnorm(0.7), 0, 1e-14);
  });

  it("handles boundary and invalid inputs", () => {
    expect(qnorm(0)).toBe(-Infinity);
    expect(qnorm(1)).toBe(Infinity);
    expect(qnorm(-0.1)).toBeNaN();
    expect(qnorm(1.1)).toBeNaN();
    expect(qnorm(NaN)).toBeNaN();
  });
});

describe("pnorm (erfc via regularized incomplete gamma)", () => {
  it("matches scipy norm.cdf to ~1e-10 or better", () => {
    expect(pnorm(0)).toBe(0.5);
    close(pnorm(1), 0.8413447460685429, 1e-12);
    close(pnorm(-1), 0.15865525393145707, 1e-12);
    close(pnorm(1.96), 0.9750021048517795, 1e-12);
    close(pnorm(3.5), 0.9997673709209645, 1e-12);
  });

  it("is accurate in the tails (relative)", () => {
    const p5 = pnorm(-5);
    expect(Math.abs(p5 - 2.8665157187919344e-7) / 2.8665157187919344e-7).toBeLessThanOrEqual(
      1e-10,
    );
    const p8 = pnorm(-8);
    expect(Math.abs(p8 - 6.22096057427174e-16) / 6.22096057427174e-16).toBeLessThanOrEqual(
      1e-10,
    );
  });

  it("satisfies symmetry pnorm(-z) = 1 - pnorm(z)", () => {
    for (const z of [0.3, 1.2, 2.5, 4]) {
      close(pnorm(-z), 1 - pnorm(z), 1e-14);
    }
  });

  it("round-trips with qnorm", () => {
    for (const z of [-3, -1.5, -0.2, 0.7, 2.4]) {
      close(qnorm(pnorm(z)), z, 1e-9);
    }
  });

  it("erfc edge cases", () => {
    expect(erfc(0)).toBe(1);
    expect(erfc(Infinity)).toBe(0);
    expect(erfc(-Infinity)).toBe(2);
    expect(erfc(NaN)).toBeNaN();
  });

  it("saturates instead of NaN when x*x overflows (finite |x| >= ~1.34e154)", () => {
    expect(erfc(2e154)).toBe(0);
    expect(erfc(-2e154)).toBe(2);
    expect(pnorm(2e154)).toBe(1);
    expect(pnorm(-2e154)).toBe(0);
  });
});
