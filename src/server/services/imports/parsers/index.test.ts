import { describe, expect, it } from "vitest";
import { detectFormat, parse } from "./index";
import { BIBTEX_ZOTERO_4 } from "./__fixtures__/bibtex";
import { CSV_5 } from "./__fixtures__/csv";
import { NBIB_3 } from "./__fixtures__/nbib";
import { RIS_BOM_CRLF, RIS_PUBMED_5 } from "./__fixtures__/ris";

describe("detectFormat", () => {
  it("detects by file extension", () => {
    expect(detectFormat("pubmed-search.ris", "")).toBe("RIS");
    expect(detectFormat("MyLibrary.BIB", "")).toBe("BIBTEX");
    expect(detectFormat("refs.bibtex", "")).toBe("BIBTEX");
    expect(detectFormat("export.csv", "")).toBe("CSV");
    expect(detectFormat("pubmed-set.nbib", "")).toBe("NBIB");
  });

  it("sniffs content when the extension is unknown", () => {
    expect(detectFormat("export.txt", RIS_PUBMED_5)).toBe("RIS");
    expect(detectFormat("export.txt", BIBTEX_ZOTERO_4)).toBe("BIBTEX");
    expect(detectFormat("export.txt", NBIB_3)).toBe("NBIB");
    expect(detectFormat("export.txt", CSV_5)).toBe("CSV");
  });

  it("sniffs through BOM and CRLF", () => {
    expect(detectFormat("export.txt", RIS_BOM_CRLF)).toBe("RIS");
  });

  it("returns null when unsure", () => {
    expect(detectFormat("notes.txt", "just some prose without structure")).toBeNull();
    expect(detectFormat("empty.txt", "")).toBeNull();
  });
});

describe("parse dispatcher", () => {
  it("routes each format to its parser", () => {
    expect(parse("RIS", RIS_PUBMED_5).records).toHaveLength(5);
    expect(parse("BIBTEX", BIBTEX_ZOTERO_4).records).toHaveLength(4);
    expect(parse("CSV", CSV_5).records).toHaveLength(5);
    expect(parse("NBIB", NBIB_3).records).toHaveLength(3);
  });
});
