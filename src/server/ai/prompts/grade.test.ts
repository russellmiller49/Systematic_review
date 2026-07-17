import { describe, expect, it } from "vitest";
import { buildGradePrompt, GRADE_PROMPT_VERSION, type GradePromptInput } from "./grade";
import { GRADE_JSON_SCHEMA } from "../schemas";

const INPUT: GradePromptInput = {
  outcome: {
    name: "FEV1 responders",
    timepoint: "12 months",
    measure: "RR",
    direction: "HIGHER_IS_BETTER",
    groupLabels: { g1: "Valve", g2: "Standard of care" },
  },
  picos: [
    {
      question: "KQ1",
      population: "Adults with severe emphysema",
      intervention: "Endobronchial valves",
      comparator: "Standard of care",
      outcomes: "FEV1 response at 12 months",
    },
  ],
  protocolSummary: "Valves for emphysema: a systematic review of RCTs.",
  deterministic: [
    {
      domain: "RISK_OF_BIAS",
      judgment: "NOT_SERIOUS",
      rationale: "100.0% of weight from low-risk studies.",
      requiresReview: false,
      metrics: { weightPctByBucket: { low: 100 } },
    },
    {
      domain: "IMPRECISION",
      judgment: "SERIOUS",
      rationale: "Total participants 287 below the OIS of 400.",
      requiresReview: true,
      metrics: { totalN: 287, oisShort: true },
    },
  ],
  pooledSummary: {
    k: 2,
    totalN: 287,
    estimate: 3.00443,
    ciLow: 1.85432,
    ciHigh: 4.86977,
    i2: 0,
    model: "RANDOM",
    measureLabel: "Risk ratio",
  },
  studies: [
    {
      label: "Smith 2019",
      n: 150,
      effectDisplay: "2.90 [1.50, 5.40]",
      robBucket: "low",
      robJudgmentLabel: "Low risk",
    },
    {
      label: "Jones 2021",
      n: 137,
      effectDisplay: null,
      robBucket: "unassessed",
      robJudgmentLabel: null,
    },
  ],
};

describe("buildGradePrompt", () => {
  it("serializes the outcome, pooled result, studies, and deterministic first pass", () => {
    const prompt = buildGradePrompt(INPUT);
    expect(prompt.user).toContain("Name: FEV1 responders");
    expect(prompt.user).toContain("Timepoint: 12 months");
    expect(prompt.user).toContain("Effect measure: RR (Risk ratio)");
    expect(prompt.user).toContain("Groups: Valve vs Standard of care");
    expect(prompt.user).toContain("Model: RANDOM; k = 2 pooled studies; total participants: 287");
    expect(prompt.user).toContain("Risk ratio: 3.0044 [1.8543, 4.8698]");
    expect(prompt.user).toContain("I2 = 0%");
    expect(prompt.user).toContain(
      "- Smith 2019: n = 150; effect 2.90 [1.50, 5.40]; risk of bias: Low risk (low)",
    );
    // Null effect/judgment-label fallbacks.
    expect(prompt.user).toContain(
      "- Jones 2021: n = 137; effect not estimable; risk of bias: unassessed",
    );
    expect(prompt.user).toContain("## RISK_OF_BIAS — NOT_SERIOUS");
    expect(prompt.user).toContain("## IMPRECISION — SERIOUS (flagged for human review)");
    expect(prompt.user).toContain("Rationale: Total participants 287 below the OIS of 400.");
    expect(prompt.user).toContain('Metrics: {"totalN":287,"oisShort":true}');
  });

  it("serializes the protocol summary and every PICO without guessing an outcome link", () => {
    const prompt = buildGradePrompt({
      ...INPUT,
      picos: [
        ...INPUT.picos,
        {
          question: "KQ2",
          population: "Adults with collateral ventilation",
          outcomes: "Adverse events",
        },
      ],
    });
    expect(prompt.user).toContain("Valves for emphysema: a systematic review of RCTs.");
    expect(prompt.user).toContain(
      "PICO 1 (KQ1) — P: Adults with severe emphysema | I: Endobronchial valves | C: Standard of care | O: FEV1 response at 12 months",
    );
    expect(prompt.user).toContain(
      "PICO 2 (KQ2) — P: Adults with collateral ventilation | O: Adverse events",
    );
    expect(prompt.user).toContain("Study-level PICO characteristics are not included");
  });

  it("flags a missing protocol PICO for the indirectness rationale", () => {
    const prompt = buildGradePrompt({ ...INPUT, picos: [], protocolSummary: null });
    expect(prompt.user).toContain("No protocol PICO is recorded");
    expect(prompt.user).not.toContain("PICO 1");
  });

  it("handles single-study inputs — i2 not assessable, unknown totals", () => {
    const prompt = buildGradePrompt({
      ...INPUT,
      pooledSummary: { ...INPUT.pooledSummary, k: 1, totalN: null, i2: null },
      studies: [{ ...INPUT.studies[0]!, n: null }],
    });
    expect(prompt.user).toContain("k = 1 pooled study; total participants: unknown");
    expect(prompt.user).toContain("I2 not assessable (fewer than 2 studies)");
    expect(prompt.user).toContain("- Smith 2019: n unknown;");
  });

  it("pins the grounding rules in the system prompt", () => {
    const prompt = buildGradePrompt(INPUT);
    expect(prompt.system).toContain("Never invent, recompute, or estimate numbers");
    expect(prompt.system).toContain("exactly once");
    expect(prompt.system).toContain("NOT_SERIOUS (no downgrade)");
    expect(prompt.system).toContain("PICO");
    expect(prompt.system).toContain("Always return NOT_SERIOUS");
    expect(prompt.user).toContain("return all 5 domains exactly once");
  });

  it("attaches the GRADE json schema", () => {
    expect(buildGradePrompt(INPUT).jsonSchema).toBe(GRADE_JSON_SCHEMA);
  });

  it("has a stable version constant", () => {
    expect(GRADE_PROMPT_VERSION).toBe("grade-v2");
  });
});
