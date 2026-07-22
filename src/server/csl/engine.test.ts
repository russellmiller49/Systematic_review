import { describe, expect, it } from "vitest";
import { CSL_STYLES, formatBibliographyPure, type CslItem } from "./engine";

const SMITH: CslItem = {
  id: "ref-smith",
  type: "article-journal",
  title: "Endobronchial valves for severe emphysema",
  author: [
    { family: "Smith", given: "Jane A." },
    { family: "Jones", given: "Robert" },
  ],
  issued: { "date-parts": [[2020]] },
  "container-title": "American Journal of Respiratory and Critical Care Medicine",
  volume: "201",
  issue: "5",
  page: "540-551",
  DOI: "10.1000/xyz123",
};

const ADAMS: CslItem = {
  id: "ref-adams",
  type: "article-journal",
  title: "A background methods paper",
  author: [{ family: "Adams", given: "Chris" }],
  issued: { "date-parts": [[2018]] },
  "container-title": "BMJ",
  volume: "361",
  page: "k1079",
};

describe("formatBibliographyPure", () => {
  it("formats a two-author article in every bundled style without throwing", () => {
    for (const style of CSL_STYLES) {
      const { entries } = formatBibliographyPure([SMITH], style.id);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.referenceId).toBe("ref-smith");
      expect(entry.index).toBe(1);
      expect(entry.text).toContain("Endobronchial valves");
      expect(entry.text).toContain("2020");
      expect(entry.text.toLowerCase()).toContain("smith");
      expect(entry.citeMarker.length).toBeGreaterThan(0);
    }
  });

  it("numbers numeric styles by the caller-supplied first-use order", () => {
    // ADAMS cited first even though SMITH sorts earlier alphabetically/by insertion.
    const { entries } = formatBibliographyPure([SMITH, ADAMS], "vancouver", [
      "ref-adams",
      "ref-smith",
    ]);
    expect(entries.map((e) => e.referenceId)).toEqual(["ref-adams", "ref-smith"]);
    expect(entries[0]!.index).toBe(1);
    expect(entries[0]!.citeMarker).toContain("1");
    expect(entries[1]!.citeMarker).toContain("2");
  });

  it("APA sorts alphabetically regardless of first-use order and uses author-year markers", () => {
    const { entries } = formatBibliographyPure([SMITH, ADAMS], "apa", ["ref-smith", "ref-adams"]);
    expect(entries.map((e) => e.referenceId)).toEqual(["ref-adams", "ref-smith"]);
    expect(entries[1]!.citeMarker).toMatch(/Smith/);
    expect(entries[1]!.citeMarker).toMatch(/2020/);
  });

  it("appends items missing from orderedIds and ignores unknown ordered ids", () => {
    const { entries } = formatBibliographyPure([SMITH, ADAMS], "vancouver", [
      "ref-does-not-exist",
      "ref-adams",
    ]);
    expect(entries.map((e) => e.referenceId)).toEqual(["ref-adams", "ref-smith"]);
  });

  it("degrades to plain-text entries instead of throwing on hostile items", () => {
    const hostile = { id: "bad", type: "article-journal", title: "Broken item", issued: "not-a-date-object" } as CslItem;
    const { entries } = formatBibliographyPure([hostile], "vancouver");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toContain("Broken item");
  });

  it("returns empty entries for an empty library", () => {
    expect(formatBibliographyPure([], "vancouver").entries).toEqual([]);
  });
});
