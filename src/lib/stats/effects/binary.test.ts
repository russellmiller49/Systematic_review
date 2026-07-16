// Unit tests for binaryEffect: policy (validation, exclusions, continuity
// correction) and formula spot-checks.

import { describe, expect, it } from "vitest";

import type { BinaryCounts } from "../types";
import { binaryEffect } from "./binary";

function estimateOf(result: ReturnType<typeof binaryEffect>) {
  if ("excludedReason" in result) throw new Error(`unexpected exclusion: ${result.excludedReason}`);
  return result.estimate;
}

function reasonOf(result: ReturnType<typeof binaryEffect>) {
  if (!("excludedReason" in result)) throw new Error("expected exclusion");
  return result.excludedReason;
}

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

describe("validation", () => {
  const bad: BinaryCounts[] = [
    { e1: 5.5, n1: 50, e2: 3, n2: 48 }, // non-integer events
    { e1: 5, n1: 50.2, e2: 3, n2: 48 }, // non-integer total
    { e1: -1, n1: 50, e2: 3, n2: 48 }, // negative events
    { e1: 51, n1: 50, e2: 3, n2: 48 }, // events > total
    { e1: 0, n1: 0, e2: 3, n2: 48 }, // total < 1
    { e1: NaN, n1: 50, e2: 3, n2: 48 },
    { e1: Infinity, n1: 50, e2: 3, n2: 48 },
  ];
  it("excludes invalid counts for every measure", () => {
    for (const counts of bad) {
      for (const measure of ["RR", "OR", "RD"] as const) {
        expect(reasonOf(binaryEffect(measure, counts))).toMatch(/invalid counts/);
      }
    }
  });
});

describe("double-zero / double-full policy", () => {
  const doubleZero: BinaryCounts = { e1: 0, n1: 25, e2: 0, n2: 27 };
  const doubleFull: BinaryCounts = { e1: 25, n1: 25, e2: 27, n2: 27 };

  it("excludes double-zero and double-full for RR/OR", () => {
    for (const measure of ["RR", "OR"] as const) {
      expect(reasonOf(binaryEffect(measure, doubleZero))).toMatch(/double-zero/);
      expect(reasonOf(binaryEffect(measure, doubleFull))).toMatch(/double-full/);
    }
  });

  it("RD still computes for double-zero (with correction applied)", () => {
    const est = estimateOf(binaryEffect("RD", doubleZero));
    // corrected: p1 = 0.5/26, p2 = 0.5/28 — a small nonzero difference
    close(est.y, 0.5 / 26 - 0.5 / 28);
    expect(est.se).toBeGreaterThan(0);
  });

  it("RD still computes for double-full", () => {
    const est = estimateOf(binaryEffect("RD", doubleFull));
    close(est.y, 25.5 / 26 - 27.5 / 28);
    expect(est.se).toBeGreaterThan(0);
  });
});

describe("continuity correction (any zero cell -> +0.5 to all four cells)", () => {
  it("applies to RR when e1 = 0", () => {
    // e1=0,n1=40,e2=6,n2=42 -> corrected a=0.5,t1=41,c=6.5,t2=43
    const est = estimateOf(binaryEffect("RR", { e1: 0, n1: 40, e2: 6, n2: 42 }));
    close(est.y, Math.log(0.5 / 41 / (6.5 / 43)));
    close(est.se, Math.sqrt(1 / 0.5 - 1 / 41 + 1 / 6.5 - 1 / 43));
  });

  it("applies when a NON-event cell is zero (e1 = n1)", () => {
    // e1=10,n1=10 -> b = 0 triggers correction for all four cells
    const est = estimateOf(binaryEffect("OR", { e1: 10, n1: 10, e2: 5, n2: 12 }));
    close(est.y, Math.log((10.5 * 7.5) / (5.5 * 0.5)));
    close(est.se, Math.sqrt(1 / 10.5 + 1 / 0.5 + 1 / 5.5 + 1 / 7.5));
  });

  it("applies to RD (SE would otherwise be degenerate)", () => {
    const est = estimateOf(binaryEffect("RD", { e1: 0, n1: 40, e2: 6, n2: 42 }));
    const p1 = 0.5 / 41;
    const p2 = 6.5 / 43;
    close(est.y, p1 - p2);
    close(est.se, Math.sqrt((p1 * (1 - p1)) / 41 + (p2 * (1 - p2)) / 43));
  });

  it("does not apply when all four cells are positive", () => {
    const est = estimateOf(binaryEffect("RR", { e1: 12, n1: 100, e2: 24, n2: 98 }));
    close(est.y, Math.log(12 / 100 / (24 / 98)));
    close(est.se, Math.sqrt(1 / 12 - 1 / 100 + 1 / 24 - 1 / 98));
  });
});

describe("formula properties", () => {
  const identical: BinaryCounts = { e1: 20, n1: 80, e2: 20, n2: 80 };

  it("identical groups give RR = OR = 1 (y = 0) and RD = 0", () => {
    expect(estimateOf(binaryEffect("RR", identical)).y).toBe(0);
    expect(estimateOf(binaryEffect("OR", identical)).y).toBe(0);
    expect(estimateOf(binaryEffect("RD", identical)).y).toBe(0);
  });

  it("OR is symmetric under group swap (y negates, se unchanged)", () => {
    const a = estimateOf(binaryEffect("OR", { e1: 12, n1: 100, e2: 24, n2: 98 }));
    const b = estimateOf(binaryEffect("OR", { e1: 24, n1: 98, e2: 12, n2: 100 }));
    close(a.y, -b.y, 1e-14);
    close(a.se, b.se, 1e-14);
  });

  it("RD negates under group swap", () => {
    const a = estimateOf(binaryEffect("RD", { e1: 12, n1: 100, e2: 24, n2: 98 }));
    const b = estimateOf(binaryEffect("RD", { e1: 24, n1: 98, e2: 12, n2: 100 }));
    close(a.y, -b.y, 1e-14);
  });

  it("RR spot value", () => {
    const est = estimateOf(binaryEffect("RR", { e1: 5, n1: 60, e2: 10, n2: 62 }));
    close(est.y, Math.log(5 / 60 / (10 / 62)));
    close(est.se, Math.sqrt(1 / 5 - 1 / 60 + 1 / 10 - 1 / 62));
  });

  it("never throws on arbitrary junk", () => {
    const junk = [
      { e1: -5, n1: -5, e2: NaN, n2: 0 },
      { e1: 1e308, n1: 1e308, e2: 1, n2: 2 },
      { e1: 0.1, n1: 0.2, e2: 0.3, n2: 0.4 },
    ];
    for (const counts of junk) {
      for (const measure of ["RR", "OR", "RD"] as const) {
        expect(() => binaryEffect(measure, counts)).not.toThrow();
      }
    }
  });
});
