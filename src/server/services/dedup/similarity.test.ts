import { describe, expect, it } from "vitest";
import { jaroSimilarity, jaroWinkler } from "./similarity";

describe("jaroSimilarity", () => {
  it("returns 1 for identical strings (including empty)", () => {
    expect(jaroSimilarity("martha", "martha")).toBe(1);
    expect(jaroSimilarity("", "")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(jaroSimilarity("", "abc")).toBe(0);
    expect(jaroSimilarity("abc", "")).toBe(0);
  });

  it("returns 0 when there are no matching characters", () => {
    expect(jaroSimilarity("abc", "xyz")).toBe(0);
  });

  it("MARTHA vs MARHTA ≈ 0.9444 (classic transposition example)", () => {
    expect(jaroSimilarity("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 4);
  });

  it("DWAYNE vs DUANE ≈ 0.8222", () => {
    expect(jaroSimilarity("DWAYNE", "DUANE")).toBeCloseTo(0.8222, 4);
  });

  it("DIXON vs DICKSONX ≈ 0.7667", () => {
    expect(jaroSimilarity("DIXON", "DICKSONX")).toBeCloseTo(0.7667, 4);
  });

  it("is symmetric", () => {
    expect(jaroSimilarity("DIXON", "DICKSONX")).toBeCloseTo(jaroSimilarity("DICKSONX", "DIXON"), 10);
  });
});

describe("jaroWinkler", () => {
  it("MARTHA vs MARHTA ≈ 0.9611 (known published value)", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 4);
  });

  it("DWAYNE vs DUANE ≈ 0.84", () => {
    expect(jaroWinkler("DWAYNE", "DUANE")).toBeCloseTo(0.84, 4);
  });

  it("DIXON vs DICKSONX ≈ 0.8133", () => {
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.8133, 4);
  });

  it("caps the prefix boost at 4 characters", () => {
    // Same jaro, shared prefix of 6 — boost must use 4, not 6.
    const jw = jaroWinkler("abcdefgh", "abcdefxy");
    const jaro = jaroSimilarity("abcdefgh", "abcdefxy");
    expect(jw).toBeCloseTo(jaro + 4 * 0.1 * (1 - jaro), 10);
  });

  it("identical strings score 1; disjoint strings score 0", () => {
    expect(jaroWinkler("systematic review", "systematic review")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("near-identical long titles score very high, unrelated titles score low", () => {
    const t1 = "effects of azithromycin on exacerbation frequency in severe asthma";
    const t2 = "effects of azithromycin on exacerbation frequency in severe asthma a rct";
    const t3 = "prevalence of vitamin d deficiency among nursing home residents";
    expect(jaroWinkler(t1, t2)).toBeGreaterThan(0.9);
    expect(jaroWinkler(t1, t3)).toBeLessThan(0.82);
  });
});
