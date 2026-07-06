import { describe, expect, it } from "vitest";
import { parseNbib } from "./nbib";
import { NBIB_3, NBIB_EMPTY, NBIB_MALFORMED } from "./__fixtures__/nbib";

describe("parseNbib", () => {
  it("parses the 3-record MEDLINE export", () => {
    const { records, errors } = parseNbib(NBIB_3);
    expect(errors).toEqual([]);
    expect(records).toHaveLength(3);
  });

  it("golden record 1: PMID/TI continuation/FAU/DP/JT/VI/IP/PG/LID [doi]/LA", () => {
    const rec = parseNbib(NBIB_3).records[0]!;
    expect(rec.pmid).toBe("29787288");
    expect(rec.title).toBe(
      "A Multicenter Randomized Controlled Trial of Zephyr Endobronchial Valve Treatment " +
        "in Heterogeneous Emphysema (LIBERATE).",
    );
    expect(rec.authors).toEqual([
      { family: "Criner", given: "Gerard J", raw: "Criner, Gerard J" },
      { family: "Sue", given: "Richard", raw: "Sue, Richard" },
    ]);
    expect(rec.year).toBe(2018); // DP "2018 Nov 1"
    expect(rec.journal).toBe("American journal of respiratory and critical care medicine"); // JT over TA
    expect(rec.volume).toBe("198");
    expect(rec.issue).toBe("9");
    expect(rec.pages).toBe("1151-1164");
    expect(rec.doi).toBe("10.1164/rccm.201803-0590oc"); // LID with [doi] marker
    expect(rec.language).toBe("eng");
    expect(rec.abstract).toBe(
      "RATIONALE: This multicenter randomized controlled trial evaluated the " +
        "effectiveness and safety of Zephyr Endobronchial Valve treatment in patients " +
        "with heterogeneous emphysema.",
    );
    expect(rec.rowNumber).toBe(1);
  });

  it("golden record 2: AID [doi] wins over [pii], multiline title joined", () => {
    const rec = parseNbib(NBIB_3).records[1]!;
    expect(rec.pmid).toBe("25066329");
    expect(rec.title).toBe(
      "Non-invasive positive pressure ventilation for the treatment of severe stable " +
        "chronic obstructive pulmonary disease: a prospective, multicentre, randomised, " +
        "controlled clinical trial.",
    );
    expect(rec.doi).toBe("10.1016/s2213-2600(14)70153-5");
    expect(rec.year).toBe(2014);
    expect(rec.volume).toBe("2");
    expect(rec.issue).toBe("9");
    expect(rec.pages).toBe("698-705");
    expect(rec.rowNumber).toBe(2);
  });

  it("falls back to AU 'Family Initials' when FAU is absent", () => {
    const rec = parseNbib(NBIB_3).records[2]!;
    expect(rec.authors).toEqual([{ family: "Nguyen", given: "THL", raw: "Nguyen THL" }]);
    expect(rec.pmid).toBe("34059074");
  });

  it("malformed chunks become error rows, never throws", () => {
    const { records, errors } = parseNbib(NBIB_MALFORMED);
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("A valid record among malformed neighbours.");
    expect(records[0]!.rowNumber).toBe(2);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ rowNumber: 1 });
    expect(errors[0]!.message).toMatch(/missing a title/i);
    expect(errors[1]).toMatchObject({ rowNumber: 3 });
    expect(errors[1]!.message).toMatch(/unrecognized/i);
  });

  it("empty file produces a single error row", () => {
    const { records, errors } = parseNbib(NBIB_EMPTY);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/empty/i);
  });
});
