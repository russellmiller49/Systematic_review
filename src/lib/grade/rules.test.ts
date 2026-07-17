// Unit tests for the deterministic GRADE rules: every judgment band edge of all five
// domains, the certainty arithmetic (incl. the floor at 1 point), and round4.

import { describe, expect, it } from "vitest";

import {
  computeCertainty,
  draftGradeRatings,
  EGGER_P_THRESHOLD,
  I2_SERIOUS_THRESHOLD,
  I2_VERY_SERIOUS_THRESHOLD,
  OIS_THRESHOLD,
  PUBLICATION_BIAS_MIN_K,
  RATIO_APPRECIABLE_HIGH,
  RATIO_APPRECIABLE_LOW,
  ROB_SERIOUS_CONCERN_WEIGHT,
  ROB_SERIOUS_HIGH_WEIGHT,
  ROB_VERY_SERIOUS_HIGH_WEIGHT,
  round4,
  SMD_APPRECIABLE_BOUND,
} from "./rules";
import type { DomainDraft, GradeDomainId, GradeRulesInput, GradeStudyInput, RobBucket } from "./types";

let studySeq = 0;

function study(
  weightPct: number,
  bucket: RobBucket = "low",
  classificationCertain = bucket !== "unassessed",
): GradeStudyInput {
  studySeq += 1;
  const assessed = bucket !== "unassessed";
  return {
    studyId: `s${studySeq}`,
    label: `Study ${studySeq}`,
    weightPct,
    n: 100,
    rob: {
      judgment: assessed ? bucket : null,
      judgmentLabel: assessed ? `${bucket} label` : null,
      bucket,
      classificationCertain,
      provenance: assessed ? "consensus" : null,
      toolId: assessed ? "rob-2" : null,
      toolName: assessed ? "RoB 2" : null,
    },
  };
}

function baseInput(overrides: Partial<GradeRulesInput> = {}): GradeRulesInput {
  return {
    measure: "RR",
    model: "RANDOM",
    nullValue: 1,
    pooled: { estimate: 3.0, ciLow: 1.85, ciHigh: 4.87 },
    heterogeneity: { i2: 0, q: 0.4, df: 1, p: 0.53 },
    egger: null,
    k: 2,
    totalN: 500,
    studies: [study(60), study(40)],
    startingLevel: "HIGH",
    ...overrides,
  };
}

function ratingFor(input: GradeRulesInput, domain: GradeDomainId): DomainDraft {
  const rating = draftGradeRatings(input).ratings.find((r) => r.domain === domain);
  expect(rating).toBeDefined();
  return rating!;
}

describe("round4", () => {
  it("rounds to 4 decimal places", () => {
    expect(round4(1.23456)).toBe(1.2346);
    expect(round4(1.23454)).toBe(1.2345);
    expect(round4(33.333333333)).toBe(33.3333);
    expect(round4(-2.00005)).toBe(-2);
  });

  it("leaves integers and clean fractions untouched", () => {
    expect(round4(287)).toBe(287);
    expect(round4(0.1 + 0.2)).toBe(0.3);
  });
});

describe("computeCertainty", () => {
  it("maps points to certainty (4 HIGH, 3 MODERATE, 2 LOW, 1 VERY_LOW)", () => {
    expect(computeCertainty("HIGH", [])).toEqual({ points: 4, certainty: "HIGH" });
    expect(computeCertainty("HIGH", ["SERIOUS"])).toEqual({ points: 3, certainty: "MODERATE" });
    expect(computeCertainty("HIGH", ["SERIOUS", "SERIOUS"])).toEqual({
      points: 2,
      certainty: "LOW",
    });
    expect(computeCertainty("HIGH", ["VERY_SERIOUS", "SERIOUS"])).toEqual({
      points: 1,
      certainty: "VERY_LOW",
    });
  });

  it("NOT_SERIOUS never downgrades", () => {
    expect(
      computeCertainty("HIGH", [
        "NOT_SERIOUS",
        "NOT_SERIOUS",
        "NOT_SERIOUS",
        "NOT_SERIOUS",
        "NOT_SERIOUS",
      ]),
    ).toEqual({ points: 4, certainty: "HIGH" });
  });

  it("starts observational (LOW) evidence at 2 points", () => {
    expect(computeCertainty("LOW", [])).toEqual({ points: 2, certainty: "LOW" });
    expect(computeCertainty("LOW", ["SERIOUS"])).toEqual({ points: 1, certainty: "VERY_LOW" });
  });

  it("floors points at 1", () => {
    expect(
      computeCertainty("HIGH", ["VERY_SERIOUS", "VERY_SERIOUS", "VERY_SERIOUS"]),
    ).toEqual({ points: 1, certainty: "VERY_LOW" });
    expect(computeCertainty("LOW", ["VERY_SERIOUS", "VERY_SERIOUS"])).toEqual({
      points: 1,
      certainty: "VERY_LOW",
    });
  });
});

describe("draftGradeRatings", () => {
  it("throws when pooled is null (the service refuses k = 0 upstream)", () => {
    expect(() => draftGradeRatings(baseInput({ pooled: null }))).toThrow(/pooled/);
  });

  it("returns the five domains in canonical order", () => {
    const draft = draftGradeRatings(baseInput());
    expect(draft.ratings.map((r) => r.domain)).toEqual([
      "RISK_OF_BIAS",
      "INCONSISTENCY",
      "INDIRECTNESS",
      "IMPRECISION",
      "PUBLICATION_BIAS",
    ]);
  });

  it("reproduces the seeded demo outcome: imprecision is the only strike -> MODERATE", () => {
    // RR 3.00 [1.85, 4.87], I² = 0, k = 2, totalN = 287 < 400, both studies low risk.
    const draft = draftGradeRatings(
      baseInput({ totalN: 287, studies: [study(50), study(50)] }),
    );
    const byDomain = Object.fromEntries(draft.ratings.map((r) => [r.domain, r]));
    expect(byDomain.RISK_OF_BIAS!.judgment).toBe("NOT_SERIOUS");
    expect(byDomain.RISK_OF_BIAS!.requiresReview).toBe(false);
    expect(byDomain.INCONSISTENCY!.judgment).toBe("NOT_SERIOUS");
    expect(byDomain.INCONSISTENCY!.requiresReview).toBe(false);
    expect(byDomain.INDIRECTNESS!.judgment).toBe("NOT_SERIOUS");
    expect(byDomain.INDIRECTNESS!.requiresReview).toBe(true);
    expect(byDomain.IMPRECISION!.judgment).toBe("SERIOUS");
    expect(byDomain.PUBLICATION_BIAS!.judgment).toBe("NOT_SERIOUS");
    expect(byDomain.PUBLICATION_BIAS!.requiresReview).toBe(true);
    expect(draft.points).toBe(3);
    expect(draft.certainty).toBe("MODERATE");
  });

  it("computes certainty over all five judgments", () => {
    // I² 80 -> VERY_SERIOUS, totalN 300 -> SERIOUS: 4 - 2 - 1 = 1.
    const draft = draftGradeRatings(
      baseInput({ heterogeneity: { i2: 80, q: 10, df: 1, p: 0.001 }, totalN: 300 }),
    );
    expect(draft.points).toBe(1);
    expect(draft.certainty).toBe("VERY_LOW");
  });

  it("rejects non-finite numeric inputs before building JSON metrics", () => {
    const invalidInputs: Array<[path: string, makeInput: () => GradeRulesInput]> = [
      [
        "pooled.estimate",
        () => baseInput({ pooled: { estimate: Number.NaN, ciLow: 1, ciHigh: 2 } }),
      ],
      [
        "pooled.ciLow",
        () => baseInput({ pooled: { estimate: 1, ciLow: Number.NEGATIVE_INFINITY, ciHigh: 2 } }),
      ],
      [
        "heterogeneity.q",
        () =>
          baseInput({
            heterogeneity: { i2: 20, q: Number.POSITIVE_INFINITY, df: 1, p: 0.5 },
          }),
      ],
      ["egger.p", () => baseInput({ egger: { p: Number.NaN, k: 10 } })],
      ["k", () => baseInput({ k: Number.POSITIVE_INFINITY })],
      ["nullValue", () => baseInput({ nullValue: Number.NaN })],
      ["totalN", () => baseInput({ totalN: Number.POSITIVE_INFINITY })],
      [
        "studies[0].weightPct",
        () => baseInput({ studies: [study(Number.NaN), study(100)] }),
      ],
      [
        "studies[0].n",
        () => {
          const invalidStudy = study(100);
          invalidStudy.n = Number.NEGATIVE_INFINITY;
          return baseInput({ studies: [invalidStudy] });
        },
      ],
    ];
    for (const [path, makeInput] of invalidInputs) {
      expect(() => draftGradeRatings(makeInput()), path).toThrow(path);
    }
  });
});

describe("INCONSISTENCY", () => {
  const het = (i2: number) => ({ i2, q: 8.1234567, df: 3, p: 0.0439876 });
  const atI2 = (i2: number) =>
    ratingFor(baseInput({ k: 4, heterogeneity: het(i2) }), "INCONSISTENCY");

  it("k < 2: not assessable -> NOT_SERIOUS + requiresReview", () => {
    const rating = ratingFor(
      baseInput({ k: 1, heterogeneity: null, studies: [study(100)] }),
      "INCONSISTENCY",
    );
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.rationale).toContain("heterogeneity not assessable");
    expect(rating.rationale).toContain("k = 1");
    expect(rating.metrics).toEqual({ i2: null, q: null, df: null, p: null, k: 1 });
  });

  it("I² band edges: 39.9 / 40 / 75 / 75.1", () => {
    expect(atI2(39.9).judgment).toBe("NOT_SERIOUS");
    expect(atI2(I2_SERIOUS_THRESHOLD).judgment).toBe("SERIOUS");
    expect(atI2(I2_VERY_SERIOUS_THRESHOLD).judgment).toBe("SERIOUS");
    expect(atI2(75.1).judgment).toBe("VERY_SERIOUS");
    expect(atI2(75.1).requiresReview).toBe(false);
  });

  it("uses round4 I² values for both threshold decisions and metrics", () => {
    const below40 = atI2(39.99994);
    expect(below40.judgment).toBe("NOT_SERIOUS");
    expect(below40.metrics.i2).toBe(39.9999);

    const rounded40 = atI2(39.99996);
    expect(rounded40.judgment).toBe("SERIOUS");
    expect(rounded40.metrics.i2).toBe(40);
    expect(rounded40.rationale).toContain("I² = 40%");
    const rounded40FromAbove = atI2(40.00004);
    expect(rounded40FromAbove.judgment).toBe("SERIOUS");
    expect(rounded40FromAbove.metrics.i2).toBe(40);

    expect(atI2(75.00004).judgment).toBe("SERIOUS");
    const above75 = atI2(75.00006);
    expect(above75.judgment).toBe("VERY_SERIOUS");
    expect(above75.metrics.i2).toBe(75.0001);
  });

  it("rationale quotes the numbers and metrics snapshot them at 4 dp", () => {
    const rating = ratingFor(baseInput({ k: 4, heterogeneity: het(52.5) }), "INCONSISTENCY");
    expect(rating.rationale).toContain("I² = 52.5%");
    expect(rating.rationale).toContain("k = 4");
    expect(rating.rationale).toContain("Q = 8.1235");
    expect(rating.rationale).toContain("p = 0.044");
    expect(rating.metrics).toEqual({ i2: 52.5, q: 8.1235, df: 3, p: 0.044, k: 4 });
  });
});

describe("IMPRECISION", () => {
  const imprecision = (overrides: Partial<GradeRulesInput>) =>
    ratingFor(baseInput(overrides), "IMPRECISION");

  it("no strikes: CI clear of the null, OIS met -> NOT_SERIOUS", () => {
    const rating = imprecision({ totalN: OIS_THRESHOLD });
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(false);
    expect(rating.metrics).toEqual({
      estimate: 3,
      ciLow: 1.85,
      ciHigh: 4.87,
      nullValue: 1,
      crossesNull: false,
      crossesBoth: false,
      appreciableLow: RATIO_APPRECIABLE_LOW,
      appreciableHigh: RATIO_APPRECIABLE_HIGH,
      totalN: 400,
      oisThreshold: OIS_THRESHOLD,
      oisShort: false,
    });
  });

  it("OIS edge: totalN 399 is one strike, 400 is none", () => {
    expect(imprecision({ totalN: 399 }).judgment).toBe("SERIOUS");
    expect(imprecision({ totalN: 400 }).judgment).toBe("NOT_SERIOUS");
  });

  it("null-crossing CI alone is one strike", () => {
    const rating = imprecision({ pooled: { estimate: 1.04, ciLow: 0.9, ciHigh: 1.2 } });
    expect(rating.judgment).toBe("SERIOUS");
    expect(rating.metrics.crossesNull).toBe(true);
    expect(rating.metrics.crossesBoth).toBe(false);
    expect(rating.requiresReview).toBe(false); // RR has appreciable bounds -> no MID note
  });

  it.each([
    [1, 1.2],
    [0.8, 1],
    [1, 1],
  ])("CI %s to %s inclusively contains the null", (ciLow, ciHigh) => {
    const rating = imprecision({ pooled: { estimate: 1, ciLow, ciHigh } });
    expect(rating.judgment).toBe("SERIOUS");
    expect(rating.metrics.crossesNull).toBe(true);
  });

  it("uses round4 CI bounds for inclusive null containment", () => {
    const roundedToNull = imprecision({
      pooled: { estimate: 1.1, ciLow: 1.00004, ciHigh: 1.2 },
    });
    expect(roundedToNull.metrics.ciLow).toBe(1);
    expect(roundedToNull.metrics.crossesNull).toBe(true);
    expect(roundedToNull.judgment).toBe("SERIOUS");

    const remainsAboveNull = imprecision({
      pooled: { estimate: 1.1, ciLow: 1.00006, ciHigh: 1.2 },
    });
    expect(remainsAboveNull.metrics.ciLow).toBe(1.0001);
    expect(remainsAboveNull.metrics.crossesNull).toBe(false);
    expect(remainsAboveNull.judgment).toBe("NOT_SERIOUS");
  });

  it("null-crossing + short OIS is two strikes -> VERY_SERIOUS", () => {
    const rating = imprecision({
      pooled: { estimate: 1.04, ciLow: 0.9, ciHigh: 1.2 },
      totalN: 399,
    });
    expect(rating.judgment).toBe("VERY_SERIOUS");
  });

  it("CI spanning both appreciable bounds -> VERY_SERIOUS regardless of OIS", () => {
    const rating = imprecision({
      pooled: { estimate: 1.0, ciLow: 0.7, ciHigh: 1.3 },
      totalN: 10000,
    });
    expect(rating.judgment).toBe("VERY_SERIOUS");
    expect(rating.metrics.crossesBoth).toBe(true);
    expect(rating.rationale).toContain(
      `both appreciable-effect bounds (${RATIO_APPRECIABLE_LOW.toFixed(2)} and ${RATIO_APPRECIABLE_HIGH.toFixed(2)})`,
    );
  });

  it("crossesBoth needs strict crossing: ciLow exactly 0.75 does not span", () => {
    const rating = imprecision({
      pooled: { estimate: 1.0, ciLow: 0.75, ciHigh: 1.3 },
      totalN: 10000,
    });
    expect(rating.metrics.crossesBoth).toBe(false);
    expect(rating.judgment).toBe("SERIOUS"); // crossesNull only
  });

  it("keeps appreciable-bound spanning strict after round4", () => {
    const roundedToBounds = imprecision({
      pooled: { estimate: 1, ciLow: 0.74996, ciHigh: 1.25004 },
      totalN: 10000,
    });
    expect(roundedToBounds.metrics).toMatchObject({
      ciLow: 0.75,
      ciHigh: 1.25,
      crossesBoth: false,
    });
    expect(roundedToBounds.judgment).toBe("SERIOUS");

    const beyondBounds = imprecision({
      pooled: { estimate: 1, ciLow: 0.74994, ciHigh: 1.25006 },
      totalN: 10000,
    });
    expect(beyondBounds.metrics).toMatchObject({
      ciLow: 0.7499,
      ciHigh: 1.2501,
      crossesBoth: true,
    });
    expect(beyondBounds.judgment).toBe("VERY_SERIOUS");
  });

  it("totalN null: never an OIS strike, but requiresReview", () => {
    const clear = imprecision({ totalN: null });
    expect(clear.judgment).toBe("NOT_SERIOUS");
    expect(clear.requiresReview).toBe(true);
    expect(clear.rationale.toLowerCase()).toContain("sample size unavailable");
    expect(clear.metrics.totalN).toBeNull();
    expect(clear.metrics.oisShort).toBe(false);

    const crossing = imprecision({
      totalN: null,
      pooled: { estimate: 1.0, ciLow: 0.9, ciHigh: 1.2 },
    });
    expect(crossing.judgment).toBe("SERIOUS"); // the null-crossing strike still counts
    expect(crossing.requiresReview).toBe(true);
  });

  it("SMD uses ±0.5 appreciable bounds", () => {
    const both = imprecision({
      measure: "SMD",
      nullValue: 0,
      pooled: { estimate: 0, ciLow: -0.6, ciHigh: 0.6 },
      totalN: 10000,
    });
    expect(both.judgment).toBe("VERY_SERIOUS");
    expect(both.metrics.appreciableLow).toBe(-SMD_APPRECIABLE_BOUND);
    expect(both.metrics.appreciableHigh).toBe(SMD_APPRECIABLE_BOUND);
    expect(both.rationale).toContain("both appreciable-effect bounds (-0.50 and 0.50)");

    const nullOnly = imprecision({
      measure: "SMD",
      nullValue: 0,
      pooled: { estimate: 0.05, ciLow: -0.4, ciHigh: 0.45 },
      totalN: 10000,
    });
    expect(nullOnly.judgment).toBe("SERIOUS");
    expect(nullOnly.requiresReview).toBe(false);
  });

  it.each(["MD", "RD", "GENERIC_IV"] as const)(
    "%s has no appreciable bounds: crossesBoth is impossible and a null-crossing needs review",
    (measure) => {
      const crossing = imprecision({
        measure,
        nullValue: 0,
        pooled: { estimate: 1.2, ciLow: -2.2, ciHigh: 5.5 },
        totalN: 1000,
      });
      expect(crossing.judgment).toBe("SERIOUS"); // one strike, never crossesBoth
      expect(crossing.metrics.crossesBoth).toBe(false);
      expect(crossing.requiresReview).toBe(true); // no MID available
      expect("appreciableLow" in crossing.metrics).toBe(false);
      expect("appreciableHigh" in crossing.metrics).toBe(false);

      const clear = imprecision({
        measure,
        nullValue: 0,
        pooled: { estimate: 3.1, ciLow: 1.2, ciHigh: 5.0 },
        totalN: 1000,
      });
      expect(clear.judgment).toBe("NOT_SERIOUS");
      expect(clear.requiresReview).toBe(false);
    },
  );

  it("PROPORTION: judgment from OIS only, always requiresReview", () => {
    const proportion = (totalN: number | null) =>
      imprecision({
        measure: "PROPORTION",
        nullValue: null,
        pooled: { estimate: 0.3, ciLow: 0.22, ciHigh: 0.4 },
        totalN,
      });
    const short = proportion(350);
    expect(short.judgment).toBe("SERIOUS");
    expect(short.requiresReview).toBe(true);
    expect(short.rationale).toContain("Pooled proportion 95% CI 0.22 to 0.40 (width 0.18)");
    expect(short.rationale).toContain("no null-crossing test");
    expect(short.metrics).toEqual({
      ciLow: 0.22,
      ciHigh: 0.4,
      ciWidth: 0.18,
      totalN: 350,
      oisShort: true,
    });

    const ample = proportion(800);
    expect(ample.judgment).toBe("NOT_SERIOUS");
    expect(ample.requiresReview).toBe(true);

    const unknown = proportion(null);
    expect(unknown.judgment).toBe("NOT_SERIOUS");
    expect(unknown.requiresReview).toBe(true);
    expect(unknown.rationale.toLowerCase()).toContain("sample size unavailable");
  });

  it("formats the seeded effect and CI for prose while retaining round4 metrics", () => {
    const rating = imprecision({
      pooled: { estimate: 2.9999, ciLow: 1.8465, ciHigh: 4.8738 },
      totalN: 287,
    });
    expect(rating.rationale).toBe(
      `Pooled RR 3.00 (95% CI 1.85 to 4.87) does not cross the null value of 1. Total N = 287 falls short of the optimal information size heuristic of ${OIS_THRESHOLD} participants. 1 imprecision concern.`,
    );
    expect(rating.metrics).toMatchObject({
      estimate: 2.9999,
      ciLow: 1.8465,
      ciHigh: 4.8738,
    });
  });

  it("uses one decimal for absolute effect-scale values at or above 100", () => {
    const positive = imprecision({
      measure: "MD",
      nullValue: 0,
      pooled: { estimate: 123.456, ciLow: 100.04, ciHigh: 150.06 },
      totalN: 1000,
    });
    expect(positive.rationale).toContain("Pooled MD 123.5 (95% CI 100.0 to 150.1)");
    expect(positive.metrics).toMatchObject({
      estimate: 123.456,
      ciLow: 100.04,
      ciHigh: 150.06,
    });

    const negative = imprecision({
      measure: "MD",
      nullValue: 0,
      pooled: { estimate: -123.456, ciLow: -150.06, ciHigh: -100.04 },
      totalN: 1000,
    });
    expect(negative.rationale).toContain("Pooled MD -123.5 (95% CI -150.1 to -100.0)");
    expect(negative.metrics).toMatchObject({
      estimate: -123.456,
      ciLow: -150.06,
      ciHigh: -100.04,
    });
  });
});

describe("RISK_OF_BIAS", () => {
  const rob = (studies: GradeStudyInput[]) =>
    ratingFor(baseInput({ studies, k: studies.length }), "RISK_OF_BIAS");

  it("all low-risk weight -> NOT_SERIOUS without review", () => {
    const rating = rob([study(60), study(40)]);
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(false);
  });

  it("high-risk weight edges: 19.9 / 20 / 49.9 / 50", () => {
    expect(rob([study(19.9, "high"), study(80.1)]).judgment).toBe("NOT_SERIOUS");
    expect(rob([study(ROB_SERIOUS_HIGH_WEIGHT, "high"), study(80)]).judgment).toBe("SERIOUS");
    expect(rob([study(49.9, "high"), study(50.1)]).judgment).toBe("SERIOUS");
    expect(rob([study(ROB_VERY_SERIOUS_HIGH_WEIGHT, "high"), study(50)]).judgment).toBe(
      "VERY_SERIOUS",
    );
  });

  it("uses round4 weights for threshold decisions and rationale", () => {
    const below20 = rob([study(19.99994, "high"), study(80.00006)]);
    expect(below20.judgment).toBe("NOT_SERIOUS");
    expect(below20.metrics).toMatchObject({ weightPctByBucket: { high: 19.9999 } });
    expect(below20.rationale).toContain("high-risk weight 19.9999% is below 20%");

    for (const rawWeight of [19.99996, 20.00004]) {
      const rounded20 = rob([study(rawWeight, "high"), study(100 - rawWeight)]);
      expect(rounded20.judgment).toBe("SERIOUS");
      expect(rounded20.metrics).toMatchObject({ weightPctByBucket: { high: 20 } });
      expect(rounded20.rationale).toContain("20% of pooled weight is at high risk");
    }

    const rounded50 = rob([study(49.99996, "high"), study(50.00004)]);
    expect(rounded50.judgment).toBe("VERY_SERIOUS");
    expect(rounded50.metrics).toMatchObject({ weightPctByBucket: { high: 50 } });

    const roundedConcern = rob([
      study(9.99996, "high"),
      study(39.99996, "moderate"),
      study(50.00008),
    ]);
    expect(roundedConcern.judgment).toBe("SERIOUS");
    expect(roundedConcern.metrics).toMatchObject({
      weightPctByBucket: { high: 10, moderate: 40 },
    });
    expect(roundedConcern.rationale).toContain("50% of pooled weight carries risk-of-bias concerns");
  });

  it("concern-weight edges (moderate counts): 49.9 / 50", () => {
    expect(rob([study(49.9, "moderate"), study(50.1)]).judgment).toBe("NOT_SERIOUS");
    expect(rob([study(ROB_SERIOUS_CONCERN_WEIGHT, "moderate"), study(50)]).judgment).toBe(
      "SERIOUS",
    );
    // High-risk weight below its own threshold still counts toward the concern sum.
    expect(rob([study(10, "high"), study(40, "moderate"), study(50)]).judgment).toBe("SERIOUS");
    expect(rob([study(10, "high"), study(39, "moderate"), study(51)]).judgment).toBe(
      "NOT_SERIOUS",
    );
  });

  it("unclear and unassessed weight count as concern and force review", () => {
    const unclear = rob([study(50, "unclear"), study(50)]);
    expect(unclear.judgment).toBe("SERIOUS");
    expect(unclear.requiresReview).toBe(true);

    const unassessed = rob([study(30, "unassessed"), study(70)]);
    expect(unassessed.judgment).toBe("NOT_SERIOUS");
    expect(unassessed.requiresReview).toBe(true);
  });

  it("surfaces uncertain classification weight and forces review", () => {
    const studies = [study(30, "low", false), study(70)];
    const rating = rob(studies);
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.rationale).toContain("30% of weight uses an uncertain risk-of-bias classification");
    expect(rating.metrics.uncertainClassificationWeightPct).toBe(30);
    const perStudy = rating.metrics.perStudy as Array<{ classificationCertain: boolean }>;
    expect(perStudy[0]).toMatchObject({ classificationCertain: false });
    expect(perStudy[1]).toMatchObject({ classificationCertain: true });
  });

  it("metrics carry per-bucket weights, per-study rows and the thresholds", () => {
    const studies = [study(55, "high"), study(45, "moderate")];
    const rating = rob(studies);
    expect(rating.judgment).toBe("VERY_SERIOUS");
    expect(rating.metrics.weightPctByBucket).toEqual({
      low: 0,
      moderate: 45,
      high: 55,
      unclear: 0,
      unassessed: 0,
    });
    expect(rating.metrics.uncertainClassificationWeightPct).toBe(0);
    expect(rating.metrics.perStudy).toEqual([
      {
        studyId: studies[0]!.studyId,
        label: studies[0]!.label,
        judgment: "high",
        judgmentLabel: "high label",
        bucket: "high",
        classificationCertain: true,
        provenance: "consensus",
        toolId: "rob-2",
        toolName: "RoB 2",
        weightPct: 55,
      },
      {
        studyId: studies[1]!.studyId,
        label: studies[1]!.label,
        judgment: "moderate",
        judgmentLabel: "moderate label",
        bucket: "moderate",
        classificationCertain: true,
        provenance: "consensus",
        toolId: "rob-2",
        toolName: "RoB 2",
        weightPct: 45,
      },
    ]);
    expect(rating.metrics.thresholds).toEqual({
      verySeriousHighWeight: ROB_VERY_SERIOUS_HIGH_WEIGHT,
      seriousHighWeight: ROB_SERIOUS_HIGH_WEIGHT,
      seriousConcernWeight: ROB_SERIOUS_CONCERN_WEIGHT,
    });
  });

  it("rationale lists per-bucket counts, weights and the tool name", () => {
    const rating = rob([study(55, "high"), study(45)]);
    expect(rating.rationale).toContain("RoB 2");
    expect(rating.rationale).toContain("high: 1 study (55% weight)");
    expect(rating.rationale).toContain("low: 1 study (45% weight)");
    expect(rating.rationale).toContain("55%");
  });
});

describe("INDIRECTNESS", () => {
  it("is always NOT_SERIOUS with requiresReview (human PICO judgment)", () => {
    const rating = ratingFor(baseInput(), "INDIRECTNESS");
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.metrics).toEqual({ automated: false });
    for (const term of ["population", "intervention", "comparator", "outcome"]) {
      expect(rating.rationale).toContain(term);
    }
  });
});

describe("PUBLICATION_BIAS", () => {
  const pubBias = (k: number, egger: GradeRulesInput["egger"]) =>
    ratingFor(baseInput({ k, egger }), "PUBLICATION_BIAS");

  it("k = 9 is below the funnel-test minimum even with a significant Egger p", () => {
    const rating = pubBias(9, { p: 0.05, k: 9 });
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.rationale).toContain("k = 9");
    expect(rating.rationale).toContain(`${PUBLICATION_BIAS_MIN_K}-study minimum`);
    expect(rating.metrics).toEqual({ k: 9, eggerP: 0.05, eggerThreshold: EGGER_P_THRESHOLD });
  });

  it("k = 10 with Egger p 0.09 -> SERIOUS", () => {
    const rating = pubBias(10, { p: 0.09, k: 10 });
    expect(rating.judgment).toBe("SERIOUS");
    expect(rating.requiresReview).toBe(false);
    expect(rating.rationale).toContain("0.09");
    expect(rating.metrics).toEqual({ k: 10, eggerP: 0.09, eggerThreshold: EGGER_P_THRESHOLD });
  });

  it("k = 10 with Egger p 0.11 -> NOT_SERIOUS but still requiresReview", () => {
    const rating = pubBias(10, { p: 0.11, k: 10 });
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.rationale).toContain("0.11");
  });

  it("Egger p exactly at the 0.10 threshold is not a downgrade", () => {
    expect(pubBias(10, { p: EGGER_P_THRESHOLD, k: 10 }).judgment).toBe("NOT_SERIOUS");
  });

  it("uses round4 Egger p values for both threshold decisions and metrics", () => {
    const below = pubBias(10, { p: 0.09994, k: 10 });
    expect(below.judgment).toBe("SERIOUS");
    expect(below.metrics.eggerP).toBe(0.0999);

    for (const rawP of [0.09996, 0.10004]) {
      const roundedThreshold = pubBias(10, { p: rawP, k: 10 });
      expect(roundedThreshold.judgment).toBe("NOT_SERIOUS");
      expect(roundedThreshold.metrics.eggerP).toBe(0.1);
      expect(roundedThreshold.rationale).toContain("p = 0.1 >= 0.1");
    }
  });

  it("k >= 10 with a degenerate (null) Egger test -> NOT_SERIOUS + requiresReview", () => {
    const rating = pubBias(10, null);
    expect(rating.judgment).toBe("NOT_SERIOUS");
    expect(rating.requiresReview).toBe(true);
    expect(rating.rationale.toLowerCase()).toContain("degenerate");
    expect(rating.metrics).toEqual({ k: 10, eggerP: null, eggerThreshold: EGGER_P_THRESHOLD });
  });
});
