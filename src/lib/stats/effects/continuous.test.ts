// Unit tests for continuousEffect: validation policy and MD/SMD (Hedges g)
// formula spot-checks (SMD reference value scipy/hand-verified).

import { describe, expect, it } from "vitest";

import type { ContinuousStats } from "../types";
import { continuousEffect } from "./continuous";

function estimateOf(result: ReturnType<typeof continuousEffect>) {
  if ("excludedReason" in result) throw new Error(`unexpected exclusion: ${result.excludedReason}`);
  return result.estimate;
}

function reasonOf(result: ReturnType<typeof continuousEffect>) {
  if (!("excludedReason" in result)) throw new Error("expected exclusion");
  return result.excludedReason;
}

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

const base: ContinuousStats = { m1: 10.2, sd1: 3.1, n1: 40, m2: 12.5, sd2: 3.4, n2: 42 };

describe("validation", () => {
  it("excludes non-finite values", () => {
    for (const key of ["m1", "sd1", "n1", "m2", "sd2", "n2"] as const) {
      for (const v of [NaN, Infinity, -Infinity]) {
        const stats = { ...base, [key]: v };
        expect(reasonOf(continuousEffect("MD", stats))).toMatch(/finite/);
        expect(reasonOf(continuousEffect("SMD", stats))).toMatch(/finite/);
      }
    }
  });

  it("excludes group sizes < 2 or non-integer", () => {
    for (const stats of [
      { ...base, n1: 1 },
      { ...base, n2: 0 },
      { ...base, n1: 12.5 },
    ]) {
      expect(reasonOf(continuousEffect("MD", stats))).toMatch(/group sizes/);
      expect(reasonOf(continuousEffect("SMD", stats))).toMatch(/group sizes/);
    }
  });

  it("excludes negative SDs", () => {
    expect(reasonOf(continuousEffect("MD", { ...base, sd1: -0.1 }))).toMatch(/standard deviations/);
    expect(reasonOf(continuousEffect("SMD", { ...base, sd2: -1 }))).toMatch(/standard deviations/);
  });

  it("excludes zero-variance MD and zero pooled SD SMD", () => {
    const flat = { ...base, sd1: 0, sd2: 0 };
    expect(reasonOf(continuousEffect("MD", flat))).toMatch(/zero variance/);
    expect(reasonOf(continuousEffect("SMD", flat))).toMatch(/zero pooled standard deviation/);
  });

  it("never throws on junk", () => {
    const junk = { m1: NaN, sd1: -1, n1: 0.5, m2: Infinity, sd2: NaN, n2: -3 };
    expect(() => continuousEffect("MD", junk)).not.toThrow();
    expect(() => continuousEffect("SMD", junk)).not.toThrow();
  });
});

describe("MD", () => {
  it("computes the difference in means with the exact SE formula", () => {
    const est = estimateOf(continuousEffect("MD", base));
    close(est.y, 10.2 - 12.5);
    close(est.se, Math.sqrt((3.1 * 3.1) / 40 + (3.4 * 3.4) / 42));
  });

  it("identical groups give MD = 0", () => {
    const est = estimateOf(
      continuousEffect("MD", { m1: 5, sd1: 2, n1: 30, m2: 5, sd2: 2, n2: 30 }),
    );
    expect(est.y).toBe(0);
    expect(est.se).toBeGreaterThan(0);
  });
});

describe("SMD (Hedges g)", () => {
  it("matches the scipy/hand-computed reference for a small sample (J matters)", () => {
    // m1=50 sd1=10 n1=4, m2=42 sd2=9 n2=5 -> g = 0.7531720406545097, se = 0.6939127435869921
    const est = estimateOf(
      continuousEffect("SMD", { m1: 50, sd1: 10, n1: 4, m2: 42, sd2: 9, n2: 5 }),
    );
    close(est.y, 0.7531720406545097);
    close(est.se, 0.6939127435869921);
  });

  it("applies the J correction (|g| < |d|)", () => {
    const { m1, sd1, n1, m2, sd2, n2 } = base;
    const sp = Math.sqrt(((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / (n1 + n2 - 2));
    const d = (m1 - m2) / sp;
    const est = estimateOf(continuousEffect("SMD", base));
    expect(Math.abs(est.y)).toBeLessThan(Math.abs(d));
    close(est.y, (1 - 3 / (4 * (n1 + n2 - 2) - 1)) * d);
  });

  it("identical groups give SMD = 0", () => {
    const est = estimateOf(
      continuousEffect("SMD", { m1: 5, sd1: 2, n1: 30, m2: 5, sd2: 2, n2: 30 }),
    );
    expect(est.y).toBe(0);
  });

  it("negates under group swap (se unchanged)", () => {
    const a = estimateOf(continuousEffect("SMD", base));
    const b = estimateOf(
      continuousEffect("SMD", { m1: 12.5, sd1: 3.4, n1: 42, m2: 10.2, sd2: 3.1, n2: 40 }),
    );
    close(a.y, -b.y, 1e-14);
    close(a.se, b.se, 1e-14);
  });
});
