// Writers must round-trip through OUR OWN parsers — a Synthesis export re-imports losslessly.
import { describe, expect, it } from "vitest";
import { parseRis } from "@/server/services/imports/parsers/ris";
import { parseBibtex } from "@/server/services/imports/parsers/bibtex";
import type { CslItemInput } from "../csl";
import { writeRis } from "./ris";
import { writeBibtex } from "./bibtex";

const ITEMS: CslItemInput[] = [
  {
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
    PMID: "32000001",
    URL: "https://example.org/paper",
    abstract: "Background: things. Methods: more things.",
  },
  {
    type: "article-journal",
    title: "Costs & benefits of 100% oxygen: a #1 study_with specials",
    author: [{ family: "Smith", given: "Jane A." }],
    issued: { "date-parts": [[2020]] },
    "container-title": "BMJ",
    page: "k1079",
  },
];

describe("writeRis", () => {
  it("round-trips through parseRis (title, authors, year, journal, ids, pages)", () => {
    const ris = writeRis(ITEMS);
    const { records, errors } = parseRis(ris);
    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first!.title).toBe(ITEMS[0]!.title);
    expect(first!.authors.map((a) => a.family)).toEqual(["Smith", "Jones"]);
    expect(first!.year).toBe(2020);
    expect(first!.journal).toBe(ITEMS[0]!["container-title"]);
    expect(first!.volume).toBe("201");
    expect(first!.pages).toContain("540");
    expect(first!.doi).toBe("10.1000/xyz123");
    expect(first!.pmid).toBe("32000001");
    expect(second!.title).toBe(ITEMS[1]!.title);
  });
});

describe("writeBibtex", () => {
  it("round-trips through parseBibtex and escapes special characters", () => {
    const bib = writeBibtex(ITEMS);
    expect(bib).toContain("@article{smith2020,");
    expect(bib).toContain("@article{smith2020a,"); // citekey collision suffix
    const { records, errors } = parseBibtex(bib);
    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0]!.title).toBe(ITEMS[0]!.title);
    expect(records[0]!.authors.map((a) => a.family)).toEqual(["Smith", "Jones"]);
    expect(records[0]!.year).toBe(2020);
    expect(records[0]!.doi).toBe("10.1000/xyz123");
    expect(records[1]!.title).toContain("Costs & benefits");
  });
});
