import { describe, expect, it } from "vitest";
import { parseBibtex } from "./bibtex";
import {
  BIBTEX_EMPTY,
  BIBTEX_MALFORMED,
  BIBTEX_NO_ENTRIES,
  BIBTEX_ZOTERO_4,
} from "./__fixtures__/bibtex";

describe("parseBibtex", () => {
  it("parses the 4-record Zotero export", () => {
    const { records, errors } = parseBibtex(BIBTEX_ZOTERO_4);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(4);
  });

  it("golden record 1: braced values, nested braces, 'and'-separated authors, pmid", () => {
    const rec = parseBibtex(BIBTEX_ZOTERO_4).records[0]!;
    expect(rec.title).toBe(
      "A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valve Treatment in Heterogeneous Emphysema (LIBERATE)",
    );
    expect(rec.authors).toEqual([
      { family: "Criner", given: "Gerard J.", raw: "Criner, Gerard J." },
      { family: "Sue", given: "Richard", raw: "Sue, Richard" },
      { family: "Wright", given: "Shawn", raw: "Wright, Shawn" },
      { family: "Dransfield", given: "Mark", raw: "Dransfield, Mark" },
    ]);
    expect(rec.year).toBe(2018);
    expect(rec.journal).toBe("American Journal of Respiratory and Critical Care Medicine");
    expect(rec.volume).toBe("198");
    expect(rec.issue).toBe("9"); // "number" field
    expect(rec.pages).toBe("1151-1164"); // "--" collapsed
    expect(rec.doi).toBe("10.1164/rccm.201803-0590oc");
    expect(rec.pmid).toBe("29787288");
    // multiline abstract collapsed to a single line
    expect(rec.abstract).toBe(
      "Rationale: This multicenter randomized controlled trial evaluated the effectiveness " +
        "and safety of Zephyr Endobronchial Valve in heterogeneous emphysema.",
    );
    expect(rec.rowNumber).toBe(1);
    expect(rec.rawChunk.startsWith("@article{criner_liberate_2018")).toBe(true);
  });

  it("golden record 2: quoted values and unicode authors", () => {
    const rec = parseBibtex(BIBTEX_ZOTERO_4).records[1]!;
    expect(rec.title).toBe(
      "Diaphragm ultrasound in COPD: reproducibility of thickening fraction measurements",
    );
    expect(rec.authors).toEqual([
      { family: "Müller", given: "Jürgen", raw: "Müller, Jürgen" },
      { family: "García-López", given: "María", raw: "García-López, María" },
    ]);
    expect(rec.year).toBe(2020);
    expect(rec.journal).toBe("Thorax");
    expect(rec.volume).toBe("75");
    expect(rec.issue).toBe("4");
    expect(rec.pages).toBe("331-339");
    expect(rec.doi).toBe("10.1136/thoraxjnl-2019-213456");
    expect(rec.url).toBe("https://thorax.bmj.com/content/75/4/331");
    expect(rec.rowNumber).toBe(2);
  });

  it("@inproceedings falls back to booktitle for the journal field", () => {
    const rec = parseBibtex(BIBTEX_ZOTERO_4).records[2]!;
    expect(rec.journal).toBe("Proceedings of the 2021 Evidence Synthesis Methods Conference");
    expect(rec.authors[1]).toEqual({
      family: "O'Brien",
      given: "Siobhán",
      raw: "O'Brien, Siobhán",
    });
  });

  it("malformed entries become error rows, never throws", () => {
    const { records, errors } = parseBibtex(BIBTEX_MALFORMED);
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("A perfectly valid entry");
    expect(records[0]!.rowNumber).toBe(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ rowNumber: 2 });
    expect(errors[0]!.message).toMatch(/missing a title/i);
    expect(errors[0]!.rawChunk).toContain("no_title_2018");
    expect(errors[1]).toMatchObject({ rowNumber: 3 });
    expect(errors[1]!.message).toMatch(/unterminated/i);
    expect(errors[1]!.rawChunk).toContain("unterminated_2022");
  });

  it("a file with no entries produces an error row", () => {
    const { records, errors } = parseBibtex(BIBTEX_NO_ENTRIES);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no bibtex entries/i);
  });

  it("empty file produces a single error row", () => {
    const { records, errors } = parseBibtex(BIBTEX_EMPTY);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/empty/i);
  });
});
