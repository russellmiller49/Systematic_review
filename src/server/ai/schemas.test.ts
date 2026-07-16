import { describe, expect, it } from "vitest";
import {
  extractionJsonSchemaFor,
  parseExtractionResult,
  parseScreeningResult,
  parseRobResult,
  robJsonSchemaFor,
  SCREENING_JSON_SCHEMA,
  type PromptField,
  type RobPromptDomain,
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

const ROB_DOMAINS: RobPromptDomain[] = [
  {
    id: "d1",
    name: "Randomization",
    guidance: null,
    questions: [
      { id: "q1", text: "1.1", guidance: null, allowedAnswers: ["Y", "PY", "PN", "N", "NI"] },
      { id: "q2", text: "1.2", guidance: null, allowedAnswers: ["Y", "N", "NA"] },
    ],
  },
  { id: "d2", name: "Missing data", guidance: null, questions: [] },
];

describe("robJsonSchemaFor", () => {
  it("pins domain ids, scale values, question ids, and the answer union", () => {
    const schema = robJsonSchemaFor(["low", "high"], ROB_DOMAINS) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        domains: {
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: {
              domainId: { enum: string[] };
              judgment: { anyOf: [{ enum: string[] }, { type: string }] };
              answers: {
                items: {
                  properties: { questionId: { enum: string[] }; answer: { enum: string[] } };
                };
              };
            };
          };
        };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["domains"]);
    const items = schema.properties.domains.items;
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.domainId.enum).toEqual(["d1", "d2"]);
    expect(items.properties.judgment.anyOf[0].enum).toEqual(["low", "high"]);
    expect(items.properties.answers.items.properties.questionId.enum).toEqual(["q1", "q2"]);
    // Union of allowed answers across the tool, not per-question oneOf branches.
    expect(items.properties.answers.items.properties.answer.enum).toEqual([
      "Y",
      "PY",
      "PN",
      "N",
      "NI",
      "NA",
    ]);
    // OpenAI strict mode requires every property listed in required.
    expect(items.required.sort()).toEqual(
      ["answers", "assessable", "confidence", "domainId", "judgment", "quotes", "rationale"].sort(),
    );
  });

  it("falls back to plain strings when a tool has no questions (empty enums are illegal)", () => {
    const schema = robJsonSchemaFor(["low"], [ROB_DOMAINS[1]!]) as {
      properties: {
        domains: {
          items: {
            properties: {
              answers: { items: { properties: { questionId: Record<string, unknown> } } };
            };
          };
        };
      };
    };
    const questionId = schema.properties.domains.items.properties.answers.items.properties.questionId;
    expect(questionId).toEqual({ type: "string" });
  });
});

describe("parseRobResult", () => {
  it("normalizes a valid domain — clamps confidence, rounds pages, trims quotes", () => {
    const parsed = parseRobResult({
      domains: [
        {
          domainId: "d1",
          assessable: true,
          judgment: " low ",
          rationale: "  Central randomization was used.  ",
          confidence: 1.4,
          quotes: [{ text: "  computer-generated sequence  ", page: 3.6 }],
          answers: [
            { questionId: "q1", answer: "Y", quote: " random sequence ", page: 0 },
            { questionId: "q1", answer: "N", quote: null, page: null },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      {
        domainId: "d1",
        assessable: true,
        judgment: "low",
        rationale: "Central randomization was used.",
        confidence: 1,
        quotes: [{ text: "computer-generated sequence", page: 4 }],
        // duplicate questionId — first entry wins
        answers: [{ questionId: "q1", answer: "Y", quote: "random sequence", page: 1 }],
      },
    ]);
  });

  it("caps quotes at three per domain and drops empty-text quotes", () => {
    const parsed = parseRobResult({
      domains: [
        {
          domainId: "d1",
          assessable: true,
          judgment: "low",
          rationale: "x",
          confidence: null,
          quotes: [
            { text: "  ", page: 1 },
            { text: "a", page: 1 },
            { text: "b", page: 2 },
            { text: "c", page: 3 },
            { text: "d", page: 4 },
          ],
          answers: [],
        },
      ],
    });
    expect(parsed[0]!.quotes.map((q) => q.text)).toEqual(["a", "b", "c"]);
  });

  it("dedupes domains (first wins) and treats blank judgments as null", () => {
    const parsed = parseRobResult({
      domains: [
        { domainId: "d2", assessable: false, judgment: "  ", rationale: null, confidence: null },
        { domainId: "d2", assessable: true, judgment: "low", rationale: "x", confidence: 0.5 },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      domainId: "d2",
      assessable: false,
      judgment: null,
      rationale: "",
      quotes: [],
      answers: [],
    });
  });

  it("truncates very long rationales and quotes", () => {
    const parsed = parseRobResult({
      domains: [
        {
          domainId: "d1",
          assessable: true,
          judgment: "low",
          rationale: "a".repeat(9000),
          confidence: null,
          quotes: [{ text: "b".repeat(3000), page: 1 }],
          answers: [{ questionId: "q1", answer: "Y", quote: "c".repeat(900), page: 1 }],
        },
      ],
    });
    expect(parsed[0]!.rationale).toHaveLength(4000);
    expect(parsed[0]!.quotes[0]!.text).toHaveLength(1500);
    expect(parsed[0]!.answers[0]!.quote).toHaveLength(500);
  });

  it("throws when the envelope is malformed", () => {
    expect(() => parseRobResult({ items: [] })).toThrow();
    expect(() => parseRobResult(null)).toThrow();
  });
});
