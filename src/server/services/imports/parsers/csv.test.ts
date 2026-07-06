import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import {
  CSV_5,
  CSV_ALIAS_HEADERS,
  CSV_EMPTY,
  CSV_HEADER_ONLY,
  CSV_MISSING_TITLE,
} from "./__fixtures__/csv";

describe("parseCsv", () => {
  it("parses the 5-record export", () => {
    const { records, errors } = parseCsv(CSV_5);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(5);
  });

  it("golden record 1: all columns, ';'-separated authors, multiline quoted abstract", () => {
    const rec = parseCsv(CSV_5).records[0]!;
    expect(rec.title).toBe("Endobronchial valves for emphysema: 5-year outcomes");
    expect(rec.authors).toEqual([
      { family: "Criner", given: "Gerard J.", raw: "Criner, Gerard J." },
      { family: "Sue", given: "Richard", raw: "Sue, Richard" },
    ]);
    expect(rec.year).toBe(2023);
    expect(rec.journal).toBe("American Journal of Respiratory and Critical Care Medicine");
    expect(rec.volume).toBe("207");
    expect(rec.issue).toBe("3");
    expect(rec.pages).toBe("266-278");
    expect(rec.doi).toBe("10.1164/rccm.202207-1373oc");
    expect(rec.pmid).toBe("36150166");
    expect(rec.url).toBe("https://pubmed.ncbi.nlm.nih.gov/36150166/");
    expect(rec.language).toBe("eng");
    expect(rec.abstract).toBe(
      "BACKGROUND: Long-term outcomes of valve therapy remain uncertain.\n" +
        "METHODS: We followed the LIBERATE cohort for five years.",
    );
    expect(rec.rowNumber).toBe(1);
  });

  it("golden record 2: DOI resolver prefix stripped, empty pmid omitted, unicode authors", () => {
    const rec = parseCsv(CSV_5).records[1]!;
    expect(rec.title).toBe("Diaphragm ultrasound reproducibility in COPD");
    expect(rec.authors).toEqual([
      { family: "Müller", given: "Jürgen", raw: "Müller, Jürgen" },
      { family: "García-López", given: "María", raw: "García-López, María" },
    ]);
    expect(rec.doi).toBe("10.1136/thoraxjnl-2019-213456");
    expect(rec.pmid).toBeUndefined();
    expect(rec.rowNumber).toBe(2);
  });

  it("normalizes 'PMID: 123' values", () => {
    const rec = parseCsv(CSV_5).records[4]!;
    expect(rec.pmid).toBe("34059074");
    expect(rec.doi).toBeUndefined();
  });

  it("supports header aliases (TI/AU/PY/Source/DO)", () => {
    const { records, errors } = parseCsv(CSV_ALIAS_HEADERS);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.title).toBe("Alias headers still parse");
    expect(rec.authors).toHaveLength(2);
    expect(rec.year).toBe(2019);
    expect(rec.journal).toBe("Journal of Header Aliases");
    expect(rec.doi).toBe("10.1000/alias.1");
  });

  it("rows missing a title become error rows; other rows still parse", () => {
    const { records, errors } = parseCsv(CSV_MISSING_TITLE);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.rowNumber)).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rowNumber: 2 });
    expect(errors[0]!.message).toMatch(/missing a title/i);
    expect(errors[0]!.rawChunk).toContain("Titleless, Terry");
  });

  it("header-only file produces an error row", () => {
    const { records, errors } = parseCsv(CSV_HEADER_ONLY);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no data rows/i);
  });

  it("empty file produces a single error row", () => {
    const { records, errors } = parseCsv(CSV_EMPTY);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/empty/i);
  });
});
