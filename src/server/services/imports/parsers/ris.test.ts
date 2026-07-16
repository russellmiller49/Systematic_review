import { describe, expect, it } from "vitest";
import { parseRis } from "./ris";
import {
  RIS_AFFILIATIONS,
  RIS_BOM_CRLF,
  RIS_EMPTY,
  RIS_MALFORMED,
  RIS_PUBMED_5,
  RIS_STRAY_CONTENT,
} from "./__fixtures__/ris";

describe("parseRis", () => {
  it("parses the 5-record PubMed export", () => {
    const { records, errors } = parseRis(RIS_PUBMED_5);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(5);
  });

  it("golden record 1: TI/AU/PY/JF/VL/IS/SP-EP/AB/DO/UR/LA", () => {
    const rec = parseRis(RIS_PUBMED_5).records[0]!;
    expect(rec.title).toBe(
      "Bronchoscopic lung volume reduction with endobronchial valves for severe emphysema: a randomized controlled trial",
    );
    expect(rec.authors).toEqual([
      { family: "Criner", given: "Gerard J.", raw: "Criner, Gerard J." },
      { family: "Sue", given: "Richard", raw: "Sue, Richard" },
      { family: "Wright", given: "Shawn", raw: "Wright, Shawn" },
    ]);
    expect(rec.year).toBe(2018); // "2018/09/15" — date suffix stripped
    expect(rec.journal).toBe("American Journal of Respiratory and Critical Care Medicine");
    expect(rec.volume).toBe("198");
    expect(rec.issue).toBe("9");
    expect(rec.pages).toBe("1151-1164"); // SP + EP combined
    expect(rec.abstract).toBe(
      "RATIONALE: Bronchoscopic lung volume reduction with endobronchial valves has been " +
        "proposed for patients with severe heterogeneous emphysema. OBJECTIVES: To evaluate " +
        "the effectiveness and safety of Zephyr valves versus standard of care.",
    );
    expect(rec.doi).toBe("10.1164/rccm.201803-0590oc"); // normalized lowercase
    expect(rec.url).toBe("https://pubmed.ncbi.nlm.nih.gov/29787288/");
    expect(rec.language).toBe("eng");
    expect(rec.rowNumber).toBe(1);
    expect(rec.rawChunk.startsWith("TY  - JOUR")).toBe(true);
    expect(rec.rawChunk).toContain("ER  -");
  });

  it("golden record 2: unicode authors, AU + A1 mix, DOI resolver prefix stripped", () => {
    const rec = parseRis(RIS_PUBMED_5).records[1]!;
    expect(rec.title).toBe(
      "Effect of Müller maneuver training on diaphragm function in COPD: the RESPIRE-2 study",
    );
    expect(rec.authors).toEqual([
      { family: "Müller", given: "Jürgen", raw: "Müller, Jürgen" },
      { family: "García-López", given: "María", raw: "García-López, María" },
    ]);
    expect(rec.year).toBe(2020);
    expect(rec.journal).toBe("Thorax"); // JO tag
    expect(rec.pages).toBe("331-339"); // SP already a range, no EP
    expect(rec.doi).toBe("10.1136/thoraxjnl-2019-213456"); // https://doi.org/ stripped
    expect(rec.rowNumber).toBe(2);
  });

  it("golden record 3: T1/A1/Y1/T2 synonym tags", () => {
    const rec = parseRis(RIS_PUBMED_5).records[2]!;
    expect(rec.title).toBe(
      "Pulmonary rehabilitation following exacerbations of chronic obstructive pulmonary disease",
    );
    expect(rec.year).toBe(2016); // Y1 "2016/12/08"
    expect(rec.journal).toBe("Cochrane Database of Systematic Reviews"); // T2
    expect(rec.issue).toBe("12");
    expect(rec.doi).toBe("10.1002/14651858.cd005305.pub4");
  });

  it("handles UTF-8 BOM and CRLF line endings", () => {
    const { records, errors } = parseRis(RIS_BOM_CRLF);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(5);
    expect(records[0]!.title).toBe(parseRis(RIS_PUBMED_5).records[0]!.title);
  });

  it("malformed input yields error rows, never throws", () => {
    const { records, errors } = parseRis(RIS_MALFORMED);
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("A valid record among malformed neighbours");
    expect(records[0]!.rowNumber).toBe(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ rowNumber: 2 });
    expect(errors[0]!.message).toMatch(/missing a title/i);
    expect(errors[0]!.rawChunk).toContain("Titleless, Terry");
    expect(errors[1]).toMatchObject({ rowNumber: 3 });
    expect(errors[1]!.message).toMatch(/unterminated/i);
    expect(errors[1]!.rawChunk).toContain("This record never terminates");
  });

  it("stray non-RIS content becomes an error row and later records still parse", () => {
    const { records, errors } = parseRis(RIS_STRAY_CONTENT);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.rowNumber).toBe(1);
    expect(errors[0]!.rawChunk).toContain("SomeTool");
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("Valid record after stray header text");
    expect(records[0]!.rowNumber).toBe(2);
  });

  it("empty file produces a single error row", () => {
    const { records, errors } = parseRis(RIS_EMPTY);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/empty/i);
  });
});

describe("parseRis affiliations + registry ids", () => {
  it("records without AD/C1 still carry empty affiliation/registry fields", () => {
    for (const rec of parseRis(RIS_PUBMED_5).records) {
      expect(rec.affiliations).toEqual([]);
      expect(rec.registryIds).toEqual([]);
    }
  });

  it("captures AD + C1 as a unique bag and registry ids from the abstract", () => {
    const { records, errors } = parseRis(RIS_AFFILIATIONS);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.affiliations).toEqual([
      "Temple University, Philadelphia, PA, USA. gerard.criner@tuhs.temple.edu",
      "University of Alabama at Birmingham, Birmingham, AL, USA",
    ]);
    expect(rec.registryIds).toEqual(["ISRCTN04761234", "NCT01796392"]);
  });
});

describe("parseRis PMID extraction", () => {
  it("maps a numeric AN accession to pmid (PubMed-sourced RIS)", () => {
    const { records, errors } = parseRis(
      "TY  - JOUR\nTI  - Some trial\nAN  - 32000001\nER  - \n",
    );
    expect(errors).toHaveLength(0);
    expect(records[0]?.pmid).toBe("32000001");
  });

  it("ignores non-numeric accession numbers (e.g. Embase)", () => {
    const { records } = parseRis("TY  - JOUR\nTI  - Some trial\nAN  - L602341885\nER  - \n");
    expect(records[0]?.pmid).toBeUndefined();
  });
});
