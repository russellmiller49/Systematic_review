import { describe, expect, it } from "vitest";
import { answerNote, buildSupportText, quoteLine } from "./format";

describe("quoteLine / answerNote", () => {
  it("formats quotes with and without pages", () => {
    expect(quoteLine({ text: "randomized 1:1", page: 4 })).toBe("p. 4: “randomized 1:1”");
    expect(quoteLine({ text: "randomized 1:1", page: null })).toBe("“randomized 1:1”");
    expect(answerNote("sealed envelopes", 3)).toBe("“sealed envelopes” (p. 3)");
    expect(answerNote("sealed envelopes", null)).toBe("“sealed envelopes”");
    expect(answerNote(null, 3)).toBeNull();
  });
});

describe("buildSupportText", () => {
  it("joins rationale and quote lines", () => {
    const text = buildSupportText({
      rationale: "Central randomization was used.",
      quotes: [
        { text: "computer-generated sequence", page: 3 },
        { text: "allocation concealed", page: null },
      ],
    });
    expect(text).toBe(
      "Central randomization was used.\n\np. 3: “computer-generated sequence”\n“allocation concealed”",
    );
  });

  it("handles rationale-only and quotes-only inputs", () => {
    expect(buildSupportText({ rationale: "No details reported.", quotes: [] })).toBe(
      "No details reported.",
    );
    expect(buildSupportText({ rationale: "  ", quotes: [{ text: "q", page: 1 }] })).toBe(
      "p. 1: “q”",
    );
  });

  it("trims the rationale tail to keep quotes within the 10k support cap", () => {
    const text = buildSupportText({
      rationale: "a".repeat(20_000),
      quotes: [{ text: "the decisive quote", page: 9 }],
    });
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text.endsWith("p. 9: “the decisive quote”")).toBe(true);
  });
});
