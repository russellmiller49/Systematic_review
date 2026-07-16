import { describe, expect, it } from "vitest";
import {
  extractionJsonSchemaFor,
  parseExtractionResult,
  parseScreeningResult,
  SCREENING_JSON_SCHEMA,
  type PromptField,
} from "./schemas";

describe("parseScreeningResult", () => {
  it("passes through a valid result, rounding the score", () => {
    const result = parseScreeningResult({
      score: 61.7,
      decision: "INCLUDE",
      rationale: "  Meets population and design criteria.  ",
    });
    expect(result).toEqual({
      score: 62,
      suggestedDecision: "INCLUDE",
      rationale: "Meets population and design criteria.",
    });
  });

  it("clamps out-of-range scores to 0–100", () => {
    expect(parseScreeningResult({ score: 150, decision: "INCLUDE", rationale: "x" }).score).toBe(100);
    expect(parseScreeningResult({ score: -5, decision: "EXCLUDE", rationale: "x" }).score).toBe(0);
  });

  it("truncates very long rationales", () => {
    const result = parseScreeningResult({
      score: 50,
      decision: "MAYBE",
      rationale: "a".repeat(5000),
    });
    expect(result.rationale).toHaveLength(2000);
  });

  it("throws on an invalid decision or missing keys", () => {
    expect(() =>
      parseScreeningResult({ score: 50, decision: "UNRESOLVED", rationale: "x" }),
    ).toThrow();
    expect(() => parseScreeningResult({ score: 50, decision: "INCLUDE" })).toThrow();
    expect(() => parseScreeningResult("not an object")).toThrow();
  });

  it("throws on a non-finite score", () => {
    expect(() =>
      parseScreeningResult({ score: Number.NaN, decision: "MAYBE", rationale: "x" }),
    ).toThrow();
  });
});

const FIELDS: PromptField[] = [
  {
    id: "f1",
    key: "sample_size",
    label: "Sample size",
    type: "NUMBER",
    required: true,
    section: null,
    helpText: null,
    options: [],
  },
  {
    id: "f2",
    key: "design",
    label: "Design",
    type: "SINGLE_SELECT",
    required: false,
    section: "Methods",
    helpText: null,
    options: [
      { value: "rct", label: "RCT" },
      { value: "cohort", label: "Cohort" },
    ],
  },
];

describe("extractionJsonSchemaFor", () => {
  it("builds a strict-mode-compatible schema keyed to the field keys", () => {
    const schema = extractionJsonSchemaFor(FIELDS) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        fields: {
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: { key: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["fields"]);
    const items = schema.properties.fields.items;
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.key.enum).toEqual(["sample_size", "design"]);
    // OpenAI strict mode requires every property listed in required.
    expect(items.required.sort()).toEqual(
      ["confidence", "found", "key", "pageNumber", "sourceQuote", "value"].sort(),
    );
  });
});

describe("SCREENING_JSON_SCHEMA", () => {
  it("is strict-mode compatible", () => {
    const schema = SCREENING_JSON_SCHEMA as { additionalProperties: boolean; required: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["decision", "rationale", "score"].sort());
  });
});

describe("parseExtractionResult", () => {
  it("normalizes values, clamps confidence, rounds page numbers", () => {
    const parsed = parseExtractionResult({
      fields: [
        {
          key: "sample_size",
          found: true,
          value: 120,
          sourceQuote: " n = 120 patients ",
          pageNumber: 3.4,
          confidence: 1.5,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        key: "sample_size",
        found: true,
        value: 120,
        sourceQuote: "n = 120 patients",
        pageNumber: 3,
        confidence: 1,
      },
    ]);
  });

  it("dedupes by key (first entry wins) and nulls values for not-found items", () => {
    const parsed = parseExtractionResult({
      fields: [
        { key: "design", found: true, value: "rct", sourceQuote: null, pageNumber: null, confidence: 0.9 },
        { key: "design", found: true, value: "cohort", sourceQuote: null, pageNumber: null, confidence: 0.1 },
        { key: "sample_size", found: false, value: 999, sourceQuote: "", pageNumber: 0, confidence: -1 },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ key: "design", value: "rct", confidence: 0.9 });
    // found:false forces value null; empty quote → null; page floor 1; confidence clamp 0.
    expect(parsed[1]).toEqual({
      key: "sample_size",
      found: false,
      value: null,
      sourceQuote: null,
      pageNumber: 1,
      confidence: 0,
    });
  });

  it("throws when the envelope is malformed", () => {
    expect(() => parseExtractionResult({ items: [] })).toThrow();
    expect(() => parseExtractionResult(null)).toThrow();
  });
});
