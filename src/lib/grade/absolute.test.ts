// Unit tests for the SoF absolute-effect math: RR/OR/RD transforms against hand-computed
// values, the 0..1000 clamps, and the median control risk (odd/even/empty).

import { describe, expect, it } from "vitest";

import { absoluteFromRelative, medianControlRiskPer1000 } from "./absolute";

describe("medianControlRiskPer1000", () => {
  it("returns null when there are no control risks", () => {
    expect(medianControlRiskPer1000([])).toBeNull();
  });

  it("odd count: the middle value, scaled per 1000", () => {
    expect(medianControlRiskPer1000([0.2])).toBe(200);
    expect(medianControlRiskPer1000([0.3, 0.1, 0.2])).toBe(200); // sorts first
  });

  it("even count: mean of the middle two", () => {
    expect(medianControlRiskPer1000([0.5, 0.25])).toBe(375);
    expect(medianControlRiskPer1000([0.4, 0.1, 0.3, 0.2])).toBeCloseTo(250, 9);
  });
});

describe("absoluteFromRelative", () => {
  it("RR: corresponding = assumed x RR", () => {
    const abs = absoluteFromRelative("RR", 200, 1.5, 1.2, 1.8)!;
    expect(abs.assumedPer1000).toBe(200);
    expect(abs.correspondingPer1000).toBeCloseTo(300, 9);
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(240, 9);
    expect(abs.correspondingCiHighPer1000).toBeCloseTo(360, 9);
  });

  it("RR: clamps at 1000", () => {
    const abs = absoluteFromRelative("RR", 800, 1.5, 1.2, 2.0)!;
    expect(abs.correspondingPer1000).toBe(1000); // 1200 clamped
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(960, 9);
    expect(abs.correspondingCiHighPer1000).toBe(1000); // 1600 clamped
  });

  it("OR: corresponding = 1000 x (OR*p)/(1 - p + OR*p)", () => {
    // assumed 250/1000 -> p = 0.25:
    //   OR 2:   1000 * 0.5 / 1.25   = 400
    //   OR 1.5: 1000 * 0.375/1.125  = 333.333...
    //   OR 3:   1000 * 0.75 / 1.5   = 500
    const abs = absoluteFromRelative("OR", 250, 2, 1.5, 3)!;
    expect(abs.assumedPer1000).toBe(250);
    expect(abs.correspondingPer1000).toBeCloseTo(400, 9);
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(1000 / 3, 9);
    expect(abs.correspondingCiHighPer1000).toBeCloseTo(500, 9);
  });

  it("OR: an assumed risk of 1000 stays at 1000 for any positive OR", () => {
    const abs = absoluteFromRelative("OR", 1000, 2, 0.5, 4)!;
    expect(abs.correspondingPer1000).toBeCloseTo(1000, 9);
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(1000, 9);
    expect(abs.correspondingCiHighPer1000).toBeCloseTo(1000, 9);
  });

  it("OR: zero remains finite when the assumed risk is 1000", () => {
    const zero = absoluteFromRelative("OR", 1000, 0, 0, 0)!;
    expect(zero).toEqual({
      assumedPer1000: 1000,
      correspondingPer1000: 0,
      correspondingCiLowPer1000: 0,
      correspondingCiHighPer1000: 0,
    });
    for (const value of Object.values(zero)) expect(Number.isFinite(value)).toBe(true);

    const mixed = absoluteFromRelative("OR", 1000, 0, 0, 0.5)!;
    expect(mixed.correspondingCiHighPer1000).toBe(1000);
  });

  it("RD: corresponding = assumed + RD x 1000", () => {
    const abs = absoluteFromRelative("RD", 200, 0.05, -0.02, 0.12)!;
    expect(abs.correspondingPer1000).toBeCloseTo(250, 9);
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(180, 9);
    expect(abs.correspondingCiHighPer1000).toBeCloseTo(320, 9);
  });

  it("RD: clamps at 0", () => {
    const abs = absoluteFromRelative("RD", 30, -0.05, -0.08, 0.01)!;
    expect(abs.correspondingPer1000).toBe(0); // -20 clamped
    expect(abs.correspondingCiLowPer1000).toBe(0); // -50 clamped
    expect(abs.correspondingCiHighPer1000).toBeCloseTo(40, 9);
  });

  it("RD: clamps at 1000", () => {
    const abs = absoluteFromRelative("RD", 950, 0.1, 0.02, 0.2)!;
    expect(abs.correspondingPer1000).toBe(1000); // 1050 clamped
    expect(abs.correspondingCiLowPer1000).toBeCloseTo(970, 9);
    expect(abs.correspondingCiHighPer1000).toBe(1000); // 1150 clamped
  });

  it.each(["MD", "SMD", "GENERIC_IV", "PROPORTION"] as const)(
    "%s has no relative-to-absolute conversion",
    (measure) => {
      expect(absoluteFromRelative(measure, 200, 1.5, 1.2, 1.8)).toBeNull();
    },
  );
});
