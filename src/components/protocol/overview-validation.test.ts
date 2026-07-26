import { describe, expect, it } from "vitest";
import { validateOverviewPatch } from "./overview-validation";

describe("validateOverviewPatch", () => {
  it("accepts values at the protocol schema limits", () => {
    expect(
      validateOverviewPatch({
        reviewQuestion: "q".repeat(10_000),
        databases: Array.from({ length: 200 }, (_, index) => `Database ${index}`),
      }),
    ).toBeNull();
  });

  it("identifies an overlong narrative field", () => {
    expect(validateOverviewPatch({ reviewQuestion: "q".repeat(10_001) })).toBe(
      "Review question is 10,001 characters; the maximum is 10,000.",
    );
  });

  it("identifies too many list entries and an overlong line", () => {
    expect(
      validateOverviewPatch({
        databases: Array.from({ length: 201 }, (_, index) => `Database ${index}`),
      }),
    ).toBe("Databases has 201 entries; the maximum is 200.");
    expect(validateOverviewPatch({ grayLiteratureSources: ["okay", "x".repeat(501)] })).toBe(
      "Gray literature sources line 2 is 501 characters; the maximum is 500. Keep one item per line.",
    );
  });
});
