import { describe, expect, it } from "vitest";
import type { ParsedRecord } from "@/server/services/imports/parsers/types";
import {
  citationToCsl,
  crossrefToCsl,
  denormalizeCsl,
  parsedRecordToCsl,
  pubmedSummaryToCsl,
} from "./csl";

describe("crossrefToCsl", () => {
  it("maps a Crossref work message (title array, issued, page, type)", () => {
    const csl = crossrefToCsl({
      type: "journal-article",
      title: ["A  trial of things"],
      "container-title": ["The Lancet"],
      author: [{ family: "Smith", given: "Jane" }, { name: "The BIG Group" }],
      issued: { "date-parts": [[2021, 3]] },
      volume: "397",
      issue: "10123",
      page: "100-110",
      DOI: "10.1016/S0140-6736",
      URL: "https://doi.org/10.1016/s0140-6736",
      abstract: "<jats:p>Background text</jats:p>",
    });
    expect(csl.type).toBe("article-journal");
    expect(csl.title).toBe("A trial of things");
    expect(csl["container-title"]).toBe("The Lancet");
    expect(csl.author).toEqual([
      { family: "Smith", given: "Jane" },
      { literal: "The BIG Group" },
    ]);
    expect(csl.DOI).toBe("10.1016/s0140-6736");
    expect(csl.abstract).toBe("Background text");
  });
});

describe("pubmedSummaryToCsl", () => {
  it("maps an esummary docsum ('Family FM' authors, pubdate, articleids)", () => {
    const csl = pubmedSummaryToCsl({
      uid: "32000001",
      title: "Endobronchial valves for emphysema.",
      fulljournalname: "American Journal of Respiratory and Critical Care Medicine",
      pubdate: "2018 Nov 15",
      volume: "198",
      issue: "9",
      pages: "1151-64",
      authors: [{ name: "Criner GJ" }, { name: "Sue R" }, { name: "van der Berg H" }],
      articleids: [
        { idtype: "pubmed", value: "32000001" },
        { idtype: "doi", value: "10.1164/RCCM.201803-0590OC" },
      ],
    });
    expect(csl.title).toBe("Endobronchial valves for emphysema");
    expect(csl.author).toEqual([
      { family: "Criner", given: "GJ" },
      { family: "Sue", given: "R" },
      { family: "van der Berg", given: "H" },
    ]);
    expect(csl.issued).toEqual({ "date-parts": [[2018]] });
    expect(csl.DOI).toBe("10.1164/rccm.201803-0590oc");
    expect(csl.PMID).toBe("32000001");
  });
});

describe("parsedRecordToCsl / citationToCsl", () => {
  const record: ParsedRecord = {
    title: "Imported title",
    authors: [{ family: "Adams", given: "C" }, { family: "", raw: "Consortium X" }],
    year: 2019,
    journal: "BMJ",
    volume: "361",
    pages: "k1079",
    doi: "https://doi.org/10.1136/BMJ.K1079",
    pmid: "PMID: 31000000",
    rawChunk: "",
    rowNumber: 1,
  };

  it("maps parser output with raw-only authors as literals and normalizes ids", () => {
    const csl = parsedRecordToCsl(record);
    expect(csl.author).toEqual([{ family: "Adams", given: "C" }, { literal: "Consortium X" }]);
    expect(csl.DOI).toBe("10.1136/bmj.k1079");
    expect(csl.PMID).toBe("31000000");
    expect(csl.issued).toEqual({ "date-parts": [[2019]] });
  });

  it("maps a screening Citation row", () => {
    const csl = citationToCsl({
      title: "Citation title",
      authors: [{ family: "Lee", given: "K" }],
      year: 2020,
      journal: "Chest",
      volume: "158",
      issue: "2",
      pages: "500-510",
      abstract: "Abs",
      doi: "10.1000/c1",
      pmid: "32000009",
      url: null,
    });
    expect(csl.type).toBe("article-journal");
    expect(csl["container-title"]).toBe("Chest");
    expect(csl.page).toBe("500-510");
    expect(csl.PMID).toBe("32000009");
  });
});

describe("denormalizeCsl", () => {
  it("derives searchable columns (first author, year, normalized ids)", () => {
    const denorm = denormalizeCsl({
      type: "article-journal",
      title: "T",
      author: [{ family: "Zhou", given: "L" }],
      issued: { "date-parts": [[2022, 1, 5]] },
      DOI: "DOI: 10.1/ABC",
      PMID: "  123456 ",
    });
    expect(denorm).toEqual({
      title: "T",
      firstAuthor: "Zhou",
      year: 2022,
      doi: "10.1/abc",
      pmid: "123456",
    });
  });

  it("handles literal authors and absent fields", () => {
    const denorm = denormalizeCsl({ type: "report", title: "R", author: [{ literal: "WHO" }] });
    expect(denorm.firstAuthor).toBe("WHO");
    expect(denorm.year).toBeNull();
    expect(denorm.doi).toBeNull();
    expect(denorm.pmid).toBeNull();
  });
});
