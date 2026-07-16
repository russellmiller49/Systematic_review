import { describe, expect, it } from "vitest";
import { extractRegistryIds } from "./registry-ids";

describe("extractRegistryIds", () => {
  it("extracts and uppercases NCT ids from free text", () => {
    expect(
      extractRegistryIds("Registered at ClinicalTrials.gov (nct01234567)."),
    ).toEqual(["NCT01234567"]);
  });

  it("extracts from NBIB SI-style values", () => {
    expect(extractRegistryIds("ClinicalTrials.gov/NCT03443154")).toEqual(["NCT03443154"]);
  });

  it("extracts ISRCTN, ACTRN, DRKS ids", () => {
    expect(
      extractRegistryIds(
        "ISRCTN12345678 and actrn12605000123456 plus DRKS00004195",
      ),
    ).toEqual(["ACTRN12605000123456", "DRKS00004195", "ISRCTN12345678"]);
  });

  it("extracts ChiCTR ids with and without the letter infix", () => {
    expect(extractRegistryIds("ChiCTR2000029381")).toEqual(["CHICTR2000029381"]);
    expect(extractRegistryIds("chictr-ior-17010892")).toEqual(["CHICTR-IOR-17010892"]);
  });

  it("normalizes EudraCT and EUCTR spellings to one canonical form", () => {
    expect(extractRegistryIds("EudraCT 2016-001234-56")).toEqual(["EUDRACT2016-001234-56"]);
    expect(extractRegistryIds("EudraCT: 2016-001234-56")).toEqual(["EUDRACT2016-001234-56"]);
    expect(extractRegistryIds("EudraCT number 2016-001234-56")).toEqual([
      "EUDRACT2016-001234-56",
    ]);
    expect(extractRegistryIds("EUCTR2016-001234-56")).toEqual(["EUDRACT2016-001234-56"]);
    // both spellings across two inputs collapse to a single id
    expect(
      extractRegistryIds("EudraCT 2016-001234-56", "EUCTR2016-001234-56"),
    ).toEqual(["EUDRACT2016-001234-56"]);
  });

  it("is anchored: ids glued to letters/digits do not match", () => {
    expect(extractRegistryIds("XNCT01234567")).toEqual([]);
    expect(extractRegistryIds("NCT012345678")).toEqual([]); // 9 digits — not an NCT id
    expect(extractRegistryIds("NCT0123456")).toEqual([]); // 7 digits
    expect(extractRegistryIds("ISRCTN123456789")).toEqual([]);
  });

  it("dedupes across inputs and sorts deterministically", () => {
    expect(
      extractRegistryIds(
        "NCT01234567 appears twice: NCT01234567",
        "and once more NCT01234567 with ISRCTN00000001",
      ),
    ).toEqual(["ISRCTN00000001", "NCT01234567"]);
  });

  it("tolerates undefined, null, and empty inputs", () => {
    expect(extractRegistryIds(undefined, null, "", "no ids here")).toEqual([]);
    expect(extractRegistryIds()).toEqual([]);
  });
});
