import { describe, expect, it } from "vitest";
import { normalizeTitle, type AuthorName } from "@/server/services/citations/normalize";
import {
  detectDuplicates,
  FUZZY_COMPOSITE_THRESHOLD,
  FUZZY_TITLE_THRESHOLD,
  type CitationLite,
} from "./engine";

const smithJones: AuthorName[] = [
  { family: "Smith", given: "J" },
  { family: "Jones", given: "A" },
];

function cite(overrides: Partial<CitationLite> & { id: string; title?: string }): CitationLite {
  const { title, ...rest } = overrides;
  return {
    normalizedTitle: title ? normalizeTitle(title) : (overrides.normalizedTitle ?? ""),
    doi: null,
    pmid: null,
    year: null,
    journal: null,
    authors: smithJones,
    ...rest,
  };
}

describe("detectDuplicates — exact pass", () => {
  it("pairs citations with the same normalized DOI (score 1, EXACT_DOI)", () => {
    const pairs = detectDuplicates([
      cite({ id: "b", title: "Trial of drug X in condition Y", doi: "https://doi.org/10.1000/ABC.123" }),
      cite({ id: "a", title: "A completely different report title", doi: "10.1000/abc.123" }),
      cite({ id: "c", title: "Unrelated third citation", doi: "10.9999/other" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ aId: "a", bId: "b", method: "EXACT_DOI", score: 1 });
    expect(pairs[0]!.reasons.matchedOn).toContain("doi");
  });

  it("pairs citations with the same PMID (prefix-insensitive)", () => {
    const pairs = detectDuplicates([
      cite({ id: "a", title: "Report one", pmid: "PMID: 12345678" }),
      cite({ id: "b", title: "Report two entirely different", pmid: "12345678" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ method: "EXACT_PMID", score: 1 });
    expect(pairs[0]!.reasons.matchedOn).toContain("pmid");
  });

  it("pairs citations with identical normalized titles", () => {
    const pairs = detectDuplicates([
      cite({ id: "a", title: "Effects of azithromycin on asthma exacerbations" }),
      cite({ id: "b", title: "Effects of azithromycin on asthma exacerbations" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ method: "NORMALIZED_TITLE", score: 1 });
  });

  it("does not pair citations on empty titles / missing identifiers", () => {
    const pairs = detectDuplicates([
      cite({ id: "a", normalizedTitle: "" }),
      cite({ id: "b", normalizedTitle: "" }),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("prefers the exact method when exact and fuzzy both fire, accumulating matchedOn", () => {
    const pairs = detectDuplicates([
      cite({ id: "a", title: "Tiotropium for COPD a randomized trial", doi: "10.1/x", pmid: "111", year: 2020 }),
      cite({ id: "b", title: "Tiotropium for COPD a randomised trial", doi: "10.1/x", pmid: "111", year: 2020 }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ method: "EXACT_DOI", score: 1 });
    expect(pairs[0]!.reasons.matchedOn).toEqual(expect.arrayContaining(["doi", "pmid"]));
    expect(pairs[0]!.reasons.titleSimilarity).toBeGreaterThan(0.9);
  });

  it("emits all pairs of a 3-citation exact group with aId < bId", () => {
    const pairs = detectDuplicates([
      cite({ id: "c", title: "T one", doi: "10.5/dup" }),
      cite({ id: "a", title: "T two", doi: "10.5/dup" }),
      cite({ id: "b", title: "T three", doi: "10.5/dup" }),
    ]);
    expect(pairs.map((p) => [p.aId, p.bId])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    for (const p of pairs) expect(p.aId < p.bId).toBe(true);
  });
});

describe("detectDuplicates — fuzzy pass", () => {
  it("true positive: same trial from two databases with punctuation/spelling differences", () => {
    const pairs = detectDuplicates([
      cite({
        id: "a",
        title: "Effects of azithromycin on exacerbation frequency in severe asthma: a randomized controlled trial",
        year: 2019,
        journal: "The Lancet Respiratory Medicine",
      }),
      cite({
        id: "b",
        title: "Effects of azithromycin on exacerbation frequency in severe asthma — a randomised controlled trial.",
        year: 2019,
        journal: "Lancet Respiratory Medicine",
      }),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0]!;
    expect(p.method).toBe("FUZZY");
    expect(p.score).toBeGreaterThanOrEqual(FUZZY_COMPOSITE_THRESHOLD);
    expect(p.reasons.titleSimilarity).toBeGreaterThanOrEqual(FUZZY_TITLE_THRESHOLD);
    expect(p.reasons.authorOverlap).toBe(1);
    expect(p.reasons.yearMatch).toBe(true);
    expect(p.reasons.matchedOn).toEqual(["fuzzy"]);
  });

  it("true negative: unrelated same-journal same-year citations do not pair", () => {
    const pairs = detectDuplicates([
      cite({
        id: "a",
        title: "Effects of azithromycin on exacerbation frequency in severe asthma",
        year: 2020,
        journal: "Journal of Testing",
        authors: [{ family: "Smith", given: "J" }],
      }),
      cite({
        id: "b",
        title: "Prevalence of vitamin D deficiency among nursing home residents in northern climates",
        year: 2020,
        journal: "Journal of Testing",
        authors: [{ family: "Nguyen", given: "T" }],
      }),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("blocking: same-year pairs are compared even when title prefixes differ", () => {
    // First 8 normalized chars differ ("the effe" vs "effects "), so only the year block
    // can bring this pair in front of the scorer.
    const pairs = detectDuplicates([
      cite({
        id: "a",
        title: "The effects of tiotropium on COPD exacerbations a randomized controlled trial",
        year: 2018,
        journal: "Chest",
      }),
      cite({
        id: "b",
        title: "Effects of tiotropium on COPD exacerbations a randomized controlled trial",
        year: 2018,
        journal: "Chest",
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.method).toBe("FUZZY");
  });

  it("year ±1 counts half; adjacent years can still pair", () => {
    const pairs = detectDuplicates([
      cite({ id: "a", title: "Remdesivir in hospitalized adults with influenza a randomized trial", year: 2020, journal: "NEJM" }),
      cite({ id: "b", title: "Remdesivir in hospitalized adults with influenza a randomised trial", year: 2021, journal: "NEJM" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.reasons.yearMatch).toBe(false);
    expect(pairs[0]!.score).toBeGreaterThanOrEqual(FUZZY_COMPOSITE_THRESHOLD);
  });

  it("does not compare pairs outside every block (years far apart, different prefixes)", () => {
    // Identical-ish titles would pass the scorer, but different prefixes + years 2 apart
    // means no block ever proposes the pair. (Identical titles would hit the exact pass,
    // so use a one-word spelling difference.)
    const pairs = detectDuplicates([
      cite({ id: "a", title: "Alpha blockers for hypertension a randomized trial", year: 2010 }),
      cite({ id: "b", title: "Beta blockers for hypertension a randomised trial", year: 2015 }),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("similar titles with NO author overlap and no other support do not pair", () => {
    // titleSimilarity is high but composite = 0.55*t + 0 + 0 + 0 < 0.75
    const pairs = detectDuplicates([
      cite({
        id: "a",
        title: "Outcomes of bronchoscopic lung volume reduction in severe emphysema",
        year: 2016,
        journal: "Journal A",
        authors: [{ family: "Miller", given: "R" }],
      }),
      cite({
        id: "b",
        title: "Outcomes of bronchoscopic lung volume reduction in severe emphysema patients",
        year: 2019,
        journal: "Journal B",
        authors: [{ family: "Nguyen", given: "T" }],
      }),
    ]);
    expect(pairs).toHaveLength(0);
  });
});
