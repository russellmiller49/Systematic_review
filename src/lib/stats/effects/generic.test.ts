// Unit tests for the GENERIC_IV per-study effect (given SE, or SE derived from a 95% CI).

import { describe, expect, it } from "vitest";

import { genericEffect } from "./generic";

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected), `expected ${actual} ≈ ${expected}`).toBeLessThanOrEqual(tol);

function estimateOf(result: ReturnType<typeof genericEffect>) {
  if ("excludedReason" in result) throw new Error(`unexpected exclusion: ${result.excludedReason}`);
  return result.estimate;
}

function reasonOf(result: ReturnType<typeof genericEffect>): string {
  if (!("excludedReason" in result)) throw new Error("expected an exclusion");
  return result.excludedReason;
}

describe("genericEffect", () => {
  it("passes through a given estimate + SE", () => {
    const { y, se } = estimateOf(genericEffect({ y: 0.25, se: 0.12, ciLow: null, ciUp: null }));
    expect(y).toBe(0.25);
    expect(se).toBe(0.12);
  });

  it("prefers the SE over CI bounds when both are present", () => {
    const { se } = estimateOf(genericEffect({ y: 0.25, se: 0.12, ciLow: 0.02, ciUp: 0.48 }));
    expect(se).toBe(0.12);
  });

  it("derives the SE from a 95% CI as (up − low) / (2·1.959963984540054)", () => {
    const { y, se } = estimateOf(genericEffect({ y: 0.25, se: null, ciLow: 0.02, ciUp: 0.48 }));
    expect(y).toBe(0.25);
    close(se, (0.48 - 0.02) / (2 * 1.959963984540054));
  });

  it("rejects invalid input with a reason", () => {
    expect(reasonOf(genericEffect({ y: NaN, se: 0.1, ciLow: null, ciUp: null }))).toMatch(
      /finite/,
    );
    expect(reasonOf(genericEffect({ y: 0.2, se: 0, ciLow: null, ciUp: null }))).toMatch(
      /standard error/,
    );
    expect(reasonOf(genericEffect({ y: 0.2, se: -0.1, ciLow: null, ciUp: null }))).toMatch(
      /standard error/,
    );
    expect(reasonOf(genericEffect({ y: 0.2, se: null, ciLow: 0.1, ciUp: null }))).toMatch(
      /SE source/,
    );
    // Inverted / degenerate CI.
    expect(reasonOf(genericEffect({ y: 0.2, se: null, ciLow: 0.5, ciUp: 0.1 }))).toMatch(
      /upper bound/,
    );
    expect(reasonOf(genericEffect({ y: 0.2, se: null, ciLow: 0.2, ciUp: 0.2 }))).toMatch(
      /upper bound/,
    );
    // Estimate outside its CI.
    expect(reasonOf(genericEffect({ y: 0.9, se: null, ciLow: 0.1, ciUp: 0.6 }))).toMatch(
      /outside/,
    );
    expect(reasonOf(genericEffect({ y: 0.2, se: null, ciLow: Infinity, ciUp: 0.6 }))).toMatch(
      /finite/,
    );
  });

  it("accepts an estimate sitting exactly on a CI bound", () => {
    const { se } = estimateOf(genericEffect({ y: 0.1, se: null, ciLow: 0.1, ciUp: 0.6 }));
    expect(se).toBeGreaterThan(0);
  });
});
