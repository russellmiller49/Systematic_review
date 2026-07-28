import { describe, expect, it } from "vitest";
import {
  matchingScreeningKeywords,
  normalizeScreeningKeywordTerm,
  segmentScreeningKeywordText,
  type ScreeningKeywordRule,
} from "./screening-keywords";

const rules: ScreeningKeywordRule[] = [
  { id: "include-1", term: "randomized trial", category: "INCLUDE" },
  { id: "exclude-1", term: "animal", category: "EXCLUDE" },
  { id: "include-2", term: "trial", category: "INCLUDE" },
];

describe("screening keyword helpers", () => {
  it("normalizes compatibility characters, whitespace, and case for deduplication", () => {
    expect(normalizeScreeningKeywordTerm("  ＲＣＴ \n Study  ")).toBe("rct study");
  });

  it("highlights case-insensitively and prefers the longest overlapping phrase", () => {
    const segments = segmentScreeningKeywordText(
      "A RANDOMIZED TRIAL in an animal model",
      rules,
    );
    expect(segments.filter((segment) => segment.keyword).map((segment) => segment.keyword?.id)).toEqual([
      "include-1",
      "exclude-1",
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "A RANDOMIZED TRIAL in an animal model",
    );
  });

  it("treats regex punctuation as literal text", () => {
    const punctuationRule: ScreeningKeywordRule = {
      id: "punctuation",
      term: "phase II (RCT)",
      category: "INCLUDE",
    };
    const segments = segmentScreeningKeywordText("A phase II (RCT) report", [punctuationRule]);
    expect(segments.find((segment) => segment.keyword)?.text).toBe("phase II (RCT)");
  });

  it("returns each matching rule once across title and abstract", () => {
    expect(
      matchingScreeningKeywords(
        ["Animal trial", "The animal cohort was not randomized."],
        rules,
      ).map((rule) => rule.id),
    ).toEqual(["exclude-1", "include-2"]);
  });
});
