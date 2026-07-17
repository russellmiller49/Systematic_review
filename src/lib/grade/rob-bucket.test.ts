// Unit tests for classifyRobJudgment across every built-in tool's judgmentScale.
//
// The scales below are hardcoded COPIES of the judgmentScale JSON in
// src/server/services/rob/standard-tools.ts and src/server/services/rob/builtin.ts
// (GENERIC_JUDGMENT_SCALE) — this pure lib and its tests must not import server modules.
// If a built-in scale ever changes, update the copy here and re-verify the buckets.

import { describe, expect, it } from "vitest";

import { classifyRobJudgment } from "./rob-bucket";
import type { RobBucket } from "./types";

const GREEN = "#16a34a";
const AMBER = "#d97706";
const ORANGE = "#ea580c";
const RED = "#dc2626";
const SLATE = "#64748b";

// RoB 2 (standard-tools.ts ROB2_DEF)
const ROB2_SCALE = [
  { value: "low", label: "Low risk", color: GREEN, severity: 1 },
  { value: "some_concerns", label: "Some concerns", color: AMBER, severity: 2 },
  { value: "high", label: "High risk", color: RED, severity: 3 },
];

// ROBINS-I (standard-tools.ts ROBINS_I_DEF)
const ROBINS_I_SCALE = [
  { value: "low", label: "Low", color: GREEN, severity: 1 },
  { value: "moderate", label: "Moderate", color: AMBER, severity: 2 },
  { value: "serious", label: "Serious", color: ORANGE, severity: 3 },
  { value: "critical", label: "Critical", color: RED, severity: 4 },
  { value: "no_information", label: "No information", color: SLATE, severity: 5 },
];

// QUADAS-2 (standard-tools.ts QUADAS_2_DEF)
const QUADAS_2_SCALE = [
  { value: "low", label: "Low risk", color: GREEN, severity: 1 },
  { value: "high", label: "High risk", color: RED, severity: 2 },
  { value: "unclear", label: "Unclear", color: SLATE, severity: 3 },
];

// Newcastle-Ottawa Scale, cohort studies (standard-tools.ts NOS_COHORT_DEF)
const NOS_COHORT_SCALE = [
  { value: "good", label: "Good quality", color: GREEN, severity: 1 },
  { value: "fair", label: "Fair quality", color: AMBER, severity: 2 },
  { value: "poor", label: "Poor quality", color: RED, severity: 3 },
];

// JBI RCT checklist (standard-tools.ts JBI_RCT_DEF)
const JBI_RCT_SCALE = [
  { value: "low", label: "Low risk", color: GREEN, severity: 1 },
  { value: "some_concerns", label: "Some concerns", color: AMBER, severity: 2 },
  { value: "high", label: "High risk", color: RED, severity: 3 },
  { value: "unclear", label: "Unclear", color: SLATE, severity: 4 },
];

// AMSTAR 2 (standard-tools.ts AMSTAR_2_DEF)
const AMSTAR_2_SCALE = [
  { value: "high", label: "High confidence", color: GREEN, severity: 1 },
  { value: "moderate", label: "Moderate confidence", color: AMBER, severity: 2 },
  { value: "low", label: "Low confidence", color: ORANGE, severity: 3 },
  { value: "critically_low", label: "Critically low confidence", color: RED, severity: 4 },
];

// Generic Risk of Bias Tool (builtin.ts GENERIC_JUDGMENT_SCALE)
const GENERIC_SCALE = [
  { value: "low", label: "Low risk", color: "#16a34a", severity: 1 },
  { value: "some_concerns", label: "Some concerns", color: "#d97706", severity: 2 },
  { value: "high", label: "High risk", color: "#dc2626", severity: 3 },
  { value: "unclear", label: "Unclear", color: "#64748b", severity: 4 },
  { value: "not_applicable", label: "Not applicable", color: "#94a3b8", severity: 5 },
];

const BUILTIN_EXPECTATIONS: Array<{
  tool: string;
  scale: unknown;
  buckets: Array<[value: string, bucket: RobBucket]>;
}> = [
  {
    tool: "RoB 2",
    scale: ROB2_SCALE,
    buckets: [
      ["low", "low"],
      ["some_concerns", "moderate"],
      ["high", "high"],
    ],
  },
  {
    tool: "ROBINS-I",
    scale: ROBINS_I_SCALE,
    buckets: [
      ["low", "low"],
      ["moderate", "moderate"],
      ["serious", "high"],
      ["critical", "high"],
      ["no_information", "unclear"],
    ],
  },
  {
    tool: "QUADAS-2",
    scale: QUADAS_2_SCALE,
    buckets: [
      ["low", "low"],
      ["high", "high"],
      ["unclear", "unclear"],
    ],
  },
  {
    tool: "Newcastle-Ottawa Scale (cohort studies)",
    scale: NOS_COHORT_SCALE,
    buckets: [
      ["good", "low"],
      ["fair", "moderate"],
      ["poor", "high"],
    ],
  },
  {
    tool: "JBI Checklist for Randomized Controlled Trials",
    scale: JBI_RCT_SCALE,
    buckets: [
      ["low", "low"],
      ["some_concerns", "moderate"],
      ["high", "high"],
      ["unclear", "unclear"],
    ],
  },
  {
    tool: "AMSTAR 2",
    scale: AMSTAR_2_SCALE,
    buckets: [
      ["high", "low"], // high CONFIDENCE = the least biased entry (min severity)
      ["moderate", "moderate"],
      ["low", "high"], // low confidence is in the upper severity tertile
      ["critically_low", "high"],
    ],
  },
  {
    tool: "Generic Risk of Bias Tool",
    scale: GENERIC_SCALE,
    buckets: [
      ["low", "low"],
      ["some_concerns", "moderate"],
      ["high", "high"],
      ["unclear", "unclear"],
      ["not_applicable", "unclear"],
    ],
  },
];

describe("classifyRobJudgment on the built-in scales", () => {
  for (const { tool, scale, buckets } of BUILTIN_EXPECTATIONS) {
    it(`classifies every ${tool} judgment with certainty`, () => {
      for (const [value, bucket] of buckets) {
        expect(classifyRobJudgment(scale, value), `${tool}: ${value}`).toEqual({
          bucket,
          certain: true,
        });
      }
    });
  }

  it("falls back to a case-insensitive label match", () => {
    expect(classifyRobJudgment(ROB2_SCALE, "Some Concerns")).toEqual({
      bucket: "moderate",
      certain: true,
    });
    expect(classifyRobJudgment(QUADAS_2_SCALE, "LOW RISK")).toEqual({
      bucket: "low",
      certain: true,
    });
  });

  it("prefers an exact value match over a label match", () => {
    const scale = [
      { value: "high", label: "Elevated", severity: 2 },
      { value: "low", label: "high", severity: 1 },
    ];
    // "high" matches the first entry by value (max severity), not the second by label.
    expect(classifyRobJudgment(scale, "high")).toEqual({ bucket: "high", certain: true });
  });

  it("informational entries win even at minimum severity", () => {
    const scale = [
      { value: "unknown", label: "Unknown", severity: 1 },
      { value: "ok", label: "OK", severity: 2 },
      { value: "bad", label: "Bad", severity: 3 },
    ];
    expect(classifyRobJudgment(scale, "unknown")).toEqual({ bucket: "unclear", certain: true });
    // Min/max are ranked among NON-informational entries only.
    expect(classifyRobJudgment(scale, "ok")).toEqual({ bucket: "low", certain: true });
    expect(classifyRobJudgment(scale, "bad")).toEqual({ bucket: "high", certain: true });
  });

  it("ignores informational severity when ranking complete non-informational entries", () => {
    const scale = [
      { value: "unknown", label: "Unknown", severity: Number.POSITIVE_INFINITY },
      { value: "ok", label: "OK", severity: 1 },
      { value: "bad", label: "Bad", severity: 2 },
    ];
    expect(classifyRobJudgment(scale, "unknown")).toEqual({ bucket: "unclear", certain: true });
    expect(classifyRobJudgment(scale, "ok")).toEqual({ bucket: "low", certain: true });
    expect(classifyRobJudgment(scale, "bad")).toEqual({ bucket: "high", certain: true });
  });

  it("a scale with fewer than two ranked entries is unclear and uncertain", () => {
    expect(
      classifyRobJudgment([{ value: "only", label: "Only option", severity: 1 }], "only"),
    ).toEqual({ bucket: "unclear", certain: false });
  });

  it("uses severity rank tertiles rather than severity magnitude or judgment keywords", () => {
    const scale = [
      { value: "excellent", label: "Excellent", severity: 10 },
      { value: "good", label: "Good", severity: 20 },
      { value: "high", label: "High confidence", severity: 30 },
      { value: "poor", label: "Poor", severity: 40 },
      { value: "critical", label: "Critical", severity: 50 },
    ];
    const expectations: Array<[string, RobBucket]> = [
      ["excellent", "low"],
      ["good", "moderate"],
      ["high", "moderate"],
      ["poor", "high"],
      ["critical", "high"],
    ];
    for (const [value, bucket] of expectations) {
      expect(classifyRobJudgment(scale, value), value).toEqual({ bucket, certain: true });
    }
  });
});

describe("classifyRobJudgment with non-authoritative severities", () => {
  const CUSTOM_NO_SEVERITY_SCALE = [
    { value: "low", label: "Low risk" },
    { value: "medium", label: "Medium risk" },
    { value: "serious_issues", label: "Serious issues" },
    { value: "good", label: "Good quality" },
    { value: "poor", label: "Poor quality" },
  ];

  it("does not guess from keywords when severity is missing", () => {
    for (const { value } of CUSTOM_NO_SEVERITY_SCALE) {
      expect(classifyRobJudgment(CUSTOM_NO_SEVERITY_SCALE, value), value).toEqual({
        bucket: "unclear",
        certain: false,
      });
    }
  });

  it("a partial severity scale is unclear for every non-informational entry", () => {
    const scale = [
      { value: "low", label: "Low", severity: 1 },
      { value: "high", label: "High risk" },
    ];
    expect(classifyRobJudgment(scale, "low")).toEqual({ bucket: "unclear", certain: false });
    expect(classifyRobJudgment(scale, "high")).toEqual({ bucket: "unclear", certain: false });
  });

  it("treats non-finite and non-numeric severities as malformed", () => {
    const scale = [
      { value: "low", label: "Low", severity: "1" },
      { value: "middle", label: "Middle", severity: Number.NaN },
      { value: "high", label: "High", severity: Number.POSITIVE_INFINITY },
    ];
    for (const value of ["low", "middle", "high"]) {
      expect(classifyRobJudgment(scale, value)).toEqual({ bucket: "unclear", certain: false });
    }
  });

  it("rejects duplicate severity ranks instead of marking them certain", () => {
    const scale = [
      { value: "low", label: "Low risk", severity: 1 },
      { value: "high", label: "High risk", severity: 1 },
    ];
    expect(classifyRobJudgment(scale, "low")).toEqual({ bucket: "unclear", certain: false });
    expect(classifyRobJudgment(scale, "high")).toEqual({ bucket: "unclear", certain: false });
  });
});

describe("classifyRobJudgment malformed-scale fallbacks", () => {
  it("non-array scales are unclear and uncertain", () => {
    for (const scale of [null, undefined, {}, "junk", 42]) {
      expect(classifyRobJudgment(scale, "low")).toEqual({ bucket: "unclear", certain: false });
    }
  });

  it("unparseable entries are skipped; nothing matchable -> unclear", () => {
    expect(classifyRobJudgment([{}, 42, "x", { color: "#fff" }], "low")).toEqual({
      bucket: "unclear",
      certain: false,
    });
  });

  it("a judgment value missing from the scale is unclear and uncertain", () => {
    expect(classifyRobJudgment(ROB2_SCALE, "nonexistent")).toEqual({
      bucket: "unclear",
      certain: false,
    });
  });

  it("does not rank parseable entries from an otherwise malformed scale", () => {
    const scale = [
      null,
      "junk",
      { value: "low", label: "Low risk", severity: 1 },
      { value: "high", label: "High risk", severity: 2 },
      {},
    ];
    expect(classifyRobJudgment(scale, "low")).toEqual({ bucket: "unclear", certain: false });
  });

  it("still recognizes a matched informational entry in a malformed scale", () => {
    const scale = [null, { value: "unknown", label: "Unknown" }];
    expect(classifyRobJudgment(scale, "unknown")).toEqual({ bucket: "unclear", certain: true });
  });
});
