// Unit tests for computeMeta: routing, exclusion reasons, ordering, display
// back-transform, and never-throws robustness. Numeric agreement with the
// Python reference is covered exhaustively by fixtures.test.ts.

import { describe, expect, it } from "vitest";

import { computeMeta } from "./meta";
import type { StudyEffectInput } from "./types";

const close = (actual: number, expected: number, tol = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);

const binary = (id: string, e1: number, n1: number, e2: number, n2: number): StudyEffectInput => ({
  id,
  label: `Study ${id}`,
  data: { kind: "binary", counts: { e1, n1, e2, n2 } },
});

const continuous = (id: string): StudyEffectInput => ({
  id,
  label: `Study ${id}`,
  data: {
    kind: "continuous",
    stats: { m1: 10, sd1: 3, n1: 40, m2: 12, sd2: 3.2, n2: 42 },
  },
});

const BIN3 = [binary("a", 12, 100, 24, 98), binary("b", 5, 60, 10, 62), binary("c", 30, 250, 22, 245)];

const proportion = (id: string, e: number, n: number): StudyEffectInput => ({
  id,
  label: `Study ${id}`,
  data: { kind: "proportion", counts: { e, n } },
});

const generic = (id: string, y: number, se: number): StudyEffectInput => ({
  id,
  label: `Study ${id}`,
  data: { kind: "generic", stats: { y, se, ciLow: null, ciUp: null } },
});

describe("routing and exclusions", () => {
  it("excludes continuous studies from binary measures (and vice versa) with a reason", () => {
    const rr = computeMeta([...BIN3, continuous("x")], { measure: "RR" });
    expect(rr.studies.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(rr.excluded).toEqual([
      { id: "x", label: "Study x", reason: "measure RR requires binary 2×2 counts" },
    ]);

    const md = computeMeta([continuous("x"), ...BIN3], { measure: "MD" });
    expect(md.studies.map((s) => s.id)).toEqual(["x"]);
    expect(md.excluded.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(md.excluded[0]!.reason).toMatch(/requires continuous/);
  });

  it("preserves input order in both studies and excluded", () => {
    const result = computeMeta(
      [binary("z1", 0, 25, 0, 27), ...BIN3, binary("z2", 3, 30, 0, 31)],
      { measure: "RR" },
    );
    expect(result.studies.map((s) => s.id)).toEqual(["a", "b", "c", "z2"]);
    expect(result.excluded.map((s) => s.id)).toEqual(["z1"]);
  });

  it("excludes wrong-kind data for the phase B measures with a reason", () => {
    const prop = computeMeta([proportion("p", 3, 30), ...BIN3], { measure: "PROPORTION" });
    expect(prop.studies.map((s) => s.id)).toEqual(["p"]);
    expect(prop.excluded[0]!.reason).toMatch(/single-arm event counts/);

    const gen = computeMeta([generic("g", 0.2, 0.1), continuous("x")], { measure: "GENERIC_IV" });
    expect(gen.studies.map((s) => s.id)).toEqual(["g"]);
    expect(gen.excluded[0]!.reason).toMatch(/pre-computed estimate/);
  });

  it("never throws on garbage data and reports it as excluded", () => {
    const junk: StudyEffectInput[] = [
      binary("g1", NaN, -2, 5.5, 0),
      {
        id: "g2",
        label: "Study g2",
        data: { kind: "continuous", stats: { m1: NaN, sd1: -1, n1: 0, m2: 1, sd2: 1, n2: 1 } },
      },
    ];
    for (const measure of ["RR", "OR", "RD", "MD", "SMD", "PROPORTION", "GENERIC_IV"] as const) {
      const result = computeMeta(junk, { measure });
      expect(result.studies).toEqual([]);
      expect(result.excluded).toHaveLength(2);
      expect(result.fixed).toBeNull();
      expect(result.random).toBeNull();
      expect(result.heterogeneity).toBeNull();
      expect(result.predictionInterval).toBeNull();
      expect(result.egger).toBeNull();
    }
  });
});

describe("result shape", () => {
  it("sets measure/scale/nullValue per contract", () => {
    const rr = computeMeta(BIN3, { measure: "RR" });
    expect(rr.measure).toBe("RR");
    expect(rr.scale).toBe("log");
    expect(rr.nullValue).toBe(1);

    const md = computeMeta([continuous("x"), continuous("y")], { measure: "MD" });
    expect(md.scale).toBe("linear");
    expect(md.nullValue).toBe(0);

    // PROPORTION: transformed scale (defaulting to logit), no meaningful null value.
    const propDefault = computeMeta([proportion("p", 3, 30)], { measure: "PROPORTION" });
    expect(propDefault.scale).toBe("logit");
    expect(propDefault.nullValue).toBeNull();
    expect(propDefault.displayMeta).toEqual({ transform: "invlogit", harmonicN: null });
    const propFt = computeMeta([proportion("p", 3, 30)], {
      measure: "PROPORTION",
      proportionTransform: "FREEMAN_TUKEY",
    });
    expect(propFt.scale).toBe("ft");
    expect(propFt.displayMeta.transform).toBe("ft");
    close(propFt.displayMeta.harmonicN!, 30, 1e-12);

    const gen = computeMeta([generic("g", 0.2, 0.1)], { measure: "GENERIC_IV" });
    expect(gen.scale).toBe("linear");
    expect(gen.nullValue).toBe(0);
    expect(gen.displayMeta).toEqual({ transform: "identity", harmonicN: null });
  });

  it("prediction interval and Egger appear together at k >= 3 and are null below", () => {
    const two = computeMeta(BIN3.slice(0, 2), { measure: "RR" });
    expect(two.predictionInterval).toBeNull();
    expect(two.egger).toBeNull();

    const three = computeMeta(BIN3, { measure: "RR" });
    expect(three.predictionInterval).not.toBeNull();
    expect(three.egger).not.toBeNull();
    expect(three.egger!.k).toBe(3);
    // PI display back-transforms like the pooled estimate (exp on the log scale).
    close(three.predictionInterval!.display.low, Math.exp(three.predictionInterval!.low), 1e-12);
    expect(three.predictionInterval!.low).toBeLessThan(three.random!.ciLow);
    expect(three.predictionInterval!.high).toBeGreaterThan(three.random!.ciHigh);
  });

  it("back-transforms display via exp() on the log scale", () => {
    const rr = computeMeta(BIN3, { measure: "RR" });
    for (const s of rr.studies) {
      close(s.display.estimate, Math.exp(s.y), 1e-12);
      close(s.display.ciLow, Math.exp(s.ciLow), 1e-12);
      close(s.display.ciHigh, Math.exp(s.ciHigh), 1e-12);
    }
    close(rr.fixed!.display.estimate, Math.exp(rr.fixed!.y), 1e-12);
    close(rr.random!.display.ciHigh, Math.exp(rr.random!.ciHigh), 1e-12);
    expect(rr.fixed!.model).toBe("FIXED");
    expect(rr.random!.model).toBe("RANDOM");
  });

  it("uses the identity display on the linear scale", () => {
    const rd = computeMeta(BIN3, { measure: "RD" });
    for (const s of rd.studies) {
      expect(s.display.estimate).toBe(s.y);
      expect(s.display.ciLow).toBe(s.ciLow);
      expect(s.display.ciHigh).toBe(s.ciHigh);
    }
    expect(rd.fixed!.display.estimate).toBe(rd.fixed!.y);
  });

  it("percentage weights sum to ~100 for both models", () => {
    const rr = computeMeta(BIN3, { measure: "RR" });
    const sumFixed = rr.studies.reduce((a, s) => a + s.weightFixedPct, 0);
    const sumRandom = rr.studies.reduce((a, s) => a + s.weightRandomPct, 0);
    close(sumFixed, 100, 1e-6);
    close(sumRandom, 100, 1e-6);
  });

  it("single included study: fixed = random, heterogeneity null, weight 100", () => {
    const result = computeMeta([binary("a", 7, 50, 14, 52)], { measure: "OR" });
    expect(result.heterogeneity).toBeNull();
    expect(result.fixed!.y).toBe(result.random!.y);
    expect(result.fixed!.se).toBe(result.random!.se);
    close(result.studies[0]!.weightFixedPct, 100, 1e-12);
    close(result.studies[0]!.weightRandomPct, 100, 1e-12);
  });

  it("empty input yields an empty, null-pooled result", () => {
    const result = computeMeta([], { measure: "SMD" });
    expect(result.studies).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.fixed).toBeNull();
    expect(result.random).toBeNull();
    expect(result.heterogeneity).toBeNull();
  });

  it("saturates p at 0 instead of NaN for an astronomically extreme z", () => {
    // se = 2e-154 keeps the weight finite (2.5e307) so the study pools, but the
    // pooled z ~ 2.5e154 makes erfc's x*x overflow — p must saturate at 0, not NaN.
    const md = computeMeta(
      [
        {
          id: "a",
          label: "Study a",
          data: { kind: "continuous", stats: { m1: 5, sd1: 2e-154, n1: 2, m2: 0, sd2: 2e-154, n2: 2 } },
        },
      ],
      { measure: "MD" },
    );
    expect(md.excluded).toEqual([]);
    expect(md.fixed!.p).toBe(0);
    expect(md.random!.p).toBe(0);
    expect(Number.isNaN(md.fixed!.z)).toBe(false);
  });

  it("excludes a study whose inverse-variance weight overflows", () => {
    // se ~ 1.3e-160 -> w = 1/se² overflows to Infinity, which would poison the
    // pooled sums with NaN — the study must land in `excluded` instead.
    const md = computeMeta(
      [
        {
          id: "tiny",
          label: "Study tiny",
          data: { kind: "continuous", stats: { m1: 10, sd1: 1e-160, n1: 2, m2: 0, sd2: 1e-160, n2: 2 } },
        },
        continuous("ok"),
      ],
      { measure: "MD" },
    );
    expect(md.excluded.map((s) => s.id)).toEqual(["tiny"]);
    expect(md.excluded[0]!.reason).toContain("too extreme to weight");
    expect(md.studies.map((s) => s.id)).toEqual(["ok"]);
    expect(Number.isNaN(md.fixed!.y)).toBe(false);
    expect(Number.isNaN(md.random!.p)).toBe(false);
  });
});
